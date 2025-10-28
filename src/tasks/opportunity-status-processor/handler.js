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
import {
  getRecommendations,
  categorizeLogMessage,
} from './error-patterns.js';

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
 * Generate failure recommendations based on error category and subcategory
 * @param {string} category - The error category
 * @param {string} subCategory - The error subcategory
 * @returns {Array<string>} Array of recommendations
 */
export function generateFailureRecommendations(category, subCategory) {
  return getRecommendations(category, subCategory);
}

/**
 * Search CloudWatch logs for specific failure patterns using error categories
 * @param {string} siteId - The site ID to search for
 * @param {object} context - The context object
 * @param {number} startTime - The timestamp (in ms) to start searching from
 * @returns {Promise<Array>} Array of failure patterns found with categorization
 */
async function searchFailurePatterns(siteId, context, startTime) {
  const cloudWatchClient = new CloudWatchLogsClient({
    region: context.env.AWS_REGION || 'us-east-1',
  });

  // Define log groups and main types to search
  const searchConfigs = [
    {
      mainType: 'Audit',
      logGroup: '/aws/lambda/spacecat-services--audit-worker',
      // Search for general audit failures and specific site failures
      patterns: [
        `"audit failed" "${siteId}"`,
        `"ERROR" "${siteId}"`,
        '"failed for site"',
        '"audit for" "failed"',
      ],
    },
    {
      mainType: 'Import',
      logGroup: '/aws/lambda/spacecat-services--import-worker',
      patterns: [
        `"ERROR Import" "${siteId}"`,
        `"Import" "failed" "${siteId}"`,
        '"ERROR Import type"',
      ],
    },
    {
      mainType: 'Scraper',
      logGroup: '/aws/lambda/spacecat-services--content-scraper',
      patterns: [
        '"Error scraping"',
        '"Failed to scrape"',
        '"net::ERR"',
        '"timeout"',
        '"Protocol error"',
      ],
    },
  ];

  const failures = [];

  const searchPromises = searchConfigs.map(async (config) => {
    try {
      // Try each pattern until we get results
      for (const pattern of config.patterns) {
        try {
          const command = new FilterLogEventsCommand({
            logGroupName: config.logGroup,
            filterPattern: pattern,
            startTime,
            limit: 50, // Increased limit to capture more errors
          });

          // eslint-disable-next-line no-await-in-loop
          const response = await cloudWatchClient.send(command);

          if (response.events && response.events.length > 0) {
            return {
              mainType: config.mainType,
              logGroup: config.logGroup,
              events: response.events.map((event) => ({
                message: event.message,
                timestamp: new Date(event.timestamp).toISOString(),
                logStreamName: event.logStreamName,
              })),
            };
          }
        } catch (patternError) {
          context.log.debug(`Pattern "${pattern}" failed for ${config.mainType}: ${patternError.message}`);
        }
      }
      return null;
    } catch (error) {
      context.log.warn(`Failed to search ${config.mainType} logs: ${error.message}`);
      return null;
    }
  });

  const results = await Promise.all(searchPromises);
  failures.push(...results.filter(Boolean));

  return failures;
}

/**
 * Analyze failure patterns to identify root causes using error categorization
 * @param {Array} failures - Array of failure patterns
 * @returns {Array} Array of root causes with detailed analysis
 */
export function analyzeFailureRootCauses(failures) {
  const rootCauses = [];

  failures.forEach((failureGroup) => {
    const categorizedErrors = new Map(); // Map of category -> count
    const subCategoryDetails = new Map(); // Map of category -> Map of subCategory -> count
    let mostRecentError = null;

    // Categorize each error message
    failureGroup.events.forEach((event) => {
      const categorization = categorizeLogMessage(event.message, failureGroup.mainType);

      // Count by category
      const { category } = categorization;
      categorizedErrors.set(category, (categorizedErrors.get(category) || 0) + 1);

      // Track subcategory details
      if (!subCategoryDetails.has(category)) {
        subCategoryDetails.set(category, new Map());
      }
      const subCatMap = subCategoryDetails.get(category);
      const { subCategory } = categorization;
      subCatMap.set(subCategory, (subCatMap.get(subCategory) || 0) + 1);

      // Track most recent error
      if (!mostRecentError || new Date(event.timestamp) > new Date(mostRecentError.timestamp)) {
        mostRecentError = {
          ...event,
          category: categorization.category,
          subCategory: categorization.subCategory,
        };
      }
    });

    // Find the most common category
    let primaryCategory = 'Unknown';
    let primaryCategoryCount = 0;
    for (const [category, count] of categorizedErrors) {
      if (count > primaryCategoryCount) {
        primaryCategory = category;
        primaryCategoryCount = count;
      }
    }

    // Find the most common subcategory for the primary category
    let primarySubCategory = 'Uncategorized';
    let primarySubCategoryCount = 0;
    if (subCategoryDetails.has(primaryCategory)) {
      const subCatMap = subCategoryDetails.get(primaryCategory);
      for (const [subCat, count] of subCatMap) {
        if (count > primarySubCategoryCount) {
          primarySubCategory = subCat;
          primarySubCategoryCount = count;
        }
      }
    }

    // Generate recommendations based on the categorization
    const recommendations = generateFailureRecommendations(primaryCategory, primarySubCategory);

    rootCauses.push({
      failureType: `${failureGroup.mainType} Failures`,
      mainType: failureGroup.mainType,
      totalErrors: failureGroup.events.length,
      primaryCategory,
      primaryCategoryCount,
      primarySubCategory,
      primarySubCategoryCount,
      allCategories: Array.from(categorizedErrors.entries()).map(([cat, count]) => ({
        category: cat,
        count,
      })),
      mostRecentError,
      recommendations,
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
    auditTypes = [], slackContext, onboardStartTime,
  } = taskContext;

  log.info('Processing opportunities for site:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
    auditTypes,
    onboardStartTime: onboardStartTime ? new Date(onboardStartTime).toISOString() : undefined,
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
    // Use onboardStartTime if defined, otherwise default to last 60 minutes
    const defaultLookbackMs = 60 * 60 * 1000; // 60 minutes in milliseconds
    const logSearchStartTime = onboardStartTime !== undefined
      ? onboardStartTime
      : (Date.now() - defaultLookbackMs);
    log.info(`Searching CloudWatch logs for failure patterns since ${new Date(logSearchStartTime).toISOString()} (using ${onboardStartTime !== undefined ? 'onboardStartTime' : 'default 60-minute lookback'})...`);
    const failures = await searchFailurePatterns(siteId, context, logSearchStartTime);

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
    const failedOpportunities = [];

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

      // Track failed opportunities (no suggestions)
      if (!hasSuggestions) {
        const opportunityData = opportunity.getData ? opportunity.getData() : {};
        const runbook = opportunityData.runbook
          || (opportunity.getRunbook ? opportunity.getRunbook() : null);

        // Determine detailed failure reason
        let failureReason = 'No suggestions generated';
        let specificReason = null;

        if (runbook) {
          if (runbook.includes('RUM') || runbook.includes('rum')) {
            specificReason = 'RUM data not available';
          } else if (runbook.includes('AHREFS') || runbook.includes('ahrefs')) {
            specificReason = 'AHREFS data not available';
          } else if (runbook.includes('GSC') || runbook.includes('Google Search Console')) {
            specificReason = 'GSC not configured';
          }
        }

        // Combine reasons for detailed message
        if (specificReason) {
          failureReason = `No suggestions generated, ${specificReason}`;
        }

        failedOpportunities.push({
          title: opportunityTitle,
          reason: failureReason,
        });
      }
    }

    if (slackContext && statusMessages.length > 0) {
      // Section 1: Data Sources for site
      await say(env, log, slackContext, `*Data Sources for site ${siteUrl}*`);

      const dataSourceMessages = [];
      dataSourceMessages.push(`RUM ${rumAvailable ? ':white_check_mark:' : ':x:'}`);
      dataSourceMessages.push(`AHREFS ${ahrefsAvailable ? ':white_check_mark:' : ':x:'}`);
      dataSourceMessages.push(`GSC ${gscConfigured ? ':white_check_mark:' : ':x:'}`);

      await say(env, log, slackContext, dataSourceMessages.join('\n'));

      // Section 2: Opportunity Statuses for site
      await say(env, log, slackContext, `*Opportunity Statuses for site ${siteUrl}*`);
      const opportunityMessages = statusMessages.filter((msg) => !msg.includes('RUM') && !msg.includes('AHREFS') && !msg.includes('GSC'));
      if (opportunityMessages.length > 0) {
        await say(env, log, slackContext, opportunityMessages.join('\n'));
      } else {
        await say(env, log, slackContext, 'No opportunities found for this site');
      }

      // Section 3: Audit Processing Errors
      await say(env, log, slackContext, `*Audit Processing Errors for site ${siteUrl}*`);

      const auditErrors = [];

      // Check RUM configuration
      if (!rumAvailable) {
        auditErrors.push('RUM: Not configured :x:');
      }

      // Check AHREFS data
      if (!ahrefsAvailable) {
        auditErrors.push('AHREFS: No data found :x:');
      }

      // Check GSC configuration
      if (!gscConfigured) {
        auditErrors.push('GSC: Not configured :x:');
      }

      // Add failed opportunities with their reasons
      if (failedOpportunities.length > 0) {
        for (const failed of failedOpportunities) {
          auditErrors.push(`${failed.title}: ${failed.reason} :x:`);
        }
      }

      // Add audit-specific failures from CloudWatch logs
      if (failures.length > 0 && rootCauses.length > 0) {
        for (const cause of rootCauses) {
          const errorMessage = `${cause.primaryCategory} - ${cause.primarySubCategory} (${cause.primaryCategoryCount} occurrences)`;
          auditErrors.push(`${cause.failureType}: ${errorMessage} :x:`);
        }
      }

      if (auditErrors.length > 0) {
        await say(env, log, slackContext, auditErrors.join('\n'));
      } else {
        await say(env, log, slackContext, 'No failures detected in logs :white_check_mark:');
      }

      // Section 4: Detailed Failure Analysis for site
      if (failures.length > 0) {
        await say(env, log, slackContext, `:mag: *Failure Analysis for site ${siteUrl}*`);
        await say(env, log, slackContext, `:warning: *Found ${failures.length} failure types in CloudWatch logs*`);

        if (rootCauses.length > 0) {
          const slackMessages = [];
          for (const cause of rootCauses) {
            slackMessages.push(`*${cause.failureType}:* ${cause.totalErrors} errors found`);
            slackMessages.push(`Primary Category: ${cause.primaryCategory}`);
            slackMessages.push(`Primary Issue: ${cause.primarySubCategory} (${cause.primarySubCategoryCount} occurrences)`);

            // Show all categories if there are multiple
            if (cause.allCategories && cause.allCategories.length > 1) {
              slackMessages.push('\nAll categories:');
              cause.allCategories.forEach((cat) => {
                slackMessages.push(`  • ${cat.category}: ${cat.count} errors`);
              });
            }

            if (cause.mostRecentError) {
              const timestamp = new Date(cause.mostRecentError.timestamp).toLocaleString();
              slackMessages.push(`\nMost recent error: ${timestamp}`);
              slackMessages.push(`Category: ${cause.mostRecentError.category}`);
              slackMessages.push(`Issue: ${cause.mostRecentError.subCategory}`);
              slackMessages.push(`\`${cause.mostRecentError.message.substring(0, 150)}...\``);
            }

            slackMessages.push('\n*Recommendations:*');
            for (const rec of cause.recommendations) {
              slackMessages.push(`• ${rec}`);
            }
            slackMessages.push('');
          }

          // Send all messages in parallel
          await Promise.all(slackMessages.map((msg) => say(env, log, slackContext, msg)));
        }
      } else {
        await say(env, log, slackContext, 'No failures detected in logs :white_check_mark:');
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
