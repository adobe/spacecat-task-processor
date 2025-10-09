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

import { ok } from '@adobe/spacecat-shared-http-utils';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import GoogleClient from '@adobe/spacecat-shared-google-client';
import { resolveCanonicalUrl } from '@adobe/spacecat-shared-utils';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'opportunity-status-processor';

/**
 * Checks if RUM is available for a domain by attempting to get a domainkey
 * @param {string} domain - The domain to check
 * @param {object} context - The context object with env and log
 * @returns {Promise<boolean>} True if RUM is available, false otherwise
 */
async function isRUMAvailable(domain, context) {
  const { log } = context;

  try {
    const rumClient = RUMAPIClient.createFrom(context);

    // Attempt to get domainkey - if this succeeds, RUM is available
    await rumClient.retrieveDomainkey(domain);

    log.info(`RUM is available for domain: ${domain}`);
    return true;
  } catch (error) {
    log.info(`RUM is not available for domain: ${domain}. Reason: ${error.message}`);
    return false;
  }
}

/**
 * Checks if AHREFS data is available by checking if top pages exist for the site
 * @param {string} siteId - The site ID to check
 * @param {object} dataAccess - The data access object
 * @param {object} context - The context object with log
 * @returns {Promise<boolean>} True if AHREFS data is available, false otherwise
 */
async function isAHREFSDataAvailable(siteId, dataAccess, context) {
  const { log } = context;
  const { SiteTopPage } = dataAccess;

  try {
    // Check if top pages exist from AHREFS source
    const topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId, 'ahrefs', 'global');

    const hasData = topPages && topPages.length > 0;
    log.info(`AHREFS data availability for site ${siteId}: ${hasData ? 'Available' : 'Not available'} (${topPages?.length || 0} top pages)`);

    return hasData;
  } catch (error) {
    log.error(`Error checking AHREFS data availability for site ${siteId}: ${error.message}`);
    return false;
  }
}

/**
 * Checks if Google Search Console is configured and connected for the site
 * @param {string} siteUrl - The site URL to check
 * @param {object} context - The context object with env and log
 * @returns {Promise<boolean>} True if GSC is configured, false otherwise
 */
async function isGSCConfigured(siteUrl, context) {
  const { log } = context;

  try {
    // Attempt to create Google client - if this succeeds, GSC is configured
    const googleClient = await GoogleClient.createFrom(context, siteUrl);

    // Try to list sites to verify connection
    const sites = await googleClient.listSites();
    const isConnected = sites?.data?.siteEntry?.length > 0;

    log.info(`GSC configuration for site ${siteUrl}: ${isConnected ? 'Configured and connected' : 'Not configured or not connected'}`);
    return isConnected;
  } catch (error) {
    log.info(`GSC is not configured for site ${siteUrl}. Reason: ${error.message}`);
    return false;
  }
}

/**
 * Gets the opportunity title from the opportunity type
 * @param {string} opportunityType - The opportunity type
 * @returns {string} The opportunity title
 */
function getOpportunityTitle(opportunityType) {
  const opportunityTitles = {
    cwv: 'Core Web Vitals',
    'meta-tags': 'SEO Meta Tags',
    'broken-backlinks': 'Broken Backlinks',
    'broken-internal-links': 'Broken Internal Links',
    'alt-text': 'Alt Text',
    sitemap: 'Sitemap',
  };

  // Check if the opportunity type exists in our map
  if (opportunityTitles[opportunityType]) {
    return opportunityTitles[opportunityType];
  }

  // Convert kebab-case to Title Case (e.g., "first-second" -> "First Second")
  return opportunityType
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Generate failure recommendations based on root cause
 * @param {string} rootCause - The identified root cause
 * @returns {Array<string>} Array of recommendations
 */
export function generateFailureRecommendations(rootCause) {
  const recommendations = [];

  switch (rootCause) {
    case 'timeout':
      recommendations.push('Check network connectivity and server response times');
      recommendations.push('Consider increasing timeout values in configuration');
      recommendations.push('Verify server is not overloaded');
      break;
    case 'ad-blocker':
      recommendations.push('Disable ad blockers or browser extensions');
      recommendations.push('Use incognito/private browsing mode');
      recommendations.push('Check if site is whitelisted in ad blocker');
      break;
    case 'forbidden':
      recommendations.push('Check if site requires authentication');
      recommendations.push('Verify robots.txt allows crawling');
      recommendations.push('Check for IP-based restrictions');
      break;
    case 'cloudflare':
      recommendations.push('Check Cloudflare security settings');
      recommendations.push('Verify CAPTCHA or challenge requirements');
      recommendations.push('Consider using different user agent');
      break;
    case 'rate-limit':
      recommendations.push('Implement exponential backoff retry strategy');
      recommendations.push('Reduce request frequency');
      recommendations.push('Check API rate limits');
      break;
    case 'auth':
      recommendations.push('Verify authentication credentials');
      recommendations.push('Check token expiration');
      recommendations.push('Update API keys if needed');
      break;
    case 'no-data':
      recommendations.push('Verify data source is properly configured');
      recommendations.push('Check if data collection is enabled');
      recommendations.push('Review data retention policies');
      break;
    case 'connection-refused':
      recommendations.push('Check if service is running');
      recommendations.push('Verify network connectivity');
      recommendations.push('Check firewall settings');
      break;
    default:
      recommendations.push('Review CloudWatch logs for more details');
      recommendations.push('Check service health and configuration');
      recommendations.push('Consider contacting support if issue persists');
  }

  return recommendations;
}

/**
 * Search CloudWatch logs for specific failure patterns
 * @param {string} siteId - The site ID to search for
 * @param {object} context - The context object
 * @returns {Promise<Array>} Array of failure patterns found
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
 * @param {Array} failures - Array of failure patterns
 * @returns {Array} Array of root causes with analysis
 */
export function analyzeFailureRootCauses(failures) {
  const rootCauses = [];

  failures.forEach((failureGroup) => {
    const errorTypes = new Map();
    let mostRecentError = null;

    failureGroup.events.forEach((event) => {
      const message = event.message.toLowerCase();
      let errorType = 'unknown';

      if (message.includes('timeout') || message.includes('timed out')) {
        errorType = 'timeout';
      } else if (message.includes('ad blocker') || message.includes('blocked by client')) {
        errorType = 'ad-blocker';
      } else if (message.includes('403') || message.includes('forbidden')) {
        errorType = 'forbidden';
      } else if (message.includes('cloudflare') || message.includes('challenge')) {
        errorType = 'cloudflare';
      } else if (message.includes('rate limit') || message.includes('too many requests')) {
        errorType = 'rate-limit';
      } else if (message.includes('auth') || message.includes('unauthorized')) {
        errorType = 'auth';
      } else if (message.includes('no data') || message.includes('empty')) {
        errorType = 'no-data';
      } else if (message.includes('connection refused') || message.includes('econnrefused')) {
        errorType = 'connection-refused';
      }

      errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);

      if (!mostRecentError || new Date(event.timestamp) > new Date(mostRecentError.timestamp)) {
        mostRecentError = event;
      }
    });

    // Find the most common error type
    let primaryCause = 'unknown';
    let primaryCauseCount = 0;
    for (const [errorType, count] of errorTypes) {
      if (count > primaryCauseCount) {
        primaryCause = errorType;
        primaryCauseCount = count;
      }
    }

    rootCauses.push({
      failureType: failureGroup.type,
      totalErrors: failureGroup.events.length,
      primaryCause,
      primaryCauseCount,
      mostRecentError,
      recommendations: generateFailureRecommendations(primaryCause),
    });
  });

  return rootCauses;
}

/**
 * Runs the opportunity status processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runOpportunityStatusProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Site } = dataAccess;
  const {
    siteId, siteUrl, organizationId, taskContext,
  } = message;
  const {
    auditTypes = [], slackContext,
  } = taskContext;

  log.info('Processing opportunities for site:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
    auditTypes,
  });

  try {
    // Get the site and its opportunities
    const site = await Site.findById(siteId);
    if (!site) {
      log.error(`Site not found for siteId: ${siteId}`);
      await say(env, log, slackContext, `:x: Site not found for siteId: ${siteId}`);
      return ok({ message: 'Site not found' });
    }

    // Check data source availability
    let rumAvailable = false;
    let ahrefsAvailable = false;
    let gscConfigured = false;

    if (siteUrl) {
      try {
        const resolvedUrl = await resolveCanonicalUrl(siteUrl);
        log.info(`Resolved URL: ${resolvedUrl}`);
        const domain = new URL(resolvedUrl).hostname;

        rumAvailable = await isRUMAvailable(domain, context);

        gscConfigured = await isGSCConfigured(resolvedUrl, context);
      } catch (error) {
        log.warn(`Could not resolve canonical URL or parse siteUrl for data source checks: ${siteUrl}`, error);
      }
    }

    ahrefsAvailable = await isAHREFSDataAvailable(siteId, dataAccess, context);

    const opportunities = await site.getOpportunities();
    log.info(`Found ${opportunities.length} opportunities for site ${siteId}. Data sources - RUM: ${rumAvailable}, AHREFS: ${ahrefsAvailable}, GSC: ${gscConfigured}`);

    // Search for failure patterns in CloudWatch logs
    log.info('Searching CloudWatch logs for failure patterns...');
    const failures = await searchFailurePatterns(siteId, context);

    // Analyze root causes
    log.info('Analyzing failure root causes...');
    const rootCauses = analyzeFailureRootCauses(failures);

    const statusMessages = [];

    // Data source status
    const rumStatus = rumAvailable ? ':white_check_mark:' : ':cross-x:';
    const ahrefsStatus = ahrefsAvailable ? ':white_check_mark:' : ':cross-x:';
    const gscStatus = gscConfigured ? ':white_check_mark:' : ':cross-x:';

    statusMessages.push(`RUM ${rumStatus}`);
    statusMessages.push(`AHREFS ${ahrefsStatus}`);
    statusMessages.push(`GSC ${gscStatus}`);

    // Process opportunities by type to avoid duplicates
    const processedTypes = new Set();

    for (const opportunity of opportunities) {
      const opportunityType = opportunity.getType();
      if (processedTypes.has(opportunityType)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      processedTypes.add(opportunityType);

      // eslint-disable-next-line no-await-in-loop
      const suggestions = await opportunity.getSuggestions();

      const opportunityTitle = getOpportunityTitle(opportunityType);
      const hasSuggestions = suggestions && suggestions.length > 0;
      const status = hasSuggestions ? ':white_check_mark:' : ':cross-x:';
      statusMessages.push(`${opportunityTitle} ${status}`);
    }

    if (slackContext && statusMessages.length > 0) {
      const slackMessage = `:white_check_mark: *Data Sources & Opportunities status for site ${siteUrl}*:`;
      const combinedMessage = statusMessages.join('\n');
      await say(env, log, slackContext, slackMessage);
      await say(env, log, slackContext, combinedMessage);

      // Add summary of data source issues
      const issues = [];
      if (!rumAvailable) issues.push('RUM not available');
      if (!ahrefsAvailable) issues.push('AHREFS data not found');
      if (!gscConfigured) issues.push('GSC not configured');

      if (issues.length > 0) {
        await say(env, log, slackContext, `:warning: *Data Source Issues:* ${issues.join(', ')}`);
      }

      // Add failure analysis if failures were found
      if (failures.length > 0) {
        await say(env, log, slackContext, `:mag: *Failure Analysis Report for ${siteUrl}*`);
        await say(env, log, slackContext, `:warning: *Found ${failures.length} failure types in CloudWatch logs*`);

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
        await say(env, log, slackContext, '*Next Steps:*');
        await say(env, log, slackContext, '1. Review the specific error patterns above');
        await say(env, log, slackContext, '2. Check CloudWatch logs for more details');
        await say(env, log, slackContext, '3. Consider implementing retry logic or alternative approaches');
      } else {
        await say(env, log, slackContext, ':tada: *No failures detected in the last 7 days*');
        await say(env, log, slackContext, 'All systems appear to be functioning normally');
      }
    }

    log.info(`Processed ${opportunities.length} opportunities for site ${siteId}`);

    return ok({
      message: `Opportunity status processor completed for ${opportunities.length} opportunities`,
      opportunitiesProcessed: opportunities.length,
      dataSources: {
        rum: rumAvailable,
        ahrefs: ahrefsAvailable,
        gsc: gscConfigured,
      },
      failureAnalysis: {
        failureTypes: failures.length,
        rootCauses: rootCauses.length,
        details: {
          failures,
          rootCauses,
        },
      },
    });
  } catch (error) {
    log.error('Error in opportunity status processor:', error);
    await say(env, log, slackContext, `:x: Error processing opportunities for site ${siteId}: ${error.message}`);
    return ok({
      message: 'Opportunity status processor completed with errors',
      error: error.message,
    });
  }
}

export default runOpportunityStatusProcessor;
