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

// Bot detection functions have been moved to bot-detection.js
// Re-export for backward compatibility
export {
  convertAbortInfoToStats,
  checkAndAlertBotProtection,
} from './bot-detection.js';

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
