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
 * Queries CloudWatch logs for bot protection errors from content scraper
 * @param {string} siteId - The site ID for filtering
 * @param {object} context - Context with env and log
 * @param {number} onboardStartTime - Onboard start timestamp (ms) to limit search window
 * @returns {Promise<Array>} Array of bot protection events
 */
export async function queryBotProtectionLogs(siteId, context, onboardStartTime) {
  const { env, log } = context;

  const cloudwatchClient = createCloudWatchClient(env);
  const logGroupName = env.CONTENT_SCRAPER_LOG_GROUP || CONTENT_SCRAPER_LOG_GROUP;

  // Query logs from 5 minutes before onboard start time to now
  // Buffer handles clock skew and CloudWatch log ingestion delays
  const BUFFER_MS = 5 * 60 * 1000; // 5 minutes
  const startTime = onboardStartTime - BUFFER_MS;
  const endTime = Date.now();

  try {
    const command = new FilterLogEventsCommand({
      logGroupName,
      startTime,
      endTime,
      // Filter pattern to find bot protection logs for this site in the time window
      // Using text pattern since logs have prefix:
      // [BOT-BLOCKED] Bot Protection Detection in Scraper: {...}
      filterPattern: `"[BOT-BLOCKED]" "${siteId}"`,
      limit: 100, // Max URLs per job
    });

    const response = await cloudwatchClient.send(command);

    if (!response.events || response.events.length === 0) {
      log.debug(`No bot protection logs found for site ${siteId} in time window`);
      return [];
    }

    log.info(`Found ${response.events.length} bot protection events in CloudWatch logs for site ${siteId}`);

    // Parse log events
    const botProtectionEvents = response.events
      .map((event) => {
        try {
          // CloudWatch log message format: "Bot Protection Detection in Scraper: { json }"
          const messageMatch = event.message.match(/Bot Protection Detection in Scraper:\s+({.*})/);
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
 * Checks for bot protection and sends Slack alert if detected
 * This is a convenience function that combines CloudWatch querying, stats aggregation,
 * and Slack alerting in one call to simplify handler logic.
 *
 * @param {Object} params - Parameters object
 * @param {string} params.siteId - The site ID
 * @param {string} params.siteUrl - The site URL
 * @param {number} params.searchStartTime - Search start timestamp (ms)
 * @param {Object} params.slackContext - Slack context for sending messages
 * @param {Object} params.context - Application context with env, log
 * @returns {Promise<Object|null>} Bot protection stats if detected, null otherwise
 */
export async function checkAndAlertBotProtection({
  siteId,
  siteUrl,
  searchStartTime,
  slackContext,
  context,
}) {
  const { log, env } = context;

  // Query CloudWatch logs using siteId and time range
  const logEvents = await queryBotProtectionLogs(siteId, context, searchStartTime);

  if (logEvents.length === 0) {
    return null;
  }

  // Aggregate statistics
  const botProtectionStats = aggregateBotProtectionStats(logEvents);
  log.warn(
    `[BOT-BLOCKED] Bot protection detected: ${botProtectionStats.totalCount} URLs blocked `
    + `(from CloudWatch logs) for site ${siteUrl} (${siteId})`,
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
 * Checks if an audit was executed by searching Audit Worker logs
 * @param {string} auditType - The audit type to search for
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} context - The context object with env and log
 * @returns {Promise<boolean>} Whether the audit was executed
 */
export async function checkAuditExecution(auditType, siteId, onboardStartTime, context) {
  const { log, env } = context;
  const logGroupName = env.AUDIT_WORKER_LOG_GROUP || AUDIT_WORKER_LOG_GROUP;

  try {
    const cloudWatchClient = createCloudWatchClient(env);
    const filterPattern = `"Received ${auditType} audit request for: ${siteId}"`;

    // Add small buffer before onboardStartTime to account for clock skew and processing delays
    // The audit log should be after onboardStartTime, but we add a small buffer for safety
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    const searchStartTime = onboardStartTime
      ? onboardStartTime - bufferMs
      : Date.now() - 30 * 60 * 1000; // 30 minutes ago

    const command = new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      startTime: searchStartTime,
      endTime: Date.now(),
    });

    const response = await cloudWatchClient.send(command);
    const found = response.events && response.events.length > 0;

    return found;
  } catch (error) {
    log.error(`Error checking audit execution for ${auditType}:`, error);
    return false;
  }
}

/**
 * Gets the failure reason for an audit by searching Audit Worker logs
 * @param {string} auditType - The audit type to search for
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} context - The context object with env and log
 * @returns {Promise<string|null>} The failure reason or null if not found
 */
export async function getAuditFailureReason(auditType, siteId, onboardStartTime, context) {
  const { log, env } = context;
  const logGroupName = env.AUDIT_WORKER_LOG_GROUP || AUDIT_WORKER_LOG_GROUP;

  try {
    const cloudWatchClient = createCloudWatchClient(env);
    const filterPattern = `"${auditType} audit for ${siteId} failed"`;

    // Add small buffer before onboardStartTime to account for clock skew and processing delays
    const bufferMs = 30 * 1000; // 30 seconds
    const searchStartTime = onboardStartTime
      ? onboardStartTime - bufferMs
      : Date.now() - 30 * 60 * 1000; // 30 minutes ago

    const command = new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      startTime: searchStartTime,
      endTime: Date.now(),
    });

    const response = await cloudWatchClient.send(command);

    if (response.events && response.events.length > 0) {
      // Extract reason from the message
      const { message } = response.events[0];
      const reasonMatch = message.match(/Reason:\s*([^]+?)(?:\s+at\s|$)/);
      if (reasonMatch && reasonMatch[1]) {
        return reasonMatch[1].trim();
      }
      // Fallback: return entire message if "Reason:" pattern not found
      return message.trim();
    }

    return null;
  } catch (error) {
    log.error(`Error getting audit failure reason for ${auditType}:`, error);
    return null;
  }
}
