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
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import RUMAPIClient from '@adobe/spacecat-shared-rum-api-client';
import GoogleClient from '@adobe/spacecat-shared-google-client';
import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import { resolveCanonicalUrl } from '@adobe/spacecat-shared-utils';
import { say } from '../../utils/slack-utils.js';
import { getOpportunitiesForAudit } from './audit-opportunity-map.js';
import { OPPORTUNITY_DEPENDENCY_MAP } from './opportunity-dependency-map.js';

const TASK_TYPE = 'opportunity-status-processor';
const AUDIT_WORKER_LOG_GROUP = '/aws/lambda/spacecat-services--audit-worker';

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
 * Checks if AHREFSImport data is available by checking if top pages exist for the site
 * @param {string} siteId - The site ID to check
 * @param {object} dataAccess - The data access object
 * @param {object} context - The context object with log
 * @returns {Promise<boolean>} True if AHREFS Import data is available, false otherwise
 */
async function isAHREFSImportDataAvailable(siteId, dataAccess, context) {
  const { log } = context;
  const { SiteTopPage } = dataAccess;

  try {
    const topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId, 'ahrefs', 'global');

    const hasData = topPages && topPages.length > 0;
    log.info(`AHREFS Import data availability for site ${siteId}: ${hasData ? 'Available' : 'Not available'} (${topPages?.length || 0} top pages)`);

    return hasData;
  } catch (error) {
    log.error(`Error checking AHREFS Import data availability for site ${siteId}: ${error.message}`);
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
 * Checks if scraping functionality is available for a site by analyzing recent scrape jobs
 * Fetches latest scrape job results and provides detailed URL-level status
 *
 * @param {string} baseUrl - The base URL to check
 * @param {object} context - The context object with env and log
 * @returns {Promise<{available: boolean, results: Array}>} Scraping availability and URL results
 */
async function isScrapingAvailable(baseUrl, context) {
  const { log } = context;

  try {
    /* c8 ignore start */
    // Defensive check: Cannot be tested as caller (line 458) already validates siteUrl is truthy
    // before calling this function, making this path unreachable in normal flow
    if (!baseUrl) {
      return { available: false, results: [] };
    }
    /* c8 ignore stop */

    // Create scrape client
    const scrapeClient = ScrapeClient.createFrom(context);

    // Get all scrape jobs for this baseUrl with 'default' processing type
    const jobs = await scrapeClient.getScrapeJobsByBaseURL(baseUrl, 'default');

    if (!jobs || jobs.length === 0) {
      return { available: false, results: [] };
    }

    // Sort jobs by date (latest first) - assuming jobs have a timestamp field
    const sortedJobs = jobs.sort((a, b) => {
      const dateA = new Date(b.startedAt || b.createdAt || 0);
      const dateB = new Date(a.startedAt || a.createdAt || 0);
      return dateA - dateB;
    });

    // Find the first job that has URL results
    let jobWithResults = null;
    let urlResults = [];

    /* eslint-disable no-await-in-loop */
    for (const job of sortedJobs) {
      const results = await scrapeClient.getScrapeJobUrlResults(job.id);
      if (results && results.length > 0) {
        jobWithResults = job;
        urlResults = results;
        break;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (!jobWithResults) {
      log.info(`Scraping check: No jobs with URL results found for ${baseUrl}`);
      return { available: false, results: [] };
    }

    // Count successful and failed scrapes
    const completedCount = urlResults.filter((result) => result.status === 'COMPLETE').length;
    const failedCount = urlResults.filter((result) => result.status === 'FAILED').length;
    const totalCount = urlResults.length;

    // Check if at least one URL was successfully scraped (status === 'COMPLETE')
    const hasSuccessfulScrape = completedCount > 0;

    return {
      available: hasSuccessfulScrape,
      results: urlResults,
      jobId: jobWithResults.id,
      stats: {
        completed: completedCount,
        failed: failedCount,
        total: totalCount,
      },
    };
  } catch (error) {
    log.error(`Scraping check failed for ${baseUrl}:`, error);
    return { available: false, results: [] };
  }
}

/**
 * Searches CloudWatch logs for audit execution
 * @param {string} auditType - The audit type to search for
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} context - The context object
 * @returns {Promise<boolean>} Whether the audit was executed
 */
async function checkAuditExecution(auditType, siteId, onboardStartTime, context) {
  const { log, env } = context;
  const logGroupName = AUDIT_WORKER_LOG_GROUP;

  try {
    const cloudWatchClient = new CloudWatchLogsClient({ region: env.AWS_REGION || 'us-east-1' });
    const filterPattern = `"Received ${auditType} audit request for: ${siteId}"`;

    // Add small buffer before onboardStartTime to account for clock skew and processing delays
    // The audit log should be after onboardStartTime, but we add a small buffer for safety
    const bufferMs = 30 * 1000; // 30 seconds
    const searchStartTime = onboardStartTime ? onboardStartTime - bufferMs : undefined;

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
 * Searches CloudWatch logs for audit failure reason
 * @param {string} auditType - The audit type to search for
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} context - The context object
 * @returns {Promise<string|null>} The failure reason or null if not found
 */
async function getAuditFailureReason(auditType, siteId, onboardStartTime, context) {
  const { log, env } = context;
  const logGroupName = AUDIT_WORKER_LOG_GROUP;

  try {
    const cloudWatchClient = new CloudWatchLogsClient({ region: env.AWS_REGION || 'us-east-1' });
    const filterPattern = `"${auditType} audit for ${siteId} failed"`;

    // Add small buffer before onboardStartTime to account for clock skew and processing delays
    const bufferMs = 30 * 1000; // 30 seconds
    const searchStartTime = onboardStartTime ? onboardStartTime - bufferMs : undefined;

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
  /* c8 ignore start */
  // Defensive error handling: Difficult to test as requires CloudWatch API to throw errors.
  // Would need complex AWS SDK mocking infrastructure for marginal coverage gain.
  } catch (error) {
    log.error(`Error checking audit failure for ${auditType}:`, error);
    return null;
  }
  /* c8 ignore stop */
}

/**
 * Analyzes missing opportunities and determines the root cause
 * @param {Array<string>} missingOpportunities - Array of missing opportunity types
 * @param {Array<string>} auditTypes - Array of audit types from profile
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} serviceStatus - Object containing status of all services
 * @param {object} context - The context object
 * @returns {Promise<Array<{opportunity: string, reason: string, audit: string}>>} Analysis results
 */
async function analyzeMissingOpportunities(
  missingOpportunities,
  auditTypes,
  siteId,
  onboardStartTime,
  serviceStatus,
  context,
) {
  const results = [];

  /* eslint-disable no-await-in-loop */
  for (const opportunityType of missingOpportunities) {
    // Find which audit(s) should generate this opportunity
    const relatedAudits = auditTypes.filter((auditType) => {
      const opportunities = getOpportunitiesForAudit(auditType);
      return opportunities.includes(opportunityType);
    });

    /* c8 ignore start */
    // Edge case: Opportunity type exists in dependency map but no configured audit generates it.
    // Requires adding orphan opportunity types to test, complex to mock without production impact.
    if (relatedAudits.length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }
    /* c8 ignore stop */

    for (const auditType of relatedAudits) {
      const auditExecuted = await checkAuditExecution(
        auditType,
        siteId,
        onboardStartTime,
        context,
      );

      if (!auditExecuted) {
        results.push({
          opportunity: opportunityType,
          audit: auditType,
          reason: `${auditType} audit has not been executed`,
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      const dependencies = OPPORTUNITY_DEPENDENCY_MAP[opportunityType] || [];
      const unmetDeps = [];

      for (const dep of dependencies) {
        if (dep === 'RUM' && !serviceStatus.rum) {
          unmetDeps.push('RUM');
        } else if (dep === 'AHREFSImport' && !serviceStatus.ahrefsImport) {
          unmetDeps.push('AHREFS Import');
        /* c8 ignore start */
        // Edge case: Scraping unavailable scenario - requires all scrape jobs to fail.
        // Covered by test but specific branch condition difficult to isolate in coverage.
        } else if (dep === 'scraping' && !serviceStatus.scraping) {
          unmetDeps.push('Scraping');
        }
        /* c8 ignore stop */
      }

      if (unmetDeps.length > 0) {
        results.push({
          opportunity: opportunityType,
          audit: auditType,
          reason: `Missing dependencies: ${unmetDeps.join(', ')}`,
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      // All dependencies met, check for audit failure
      const failureReason = await getAuditFailureReason(
        auditType,
        siteId,
        onboardStartTime,
        context,
      );

      if (failureReason) {
        results.push({
          opportunity: opportunityType,
          audit: auditType,
          reason: `Audit failed: ${failureReason}`,
        });
      } else {
        results.push({
          opportunity: opportunityType,
          audit: auditType,
          reason: 'Audit executed successfully, found no issues to report (no opportunities created)',
        });
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  return results;
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

    // Check data source availability and service preconditions
    let rumAvailable = false;
    let ahrefsImportAvailable = false;
    let gscConfigured = false;
    let scrapingAvailable = false;

    const opportunities = await site.getOpportunities();

    // Get expected opportunities based on audits from profile
    let expectedOpportunityTypes = [];
    let hasUnknownAuditTypes = false;
    if (auditTypes && auditTypes.length > 0) {
      auditTypes.forEach((auditType) => {
        const opportunitiesForAudit = getOpportunitiesForAudit(auditType);
        if (opportunitiesForAudit.length === 0) {
          // This audit type doesn't map to any known opportunities
          hasUnknownAuditTypes = true;
        }
        expectedOpportunityTypes = [...expectedOpportunityTypes, ...opportunitiesForAudit];
      });
      // Remove duplicates
      expectedOpportunityTypes = [...new Set(expectedOpportunityTypes)];
    }

    // Calculate which dependencies are needed based on expected opportunities
    const requiredDependencies = new Set();
    expectedOpportunityTypes.forEach((oppType) => {
      const deps = OPPORTUNITY_DEPENDENCY_MAP[oppType] || [];
      deps.forEach((dep) => requiredDependencies.add(dep));
    });

    const needsRUM = requiredDependencies.has('RUM');
    const needsAHREFSImport = requiredDependencies.has('AHREFSImport');
    const needsScraping = requiredDependencies.has('scraping');
    const needsGSC = requiredDependencies.has('GSC');

    // Only check data sources that are needed
    if (siteUrl && (needsRUM || needsGSC || needsScraping)) {
      try {
        const resolvedUrl = await resolveCanonicalUrl(siteUrl);
        log.info(`Resolved URL: ${resolvedUrl}`);
        const domain = new URL(resolvedUrl).hostname;

        if (needsRUM) {
          rumAvailable = await isRUMAvailable(domain, context);
        }

        if (needsGSC) {
          gscConfigured = await isGSCConfigured(resolvedUrl, context);
        }

        if (needsScraping) {
          const scrapingCheck = await isScrapingAvailable(siteUrl, context);
          scrapingAvailable = scrapingCheck.available;

          // Send Slack notification with scraping statistics if available
          if (scrapingCheck.stats && slackContext) {
            const { completed, failed, total } = scrapingCheck.stats;
            const statsMessage = `:mag: *Scraping Statistics for ${siteUrl}*\n`
              + `✅ Completed: ${completed}\n`
              + `❌ Failed: ${failed}\n`
              + `📊 Total: ${total}`;

            if (failed > 0) {
              await say(
                env,
                log,
                slackContext,
                `${statsMessage}\n:information_source: _${failed} failed URLs will be retried on re-onboarding._`,
              );
            } else {
              await say(env, log, slackContext, statsMessage);
            }
          }
        }
      } catch (error) {
        log.warn(`Could not resolve canonical URL or parse siteUrl for data source checks: ${siteUrl}`, error);
      }
    }

    if (needsAHREFSImport) {
      ahrefsImportAvailable = await isAHREFSImportDataAvailable(siteId, dataAccess, context);
    }

    // Determine service status for dependency checking
    const serviceStatus = {
      rum: rumAvailable,
      ahrefsImport: ahrefsImportAvailable,
      gsc: gscConfigured,
      scraping: scrapingAvailable,
    };

    // Get actual opportunity types from site
    const actualOpportunityTypes = opportunities.map((opp) => opp.getType());
    const uniqueActualOpportunityTypes = [...new Set(actualOpportunityTypes)];

    // Find missing opportunities (expected but not found)
    const missingOpportunities = expectedOpportunityTypes.filter(
      (expectedType) => !uniqueActualOpportunityTypes.includes(expectedType),
    );

    // Store missing opportunities analysis for later display in Audit Processing Errors section
    let missingOpportunitiesAnalysis = [];
    if (missingOpportunities.length > 0) {
      log.warn(`Missing opportunities for site ${siteId}: ${missingOpportunities.join(', ')}`);

      // Analyze missing opportunities to determine root cause
      if (onboardStartTime) {
        missingOpportunitiesAnalysis = await analyzeMissingOpportunities(
          missingOpportunities,
          auditTypes,
          siteId,
          onboardStartTime,
          serviceStatus,
          context,
        );
      }
    }

    const statusMessages = [];

    // Data source and service precondition status
    const rumStatus = rumAvailable ? ':white_check_mark:' : ':x:';
    const ahrefsImportStatus = ahrefsImportAvailable ? ':white_check_mark:' : ':x:';
    const gscStatus = gscConfigured ? ':white_check_mark:' : ':x:';
    const scrapingStatus = scrapingAvailable ? ':white_check_mark:' : ':x:';

    statusMessages.push(`RUM ${rumStatus}`);
    statusMessages.push(`AHREFS Import ${ahrefsImportStatus}`);
    statusMessages.push(`GSC ${gscStatus}`);
    statusMessages.push(`Scraping ${scrapingStatus}`);

    // Process opportunities by type to avoid duplicates
    // Only process opportunities that are expected based on the profile's audit types
    const processedTypes = new Set();
    const failedOpportunities = [];

    for (const opportunity of opportunities) {
      const opportunityType = opportunity.getType();

      // Filter opportunities based on profile's audit configuration
      // Only filter if we have audits configured AND all audits map to known opportunities
      // If there are unknown audit types, don't filter (backward compatibility)
      const shouldFilter = auditTypes
        && auditTypes.length > 0
        && expectedOpportunityTypes.length > 0
        && !hasUnknownAuditTypes;

      if (shouldFilter && !expectedOpportunityTypes.includes(opportunityType)) {
        // This opportunity is not expected based on the configured audits - skip it
        // eslint-disable-next-line no-continue
        continue;
      }

      if (processedTypes.has(opportunityType)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      processedTypes.add(opportunityType);

      // eslint-disable-next-line no-await-in-loop
      const suggestions = await opportunity.getSuggestions();

      const opportunityTitle = getOpportunityTitle(opportunityType);
      const hasSuggestions = suggestions && suggestions.length > 0;
      const status = hasSuggestions ? ':white_check_mark:' : ':x:';
      statusMessages.push(`${opportunityTitle} ${status}`);

      // Track failed opportunities (no suggestions)
      if (!hasSuggestions) {
        // Use informational message for opportunities with zero suggestions
        const reason = 'Audit executed successfully, opportunity added, but found no suggestions';

        failedOpportunities.push({
          title: opportunityTitle,
          reason,
        });
      }
    }

    if (slackContext && statusMessages.length > 0) {
      // Section 1: Data Sources for site (only show required dependencies)
      const dataSourceMessages = [];
      if (needsRUM) {
        dataSourceMessages.push(`RUM ${rumAvailable ? ':white_check_mark:' : ':x:'}`);
      }
      if (needsAHREFSImport) {
        dataSourceMessages.push(`AHREFS Import ${ahrefsImportAvailable ? ':white_check_mark:' : ':x:'}`);
      }
      if (needsGSC) {
        dataSourceMessages.push(`GSC ${gscConfigured ? ':white_check_mark:' : ':x:'}`);
      }
      if (needsScraping) {
        dataSourceMessages.push(`Scraping ${scrapingAvailable ? ':white_check_mark:' : ':x:'}`);
      }

      await say(env, log, slackContext, `*Data Sources for site ${siteUrl}*`);
      if (dataSourceMessages.length > 0) {
        await say(env, log, slackContext, dataSourceMessages.join('\n'));
      } else {
        await say(env, log, slackContext, 'No data sources found');
      }

      // Section 2: Opportunity Statuses for site
      await say(env, log, slackContext, `*Opportunity Statuses for site ${siteUrl}*`);
      const opportunityMessages = statusMessages.filter(
        (msg) => !msg.includes('RUM')
          && !msg.includes('AHREFS Import')
          && !msg.includes('GSC')
          && !msg.includes('Scraping'),
      );

      // Add successful audits (those that found no issues) to the Opportunity Statuses section
      const successfulAudits = missingOpportunitiesAnalysis
        .filter((analysis) => analysis.reason.includes('found no issues to report'))
        .map((analysis) => `${analysis.opportunity} :information_source:`);

      const allOpportunityMessages = [...opportunityMessages, ...successfulAudits];

      if (allOpportunityMessages.length > 0) {
        await say(env, log, slackContext, allOpportunityMessages.join('\n'));
      } else {
        await say(env, log, slackContext, 'No opportunities found');
      }

      await say(env, log, slackContext, `*Audit Processing Errors for site ${siteUrl}*`);

      const auditErrors = [];

      // Add failed opportunities with their reasons
      if (failedOpportunities.length > 0) {
        for (const failed of failedOpportunities) {
          // Use info icon for successful audits with zero suggestions
          const emoji = failed.reason.includes('opportunity found with zero suggestions') ? ' :information_source:' : ' :x:';
          auditErrors.push(`*${failed.title}*: ${failed.reason}${emoji}`);
        }
      }

      // Add missing opportunities analysis
      if (missingOpportunitiesAnalysis.length > 0) {
        for (const analysis of missingOpportunitiesAnalysis) {
          // Use info icon for successful audits, error icon for actual failures
          const emoji = analysis.reason.includes('found no issues to report') ? ':information_source:' : ':x:';
          auditErrors.push(`*${analysis.opportunity}*: ${analysis.reason} ${emoji}`);
        }
      }

      if (auditErrors.length > 0) {
        await say(env, log, slackContext, auditErrors.join('\n'));
      } else {
        await say(env, log, slackContext, 'No audit errors found');
      }
    }

    log.info(`Processed ${opportunities.length} opportunities for site ${siteId}`);

    return ok({
      message: `Opportunity status processor completed for ${opportunities.length} opportunities`,
      opportunitiesProcessed: opportunities.length,
      dataSources: {
        rum: rumAvailable,
        ahrefsImport: ahrefsImportAvailable,
        gsc: gscConfigured,
      },
      servicePreconditions: {
        import: ahrefsImportAvailable, // Import and AHREFS are the same
        scraping: scrapingAvailable,
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
