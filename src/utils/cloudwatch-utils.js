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

/**
 * Queries CloudWatch logs for bot protection errors from content scraper
 * @param {string} jobId - The scrape job ID
 * @param {object} context - Context with env and log
 * @returns {Promise<Array>} Array of bot protection events
 */
export async function queryBotProtectionLogs(jobId, context) {
  const { env, log } = context;

  const cloudwatchClient = new CloudWatchLogsClient({
    region: env.AWS_REGION || 'us-east-1',
  });

  const logGroupName = env.CONTENT_SCRAPER_LOG_GROUP || '/aws/lambda/spacecat-services--content-scraper';

  // Query logs from last 1 hour (scraper typically runs within this window)
  const startTime = Date.now() - (60 * 60 * 1000);
  const endTime = Date.now();

  try {
    log.debug(`Querying CloudWatch logs for bot protection in job ${jobId}`);

    const command = new FilterLogEventsCommand({
      logGroupName,
      startTime,
      endTime,
      // Filter pattern to find bot protection logs
      filterPattern: `{ $.jobId = "${jobId}" && $.errorCategory = "bot-protection" }`,
      limit: 100, // Max URLs per job
    });

    const response = await cloudwatchClient.send(command);

    if (!response.events || response.events.length === 0) {
      log.debug(`No bot protection logs found for job ${jobId}`);
      return [];
    }

    log.info(`Found ${response.events.length} bot protection events in CloudWatch logs`);

    // Parse log events
    const botProtectionEvents = response.events
      .map((event) => {
        try {
          // CloudWatch log message format: "BOT_PROTECTION_DETECTED { json }"
          const messageMatch = event.message.match(/BOT_PROTECTION_DETECTED\s+({.*})/);
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
 * Formats HTTP status code with emoji and description
 * @param {number|string} status - HTTP status code
 * @returns {string} Formatted status string
 */
export function formatHttpStatus(status) {
  const statusMap = {
    403: '🚫 403 Forbidden',
    401: '🔐 401 Unauthorized',
    429: '⏱️ 429 Too Many Requests',
    406: '🚷 406 Not Acceptable',
    unknown: '❓ Unknown Status',
  };
  return statusMap[String(status)] || `⚠️ ${status}`;
}

/**
 * Formats blocker type with proper casing
 * @param {string} type - Blocker type
 * @returns {string} Formatted blocker type
 */
export function formatBlockerType(type) {
  const typeMap = {
    cloudflare: 'Cloudflare',
    akamai: 'Akamai',
    imperva: 'Imperva',
    fastly: 'Fastly',
    cloudfront: 'AWS CloudFront',
    unknown: 'Unknown Blocker',
  };
  return typeMap[type] || type;
}
