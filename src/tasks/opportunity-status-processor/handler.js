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
 * Checks if scraping functionality is available for a site by analyzing recent scrape jobs
 * Fetches latest scrape job results and provides detailed URL-level status
 *
 * @param {string} baseUrl - The base URL to check
 * @param {string} siteId - The site ID (unused, kept for API compatibility)
 * @param {object} context - The context object with env and log
 * @returns {Promise<{available: boolean, results: Array}>} Scraping availability and URL results
 */
async function isScrapingAvailable(baseUrl, siteId, context) {
  const { log } = context;

  try {
    if (!baseUrl) {
      log.warn('Scraping check: No baseUrl provided');
      return { available: false, results: [] };
    }

    // Create scrape client
    const scrapeClient = ScrapeClient.createFrom(context);

    // Get all scrape jobs for this baseUrl with 'default' processing type
    const jobs = await scrapeClient.getScrapeJobsByBaseURL(baseUrl, 'default');

    if (!jobs || jobs.length === 0) {
      log.info(`Scraping check: No scrape jobs found for ${baseUrl}`);
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

    // Check if at least one URL was successfully scraped (status === 'COMPLETE')
    const hasSuccessfulScrape = urlResults.some((result) => result.status === 'COMPLETE');

    return {
      available: hasSuccessfulScrape,
      results: urlResults,
      jobId: jobWithResults.id,
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
  const logGroupName = '/aws/lambda/spacecat-services--audit-worker';

  try {
    const cloudWatchClient = new CloudWatchLogsClient({ region: env.AWS_REGION || 'us-east-1' });
    const filterPattern = `"Received ${auditType} audit request for: ${siteId}"`;

    const command = new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      startTime: onboardStartTime,
      endTime: Date.now(),
    });

    const response = await cloudWatchClient.send(command);
    return response.events && response.events.length > 0;
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
  const logGroupName = '/aws/lambda/spacecat-services--audit-worker';

  try {
    const cloudWatchClient = new CloudWatchLogsClient({ region: env.AWS_REGION || 'us-east-1' });
    const filterPattern = `"${auditType} audit for ${siteId} failed"`;

    const command = new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      startTime: onboardStartTime,
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
    }

    return null;
  } catch (error) {
    log.error(`Error checking audit failure for ${auditType}:`, error);
    return null;
  }
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

    if (relatedAudits.length === 0) {
      // No related audits found, skip this opportunity
      // eslint-disable-next-line no-continue
      continue;
    }

    // Check each related audit
    for (const auditType of relatedAudits) {
      // Check if audit was executed
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

      // Audit was executed, check if dependencies are met
      const dependencies = OPPORTUNITY_DEPENDENCY_MAP[opportunityType] || [];
      const unmetDeps = [];

      for (const dep of dependencies) {
        if (dep === 'RUM' && !serviceStatus.rum) {
          unmetDeps.push('RUM');
        } else if (dep === 'AHREFSImport' && !serviceStatus.ahrefsImport) {
          unmetDeps.push('AHREFS Import');
        } else if (dep === 'scraping' && !serviceStatus.scraping) {
          unmetDeps.push('Scraping');
        }
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
          reason: 'Reason unknown - audit executed but opportunity not created',
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
    let scrapingResults = [];

    const opportunities = await site.getOpportunities();

    // Get expected opportunities based on audits from profile
    let expectedOpportunityTypes = [];
    if (auditTypes && auditTypes.length > 0) {
      auditTypes.forEach((auditType) => {
        const opportunitiesForAudit = getOpportunitiesForAudit(auditType);
        expectedOpportunityTypes = [...expectedOpportunityTypes, ...opportunitiesForAudit];
      });
      // Remove duplicates
      expectedOpportunityTypes = [...new Set(expectedOpportunityTypes)];
      log.info(`Expected opportunity types based on audits [${auditTypes.join(', ')}]: ${expectedOpportunityTypes.join(', ')}`);
    }

    // Calculate which dependencies are needed based on expected opportunities
    const requiredDependencies = new Set();
    expectedOpportunityTypes.forEach((oppType) => {
      const deps = OPPORTUNITY_DEPENDENCY_MAP[oppType] || [];
      deps.forEach((dep) => requiredDependencies.add(dep));
    });
    log.info(`Required dependencies for expected opportunities: ${Array.from(requiredDependencies).join(', ')}`);

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
          const scrapingCheck = await isScrapingAvailable(siteUrl, siteId, context);
          scrapingAvailable = scrapingCheck.available;
          scrapingResults = scrapingCheck.results || [];
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

    if (missingOpportunities.length > 0) {
      log.warn(`Missing opportunities for site ${siteId}: ${missingOpportunities.join(', ')}`);

      // Analyze missing opportunities to determine root cause
      if (onboardStartTime) {
        const missingOpportunitiesAnalysis = await analyzeMissingOpportunities(
          missingOpportunities,
          auditTypes,
          siteId,
          onboardStartTime,
          serviceStatus,
          context,
        );

        // Send Slack messages for each missing opportunity
        /* eslint-disable no-await-in-loop */
        for (const analysis of missingOpportunitiesAnalysis) {
          const slackMessage = `:x: *Missing Opportunity: ${analysis.opportunity}*\n`
            + `Audit: \`${analysis.audit}\`\n`
            + `Reason: ${analysis.reason}`;
          await say(env, log, slackContext, slackMessage);
        }
        /* eslint-enable no-await-in-loop */
      }
    } else if (expectedOpportunityTypes.length > 0) {
      log.info(`All expected opportunities are present for site ${siteId}`);
    }

    const opportunityWord = opportunities.length === 1 ? 'opportunity' : 'opportunities';
    log.info(`Found ${opportunities.length} ${opportunityWord} for site ${siteId}. `
      + `Data sources - RUM: ${rumAvailable}, AHREFS Import: ${ahrefsImportAvailable}, `
      + `GSC: ${gscConfigured}, Scraping: ${scrapingAvailable}`);

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
          } else if (runbook.includes('AHREFSImport') || runbook.includes('ahrefs')) {
            specificReason = 'AHREFS Import data not available';
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

      if (dataSourceMessages.length > 0) {
        await say(env, log, slackContext, `*Data Sources for site ${siteUrl}*`);
        await say(env, log, slackContext, dataSourceMessages.join('\n'));
      }

      // Section 2: Opportunity Statuses for site
      await say(env, log, slackContext, `*Opportunity Statuses for site ${siteUrl}*`);
      const opportunityMessages = statusMessages.filter(
        (msg) => !msg.includes('RUM')
          && !msg.includes('AHREFS Import')
          && !msg.includes('GSC')
          && !msg.includes('Scraping'),
      );
      if (opportunityMessages.length > 0) {
        await say(env, log, slackContext, opportunityMessages.join('\n'));
      } else {
        await say(env, log, slackContext, 'No opportunities found for this site');
      }

      await say(env, log, slackContext, `*Audit Processing Errors for site ${siteUrl}*`);

      const auditErrors = [];

      // Only show errors for required dependencies
      if (needsAHREFSImport && !ahrefsImportAvailable) {
        auditErrors.push('AHREFS Import: No data found :x:');
      }

      // Add scraping details with URL-level status (only if scraping is needed)
      if (needsScraping) {
        if (scrapingResults.length > 0) {
          auditErrors.push('Scraping:');
          scrapingResults.forEach((result) => {
            const status = result.status === 'COMPLETE' ? ':white_check_mark:' : ':x:';
            const reasonText = result.status === 'FAILED' && result.reason ? ` (${result.reason})` : '';
            auditErrors.push(`    ${result.url} ${status}${reasonText}`);
          });
        } else if (!scrapingAvailable) {
          auditErrors.push('Scraping: Site not scrapable :x:');
        }
      }

      if (needsRUM && !rumAvailable) {
        auditErrors.push('RUM: Not configured :x:');
      }

      // Check GSC configuration (only if needed)
      if (needsGSC && !gscConfigured) {
        auditErrors.push('GSC: Not configured :x:');
      }

      // Add failed opportunities with their reasons
      if (failedOpportunities.length > 0) {
        for (const failed of failedOpportunities) {
          auditErrors.push(`${failed.title}: ${failed.reason} :x:`);
        }
      }

      if (auditErrors.length > 0) {
        await say(env, log, slackContext, auditErrors.join('\n'));
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
