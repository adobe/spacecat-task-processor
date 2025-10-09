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
import { ok } from '@adobe/spacecat-shared-http-utils';
import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'audit-troubleshooting-processor';

/**
 * Generate specific recommendations based on failure type and root cause
 */
function generateFailureRecommendations(rootCause) {
  const recommendations = [];

  switch (rootCause) {
    case 'ad_blocker':
      recommendations.push('Site appears to be blocking automated requests');
      recommendations.push('Check if site has anti-bot measures or requires custom headers');
      break;
    case 'timeout':
      recommendations.push('Requests are timing out - site may be slow or overloaded');
      recommendations.push('Consider increasing timeout settings or retry logic');
      break;
    case 'forbidden':
      recommendations.push('Site returning 403 Forbidden - may be blocking bots');
      recommendations.push('Check robots.txt, review site access policies');
      break;
    case 'cloudflare':
      recommendations.push('Cloudflare protection is blocking requests');
      recommendations.push('May need to whitelist IPs or use different scraping approach');
      break;
    case 'rate_limit':
      recommendations.push('API rate limits exceeded');
      recommendations.push('Implement backoff strategy or reduce request frequency');
      break;
    case 'auth_error':
      recommendations.push('Authentication/authorization issues');
      recommendations.push('Check API credentials and permissions');
      break;
    case 'no_data':
      recommendations.push('No data available from source');
      recommendations.push('Verify data source configuration and data availability');
      break;
    case 'connection_refused':
      recommendations.push('Connection refused by target server');
      recommendations.push('Check if service is down or network issues');
      break;
    default:
      recommendations.push('Unknown error pattern - manual investigation needed');
  }

  return recommendations;
}

/**
 * Search CloudWatch logs for specific failure patterns
 */
async function searchFailurePatterns(siteId, context) {
  const cloudWatchClient = new CloudWatchLogsClient({
    region: context.env.AWS_REGION || 'us-east-1',
  });

  const failurePatterns = [
    {
      name: 'Audit Failures',
      logGroup: '/aws/lambda/spacecat-services--audit-worker',
      pattern: `"audit failed for site ${siteId}" OR "${siteId} audit failed"`,
    },
    {
      name: 'Import Failures',
      logGroup: '/aws/lambda/spacecat-services--import-worker',
      pattern: `"Import failed" OR "importing.*failed" OR "Error importing" OR "siteId.*${siteId}.*failed"`,
    },
    {
      name: 'Scraping Failures',
      logGroup: '/aws/lambda/spacecat-services--content-scraper',
      pattern: '"Error scraping URL" OR "scraping failed" OR "net::ERR_BLOCKED_BY_CLIENT" OR "403" OR "timeout"',
    },
  ];

  const failures = [];

  const searchPromises = failurePatterns.map(async (pattern) => {
    try {
      const command = new FilterLogEventsCommand({
        logGroupName: pattern.logGroup,
        filterPattern: pattern.pattern,
        startTime: Date.now() - (7 * 24 * 60 * 60 * 1000), // Last 7 days
        limit: 30,
      });

      const response = await cloudWatchClient.send(command);

      if (response.events && response.events.length > 0) {
        return {
          type: pattern.name,
          logGroup: pattern.logGroup,
          events: response.events.map((event) => ({
            message: event.message,
            timestamp: new Date(event.timestamp).toISOString(),
            logStreamName: event.logStreamName,
          })),
        };
      }
      return null;
    } catch (error) {
      context.log.warn(`Failed to search ${pattern.name} logs: ${error.message}`);
      return null;
    }
  });

  const results = await Promise.all(searchPromises);
  failures.push(...results.filter(Boolean));

  return failures;
}

/**
 * Analyze failure patterns to identify root causes
 */
function analyzeFailureRootCauses(failures) {
  const rootCauses = [];

  failures.forEach((failureGroup) => {
    const errorTypes = {};
    const recentErrors = [];

    failureGroup.events.forEach((event) => {
      const message = event.message.toLowerCase();

      // Categorize error types
      if (message.includes('net::err_blocked_by_client')) {
        errorTypes.ad_blocker = (errorTypes.ad_blocker || 0) + 1;
      } else if (message.includes('timeout')) {
        errorTypes.timeout = (errorTypes.timeout || 0) + 1;
      } else if (message.includes('403') || message.includes('forbidden')) {
        errorTypes.forbidden = (errorTypes.forbidden || 0) + 1;
      } else if (message.includes('cloudflare')) {
        errorTypes.cloudflare = (errorTypes.cloudflare || 0) + 1;
      } else if (message.includes('rate limit')) {
        errorTypes.rate_limit = (errorTypes.rate_limit || 0) + 1;
      } else if (message.includes('unauthorized') || message.includes('401')) {
        errorTypes.auth_error = (errorTypes.auth_error || 0) + 1;
      } else if (message.includes('no data') || message.includes('empty')) {
        errorTypes.no_data = (errorTypes.no_data || 0) + 1;
      } else if (message.includes('connection') && message.includes('refused')) {
        errorTypes.connection_refused = (errorTypes.connection_refused || 0) + 1;
      }

      recentErrors.push({
        message: event.message,
        timestamp: event.timestamp,
      });
    });

    // Sort by timestamp to get most recent first
    recentErrors.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Determine primary root cause
    const primaryCause = Object.entries(errorTypes).reduce((a, b) => (a[1] > b[1] ? a : b), ['unknown', 0]);

    rootCauses.push({
      failureType: failureGroup.type,
      logGroup: failureGroup.logGroup,
      totalErrors: failureGroup.events.length,
      errorTypes,
      primaryCause: primaryCause[0],
      primaryCauseCount: primaryCause[1],
      mostRecentError: recentErrors[0],
      recommendations: generateFailureRecommendations(primaryCause[0]),
    });
  });

  return rootCauses;
}

/**
 * Main audit troubleshooting processor - focused purely on failure analysis
 */
export async function runAuditTroubleshootingProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Site } = dataAccess;
  const {
    siteId, organizationId, taskContext,
  } = message;
  const { slackContext } = taskContext || {};

  log.info('Processing audit failure analysis for site:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
  });

  try {
    // Get the site
    const site = await Site.findById(siteId);
    if (!site) {
      log.error(`Site not found for siteId: ${siteId}`);
      await say(env, log, slackContext, `:x: Site not found for siteId: ${siteId}`);
      return ok({ message: 'Site not found' });
    }

    // Search for failure patterns in CloudWatch
    log.info('Searching CloudWatch logs for failure patterns...');
    const failures = await searchFailurePatterns(siteId, context);

    // Analyze root causes
    log.info('Analyzing failure root causes...');
    const rootCauses = analyzeFailureRootCauses(failures);

    // Send failure analysis to Slack
    if (slackContext) {
      const siteUrl = site.getBaseURL();

      // Main header
      await say(env, log, slackContext, `:mag: *Failure Analysis Report for ${siteUrl}*`);

      // Summary
      if (failures.length === 0) {
        await say(env, log, slackContext, ':tada: *No failures detected in the last 7 days*');
        await say(env, log, slackContext, 'All systems appear to be functioning normally');
      } else {
        await say(env, log, slackContext, `:warning: *Found ${failures.length} failure types in CloudWatch logs*`);
      }

      // CloudWatch failure analysis
      if (rootCauses.length > 0) {
        await say(env, log, slackContext, '*Failure Analysis:*');

        const slackMessages = [];
        for (const cause of rootCauses) {
          slackMessages.push(`*${cause.failureType}:* ${cause.totalErrors} errors found`);
          slackMessages.push(`Primary cause: ${cause.primaryCause} (${cause.primaryCauseCount} occurrences)`);

          if (cause.mostRecentError) {
            const timestamp = new Date(cause.mostRecentError.timestamp).toLocaleString();
            slackMessages.push(`Most recent: ${timestamp}`);
            slackMessages.push(`\`${cause.mostRecentError.message.substring(0, 120)}...\``);
          }

          slackMessages.push('*Recommendations:*');
          for (const rec of cause.recommendations) {
            slackMessages.push(`• ${rec}`);
          }
          slackMessages.push('');
        }

        // Send all messages in parallel
        await Promise.all(slackMessages.map((msg) => say(env, log, slackContext, msg)));
      }

      // Overall recommendations
      if (failures.length > 0) {
        await say(env, log, slackContext, '*Next Steps:*');
        await say(env, log, slackContext, '1. Review the specific error patterns above');
        await say(env, log, slackContext, '2. Check CloudWatch logs for more details');
        await say(env, log, slackContext, '3. Consider implementing retry logic or alternative approaches');
      }
    }

    log.info(`Audit failure analysis completed for site ${siteId}`);

    return ok({
      message: 'Audit failure analysis completed',
      failureTypes: failures.length,
      rootCauses: rootCauses.length,
      details: {
        failures,
        rootCauses,
      },
    });
  } catch (error) {
    log.error('Error in audit failure analysis:', error);
    await say(env, log, slackContext, `:x: Error analyzing failures for site ${siteId}: ${error.message}`);
    return ok({
      message: 'Audit failure analysis completed with errors',
      error: error.message,
    });
  }
}

export default runAuditTroubleshootingProcessor;
