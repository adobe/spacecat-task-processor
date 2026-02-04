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

  // Validate details object exists
  if (!details) {
    return null;
  }

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
      /* c8 ignore start */
      log.warn('[BOT-CHECK] No jobId provided for bot protection check');
      /* c8 ignore stop */
      return null;
    }

    /* c8 ignore start */
    log.info(`[BOT-CHECK] Querying database for jobId=${jobId}`);
    /* c8 ignore stop */
    const scrapeClient = ScrapeClient.createFrom(context);
    const job = await scrapeClient.getScrapeJobStatus(jobId);

    if (!job) {
      /* c8 ignore start */
      log.info(`[BOT-CHECK] Job not found: jobId=${jobId}`);
      /* c8 ignore stop */
      return null;
    }

    /* c8 ignore start */
    // Debug: Log what fields are returned by ScrapeClient
    const jobKeys = Object.keys(job).sort().join(', ');
    const abortInfoType = typeof job.abortInfo;
    const abortInfoValue = job.abortInfo ? JSON.stringify(job.abortInfo).substring(0, 200) : 'null';

    log.info(
      `[BOT-CHECK] Job retrieved: jobId=${jobId}, status=${job.status}, `
      + `hasAbortInfo=${!!job.abortInfo}, abortInfoType=${abortInfoType}, `
      + `abortInfoPreview=${abortInfoValue}, jobKeys=[${jobKeys}]`,
    );
    /* c8 ignore stop */

    // ScrapeClient returns a plain JSON object (via ScrapeJobDto)
    // so abortInfo is always a property, never a method
    const abortInfo = job.abortInfo || null;

    if (!abortInfo) {
      /* c8 ignore start */
      log.info(
        `[BOT-CHECK] No abortInfo in job object for jobId=${jobId}. `
        + 'This means ScrapeJobDto is not including abortInfo field. '
        + 'Check if spacecat-shared-scrape-client library needs to be updated.',
      );
      /* c8 ignore stop */
      return null;
    }

    if (abortInfo.reason !== 'bot-protection') {
      /* c8 ignore start */
      log.info(
        '[BOT-CHECK] AbortInfo present but reason is not bot-protection: '
        + `jobId=${jobId}, reason=${abortInfo.reason}`,
      );
      /* c8 ignore stop */
      return null;
    }

    // isJobComplete determines if data is partial or complete
    // - If job.status === 'COMPLETE': data is complete (isPartial = false)
    // - If job.status === 'RUNNING': data is partial (isPartial = true)
    const isJobComplete = job.status === 'COMPLETE';
    const stats = convertAbortInfoToStats(abortInfo, isJobComplete);

    // Validate stats was created successfully
    if (!stats) {
      /* c8 ignore start */
      log.error(
        `[BOT-CHECK] Failed to convert abortInfo to stats: jobId=${jobId}, `
        + `hasDetails=${!!abortInfo.details}`,
      );
      /* c8 ignore stop */
      return null;
    }

    /* c8 ignore start */
    log.info(
      `Bot protection detected from database: jobId=${job.id || jobId}, `
      + `status=${job.status}, blockedUrls=${stats.totalCount}, `
      + `isPartial=${stats.isPartial}`,
    );
    /* c8 ignore stop */

    return stats;
  } catch (error) {
    /* c8 ignore start */
    log.error(
      `Failed to get bot protection from database: jobId=${jobId}, error=${error.message}`,
      error,
    );
    /* c8 ignore stop */
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

  /* c8 ignore start */
  // Log entry point with jobId
  log.info(
    `[BOT-CHECK] Starting bot protection check: jobId=${jobId}, siteUrl=${siteUrl}`,
  );
  /* c8 ignore stop */

  // Query database for bot protection info using jobId (much more efficient)
  const botProtectionStats = await getBotProtectionFromDatabase(jobId, context);

  if (!botProtectionStats) {
    /* c8 ignore start */
    log.info(`[BOT-CHECK] No bot protection found: jobId=${jobId}`);
    /* c8 ignore stop */
    return null;
  }

  /* c8 ignore start */
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
  /* c8 ignore stop */

  // Send Slack alert - wrap in try-catch to prevent alert failures from breaking flow
  try {
    // Import dynamically to avoid circular dependency
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

    /* c8 ignore start */
    log.info(`[BOT-CHECK] Slack alert sent successfully: jobId=${jobId}`);
    /* c8 ignore stop */
  } catch (slackError) {
    /* c8 ignore start */
    // Log error but don't fail - bot protection was still detected
    log.error(
      `[BOT-CHECK] Failed to send Slack alert: jobId=${jobId}, error=${slackError.message}`,
      slackError,
    );
    /* c8 ignore stop */
  }

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
