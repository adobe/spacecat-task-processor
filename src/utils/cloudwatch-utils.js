/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';

const AUDIT_WORKER_LOG_GROUP = '/aws/lambda/spacecat-services--audit-worker';
const CONTENT_SCRAPER_LOG_GROUP = '/aws/lambda/spacecat-services--content-scraper';

/**
 * Creates a CloudWatch Logs client
 * @param {object} env - Environment variables
 * @returns {CloudWatchLogsClient} Configured CloudWatch client
 */
function createCloudWatchClient(env) {
  return new CloudWatchLogsClient({
    region: env.AWS_REGION || 'us-east-1',
  });
}

/**
 * Calculates the search window start time with buffer
 * @param {number} onboardStartTime - The onboarding start timestamp (ms)
 * @param {number} bufferMs - Buffer time in milliseconds (default: 5 minutes)
 * @returns {number} The search start time in milliseconds
 */
function calculateSearchWindow(onboardStartTime, bufferMs = 5 * 60 * 1000) {
  return onboardStartTime
    ? onboardStartTime - bufferMs
    : Date.now() - 30 * 60 * 1000; // 30 minutes ago as fallback
}

/**
 * Queries CloudWatch logs for bot protection errors from content scraper
 * @param {object} context - Context with env and log
 * @param {number} onboardStartTime - Onboard start timestamp (ms) to limit search window
 * @returns {Promise<Array>} Array of bot protection events
 */
export async function queryBotProtectionLogs(context, onboardStartTime) {
  const { env, log } = context;

  const cloudwatchClient = createCloudWatchClient(env);
  const logGroupName = env.CONTENT_SCRAPER_LOG_GROUP || CONTENT_SCRAPER_LOG_GROUP;

  // Query logs from 5 minutes before onboard start time to now
  // Buffer handles clock skew and CloudWatch log ingestion delays
  const BUFFER_MS = 5 * 60 * 1000; // 5 minutes
  const startTime = onboardStartTime - BUFFER_MS;
  const endTime = Date.now();

  try {
    // Filter by [BOT-BLOCKED] pattern
    const filterPattern = '"[BOT-BLOCKED]"';

    const command = new FilterLogEventsCommand({
      logGroupName,
      startTime,
      endTime,
      // Filter pattern to find bot protection logs for this site in the time window
      // Using text pattern since logs have prefix:
      // [BOT-BLOCKED] Bot Protection Detection in Scraper: {...}
      filterPattern,
      limit: 100, // Max URLs per job
    });

    const response = await cloudwatchClient.send(command);

    if (!response.events || response.events.length === 0) {
      log.debug('No bot protection logs found in time window');
      return [];
    }

    log.info(`Found ${response.events.length} bot protection events in CloudWatch logs`);

    // Parse log events
    const botProtectionEvents = response.events
      .map((event) => {
        try {
          // Checking if the logs have bot protection detection in scraper
          const messageMatch = event.message.match(/\[BOT-BLOCKED\]\s+Bot Protection Detection in Scraper:\s*({.*})/);
          if (messageMatch) {
            return JSON.parse(messageMatch[1]);
          }
          return null;
        } catch (parseError) {
          log.warn(`Failed to parse bot protection log event: ${event.message}`);
          return null;
        }
      })
      .filter((event) => event !== null);

    return botProtectionEvents;
  } catch (error) {
    log.error('Failed to query CloudWatch logs for bot protection:', error);
    // Don't fail the entire task processor run
    return [];
  }
}

/**
 * Aggregates bot protection events by HTTP status code and blocker type
 * @param {Array} events - Array of bot protection events from logs
 * @returns {object} Aggregated statistics
 */
export function aggregateBotProtectionStats(events) {
  const stats = {
    totalCount: events.length,
    byHttpStatus: {},
    byBlockerType: {},
    urls: [],
    highConfidenceCount: 0, // confidence >= 0.95
  };

  for (const event of events) {
    // Count by HTTP status
    const status = event.httpStatus || 'unknown';
    stats.byHttpStatus[status] = (stats.byHttpStatus[status] || 0) + 1;

    // Count by blocker type
    const blockerType = event.blockerType || 'unknown';
    stats.byBlockerType[blockerType] = (stats.byBlockerType[blockerType] || 0) + 1;

    // Track high confidence detections
    if (event.confidence >= 0.95) {
      stats.highConfidenceCount += 1;
    }

    // Collect URLs (with details)
    stats.urls.push({
      url: event.url,
      httpStatus: event.httpStatus,
      blockerType: event.blockerType,
      confidence: event.confidence,
    });
  }

  return stats;
}

/**
 * Converts abortInfo from database to bot protection stats format
 * @param {object} abortInfo - Abort info from ScrapeJob database
 * @param {boolean} isJobComplete - Whether the scrape job is complete
 * @returns {object} Bot protection statistics with isPartial flag
 */
export function convertAbortInfoToStats(abortInfo, isJobComplete) {
  if (!abortInfo || abortInfo.reason !== 'bot-protection') {
    return null;
  }

  const { details } = abortInfo;
  const blockedUrls = details.blockedUrls || [];
  const highConfidenceUrls = blockedUrls.filter((url) => (url.confidence || 0) >= 0.95);

  const stats = {
    totalCount: details.blockedUrlsCount || 0,
    byHttpStatus: details.byHttpStatus || {},
    byBlockerType: details.byBlockerType || {},
    urls: blockedUrls,
    highConfidenceCount: highConfidenceUrls.length,
    isPartial: !isJobComplete, // Flag indicating if scraping is still in progress
    totalUrlsInJob: details.totalUrlsCount || 0,
  };

  return stats;
}

/**
 * Gets bot protection information from database by querying specific ScrapeJob
 * @param {string} jobId - The scrape job ID (more efficient than filtering by time)
 * @param {object} context - Application context
 * @returns {Promise<object|null>} Bot protection stats if detected, null otherwise
 */
export async function getBotProtectionFromDatabase(jobId, context) {
  const { log } = context;

  try {
    if (!jobId) {
      log.debug('No jobId provided for bot protection check');
      return null;
    }

    const scrapeClient = ScrapeClient.createFrom(context);

    // Query the specific job directly (much more efficient than getScrapeJobsByBaseURL + filter)
    const job = await scrapeClient.getScrapeJobStatus(jobId);

    if (!job) {
      log.debug(`Scrape job not found: ${jobId}`);
      return null;
    }

    const abortInfo = job.abortInfo || null;

    if (!abortInfo || abortInfo.reason !== 'bot-protection') {
      return null;
    }

    // isJobComplete determines if data is partial or complete
    // - If job.status === 'COMPLETE': data is complete (isPartial = false)
    // - If job.status === 'RUNNING': data is partial (isPartial = true)
    const isJobComplete = job.status === 'COMPLETE';
    const stats = convertAbortInfoToStats(abortInfo, isJobComplete);

    log.info(
      `Bot protection detected from database: jobId=${job.id}, `
      + `status=${job.status}, blockedUrls=${stats.totalCount}, `
      + `isPartial=${stats.isPartial}`,
    );

    return stats;
  } catch (error) {
    log.error('Failed to get bot protection from database:', error);
    return null;
  }
}

/**
 * Checks for bot protection and sends Slack alert if detected
 * Queries the ScrapeJob database for abort information instead of CloudWatch logs.
 *
 * @param {Object} params - Parameters object
 * @param {string} params.jobId - The scrape job ID (from isScrapingAvailable)
 * @param {string} params.siteUrl - The site URL (for Slack message)
 * @param {Object} params.slackContext - Slack context for sending messages
 * @param {Object} params.context - Application context with env, log
 * @returns {Promise<Object|null>} Bot protection stats if detected, null otherwise
 */
export async function checkAndAlertBotProtection({
  jobId,
  siteUrl,
  slackContext,
  context,
}) {
  const { log, env } = context;

  // Log the bot protection check
  log.info(
    `[BOT-PROTECTION-CHECK] Checking bot protection for jobId=${jobId}, `
    + `siteUrl=${siteUrl}`,
  );

  // Query database for bot protection info using jobId (much more efficient)
  const botProtectionStats = await getBotProtectionFromDatabase(jobId, context);

  if (!botProtectionStats) {
    log.info(
      `[BOT-PROTECTION-CHECK] No bot protection detected for jobId=${jobId}, `
      + `siteUrl=${siteUrl}`,
    );
    return null;
  }

  // Log detailed bot protection detection
  log.warn(
    `[BOT-BLOCKED] Bot protection detected: jobId=${jobId}, `
    + `siteUrl=${siteUrl}, `
    + `blockedUrls=${botProtectionStats.totalCount}, `
    + `totalUrlsInJob=${botProtectionStats.totalUrlsInJob}, `
    + `isPartial=${botProtectionStats.isPartial} (${botProtectionStats.isPartial ? 'RUNNING' : 'COMPLETE'}), `
    + `blockerTypes=${JSON.stringify(botProtectionStats.byBlockerType)}, `
    + `httpStatuses=${JSON.stringify(botProtectionStats.byHttpStatus)}, `
    + `highConfidence=${botProtectionStats.highConfidenceCount}`,
  );

  // Send Slack alert - import dynamically to avoid circular dependency
  const { formatAllowlistMessage } = await import('@adobe/spacecat-shared-utils');
  const { say, formatBotProtectionSlackMessage } = await import('./slack-utils.js');

  const botIps = env.SPACECAT_BOT_IPS || '';
  const allowlistInfo = formatAllowlistMessage(botIps);

  await say(
    env,
    log,
    slackContext,
    formatBotProtectionSlackMessage({
      siteUrl,
      stats: botProtectionStats,
      allowlistIps: allowlistInfo.ips,
      allowlistUserAgent: allowlistInfo.userAgent,
    }),
  );

  return botProtectionStats;
}

/**
 * Gets the execution status and failure reason for an audit by searching Audit Worker logs.
 * This replaces the separate checkAuditExecution and getAuditFailureReason functions,
 * reducing redundant CloudWatch API calls.
 *
 * @param {string} auditType - The audit type to search for
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} context - The context object with env and log
 * @returns {Promise<Object>} Object with { executed: boolean, failureReason: string|null }
 */
export async function getAuditStatus(auditType, siteId, onboardStartTime, context) {
  const { log, env } = context;
  const logGroupName = env.AUDIT_WORKER_LOG_GROUP || AUDIT_WORKER_LOG_GROUP;
  const cloudWatchClient = createCloudWatchClient(env);

  try {
    // Check if audit was executed
    const executionFilterPattern = `"Received ${auditType} audit request for: ${siteId}"`;
    const searchStartTime = calculateSearchWindow(onboardStartTime, 5 * 60 * 1000); // 5 min buffer

    const executionCommand = new FilterLogEventsCommand({
      logGroupName,
      filterPattern: executionFilterPattern,
      startTime: searchStartTime,
      endTime: Date.now(),
    });

    const executionResponse = await cloudWatchClient.send(executionCommand);
    const executed = executionResponse.events && executionResponse.events.length > 0;

    if (!executed) {
      return { executed: false, failureReason: null };
    }

    // Audit was executed, check for failure
    const failureFilterPattern = `"${auditType} audit for ${siteId} failed"`;
    const failureStartTime = calculateSearchWindow(onboardStartTime, 30 * 1000); // 30 sec buffer

    const failureCommand = new FilterLogEventsCommand({
      logGroupName,
      filterPattern: failureFilterPattern,
      startTime: failureStartTime,
      endTime: Date.now(),
    });

    const failureResponse = await cloudWatchClient.send(failureCommand);

    if (failureResponse.events && failureResponse.events.length > 0) {
      // Extract reason from the message
      const { message } = failureResponse.events[0];
      const reasonMatch = message.match(/Reason:\s*([^]+?)(?:\s+at\s|$)/);
      const failureReason = reasonMatch && reasonMatch[1]
        ? reasonMatch[1].trim()
        : message.trim();

      return { executed: true, failureReason };
    }

    return { executed: true, failureReason: null };
  } catch (error) {
    log.error(`Error getting audit status for ${auditType}:`, error);
    return { executed: false, failureReason: null };
  }
}
