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
import { resolveCanonicalUrl } from '@adobe/spacecat-shared-utils';
import { say } from '../../utils/slack-utils.js';
import { getOpportunitiesForAudit } from './audit-opportunity-map.js';
import {
  OPPORTUNITY_DEPENDENCY_MAP,
  getOpportunitiesWithUnmetDependencies,
} from './opportunity-dependency-map.js';

const TASK_TYPE = 'opportunity-status-processor';

/**
 * Map of service preconditions to determine if log analysis is needed
 * Key: service name, Value: whether to check logs when this service fails
 */
const SERVICE_LOG_CHECK_MAP = {
  rum: true, // Check logs if RUM is unavailable
  ahrefs: false, // Don't check logs if AHREFS is unavailable (data source issue)
  gsc: false, // Don't check logs if GSC is not configured (configuration issue)
  import: true, // Check logs if imports are failing
  scraping: true, // Check logs if scraping is failing
};

/**
 * Map of service types to their corresponding CloudWatch log groups
 * Used to target specific log groups when a service is failing
 */
const SERVICE_LOG_GROUP_MAP = {
  rum: '/aws/lambda/spacecat-services--audit-worker',
  import: '/aws/lambda/spacecat-services--import-worker',
  scraping: '/aws/lambda/spacecat-services--content-scraper',
};

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
 * @returns {Array<string>} Array of recommendations
 * @deprecated This function is deprecated. Use error-mapping-loader instead.
 */
export function generateFailureRecommendations() {
  // Deprecated: This function is no longer used with the new error mapping system
  return [];
}

/**
 * Checks if import functionality is available for a site
 * @param {string} siteId - The site ID to check
 * @param {object} dataAccess - The data access object
 * @param {object} context - The context object with env and log
 * @returns {Promise<boolean>} True if imports are available, false otherwise
 */
async function isImportAvailable(siteId, dataAccess, context) {
  const { log } = context;
  const { SiteTopPage } = dataAccess;

  try {
    // Check if there are any imported top pages for this site
    const topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId);

    if (topPages && topPages.length > 0) {
      log.info(`Import check: Found ${topPages.length} imported top pages for site ${siteId}`);
      return true;
    }

    log.warn(`Import check: No imported top pages found for site ${siteId}`);
    return false;
  } catch (error) {
    log.warn(`Import check failed for site ${siteId}:`, error);
    return false;
  }
}

/**
 * Checks if scraping functionality is available for a site
 * @param {string} siteUrl - The site URL to check
 * @param {object} context - The context object with env and log
 * @returns {Promise<boolean>} True if scraping is available, false otherwise
 */
async function isScrapingAvailable(siteUrl, context) {
  const { log } = context;

  try {
    if (!siteUrl) {
      log.warn('Scraping check: No siteUrl provided');
      return false;
    }

    // Basic check: validate URL is accessible
    const resolvedUrl = await resolveCanonicalUrl(siteUrl, log);
    if (!resolvedUrl) {
      log.warn(`Scraping check: Could not resolve URL ${siteUrl}`);
      return false;
    }

    // TODO: Could add more sophisticated checks here:
    // - Check if site has robots.txt that blocks scraping
    // - Check if site is reachable with a HEAD request
    // - Check recent scraping success rate from logs

    log.info(`Scraping check: Site ${siteUrl} appears scrapable`);
    return true;
  } catch (error) {
    log.warn(`Scraping check failed for ${siteUrl}:`, error);
    return false;
  }
}

/**
 * Determines which services need log analysis based on precondition check results
 * @param {object} serviceStatus - Object containing status of all services
 * @returns {Array<{service: string, logGroup: string}>} Array of services that need log analysis
 */
function getServicesNeedingLogAnalysis(serviceStatus) {
  const servicesToCheck = [];

  Object.entries(serviceStatus).forEach(([serviceName, isAvailable]) => {
    // Check if this service should have logs analyzed when it fails
    if (!isAvailable && SERVICE_LOG_CHECK_MAP[serviceName]) {
      const logGroup = SERVICE_LOG_GROUP_MAP[serviceName];
      if (logGroup) {
        servicesToCheck.push({
          service: serviceName,
          logGroup,
        });
      }
    }
  });

  return servicesToCheck;
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
 * Searches CloudWatch logs for scraping failure reason
 * @param {string} siteId - The site ID
 * @param {number} onboardStartTime - The onboarding start timestamp
 * @param {object} context - The context object
 * @returns {Promise<string|null>} The failure reason or null if not found
 */
async function getScrapingFailureReason(siteId, onboardStartTime, context) {
  const { log, env } = context;
  const logGroupName = '/aws/lambda/spacecat-services--content-scraper';

  try {
    const cloudWatchClient = new CloudWatchLogsClient({ region: env.AWS_REGION || 'us-east-1' });
    const filterPattern = '"failed to scrape URL"';

    const command = new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      startTime: onboardStartTime,
      endTime: Date.now(),
    });

    const response = await cloudWatchClient.send(command);

    if (response.events && response.events.length > 0) {
      // Return the first scraping failure message
      const { message } = response.events[0];
      // Extract the relevant error details
      const errorMatch = message.match(/failed to scrape URL[^:]*:\s*(.+?)(?:\s+at\s|$)/i);
      if (errorMatch && errorMatch[1]) {
        return errorMatch[1].trim();
      }
      return 'Scraping failed - see logs for details';
    }

    return null;
  } catch (error) {
    log.error('Error checking scraping failure:', error);
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
        const depKey = dep.toLowerCase();
        if (depKey === 'rum' && !serviceStatus.rum) {
          unmetDeps.push('RUM');
        } else if (depKey === 'top-pages' && !serviceStatus.import) {
          unmetDeps.push('Import (top-pages)');
        } else if (depKey === 'scraping' && !serviceStatus.scraping) {
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
        // Check for scraping failures if audit requires scraping
        const scrapingFailureReason = await getScrapingFailureReason(
          siteId,
          onboardStartTime,
          context,
        );

        if (scrapingFailureReason) {
          results.push({
            opportunity: opportunityType,
            audit: auditType,
            reason: `Scraping failed: ${scrapingFailureReason}`,
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
  }
  /* eslint-enable no-await-in-loop */

  return results;
}

/**
 * Finds and analyzes opportunities for a given site
 * Returns list of opportunities with their dependency status
 *
 * @param {object} site - The site object
 * @param {object} serviceStatus - Object containing status of all services
 *   (rum, ahrefs, gsc, import, scraping)
 * @param {object} context - The context object with log
 * @returns {Promise<{
 *   allOpportunities: Array<object>,
 *   opportunitiesWithMetDependencies: Array<object>,
 *   opportunitiesWithUnmetDependencies: Array<object>
 * }>} Opportunity analysis results
 */
// eslint-disable-next-line no-unused-vars
async function findOpportunitiesForSite(site, serviceStatus, context) {
  const { log } = context;

  try {
    // Get all opportunities for the site
    const allOpportunities = await site.getOpportunities();

    if (!allOpportunities || allOpportunities.length === 0) {
      log.info('No opportunities found for site');
      return {
        allOpportunities: [],
        opportunitiesWithMetDependencies: [],
        opportunitiesWithUnmetDependencies: [],
      };
    }

    // Extract opportunity types
    const opportunityTypes = allOpportunities.map((opp) => opp.getType());

    // Check which opportunities have unmet dependencies
    const unmetDependencies = getOpportunitiesWithUnmetDependencies(
      opportunityTypes,
      serviceStatus,
    );

    // Separate opportunities into those with met vs unmet dependencies
    const opportunitiesWithUnmetDependencies = allOpportunities.filter(
      (opp) => unmetDependencies.some((unmet) => unmet.opportunity === opp.getType()),
    );

    const opportunitiesWithMetDependencies = allOpportunities.filter(
      (opp) => !unmetDependencies.some((unmet) => unmet.opportunity === opp.getType()),
    );

    log.info(`Found ${allOpportunities.length} total opportunities: `
      + `${opportunitiesWithMetDependencies.length} with met dependencies, `
      + `${opportunitiesWithUnmetDependencies.length} with unmet dependencies`);

    return {
      allOpportunities,
      opportunitiesWithMetDependencies,
      opportunitiesWithUnmetDependencies,
      unmetDependencyDetails: unmetDependencies,
    };
  } catch (error) {
    log.error('Error finding opportunities for site:', error);
    return {
      allOpportunities: [],
      opportunitiesWithMetDependencies: [],
      opportunitiesWithUnmetDependencies: [],
      unmetDependencyDetails: [],
    };
  }
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
    let ahrefsAvailable = false;
    let gscConfigured = false;
    let importAvailable = false;
    let scrapingAvailable = false;

    if (siteUrl) {
      try {
        const resolvedUrl = await resolveCanonicalUrl(siteUrl);
        log.info(`Resolved URL: ${resolvedUrl}`);
        const domain = new URL(resolvedUrl).hostname;

        rumAvailable = await isRUMAvailable(domain, context);
        gscConfigured = await isGSCConfigured(resolvedUrl, context);
        scrapingAvailable = await isScrapingAvailable(siteUrl, context);
      } catch (error) {
        log.warn(`Could not resolve canonical URL or parse siteUrl for data source checks: ${siteUrl}`, error);
      }
    }

    ahrefsAvailable = await isAHREFSDataAvailable(siteId, dataAccess, context);
    importAvailable = await isImportAvailable(siteId, dataAccess, context);

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

    // Determine service status for dependency checking
    const serviceStatus = {
      rum: rumAvailable,
      ahrefs: ahrefsAvailable,
      gsc: gscConfigured,
      import: importAvailable,
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
      + `Data sources - RUM: ${rumAvailable}, AHREFS: ${ahrefsAvailable}, `
      + `GSC: ${gscConfigured}, Import: ${importAvailable}, Scraping: ${scrapingAvailable}`);

    const servicesToAnalyze = getServicesNeedingLogAnalysis(serviceStatus);

    if (servicesToAnalyze.length > 0) {
      log.info(`Services requiring log analysis: ${servicesToAnalyze.map((s) => s.service).join(', ')}`);
      // TODO: Implement CloudWatch log reading and analysis for these services
      // servicesToAnalyze.forEach(({ service, logGroup }) => {
      //   // Read logs from logGroup
      //   // Derive Slack message from log content
      // });
    } else {
      log.info('All service preconditions passed - no log analysis needed');
    }

    const statusMessages = [];

    // Data source and service precondition status
    const rumStatus = rumAvailable ? ':white_check_mark:' : ':x:';
    const ahrefsStatus = ahrefsAvailable ? ':white_check_mark:' : ':x:';
    const gscStatus = gscConfigured ? ':white_check_mark:' : ':x:';
    const importStatus = importAvailable ? ':white_check_mark:' : ':x:';
    const scrapingStatus = scrapingAvailable ? ':white_check_mark:' : ':x:';

    statusMessages.push(`RUM ${rumStatus}`);
    statusMessages.push(`AHREFS ${ahrefsStatus}`);
    statusMessages.push(`GSC ${gscStatus}`);
    statusMessages.push(`Import ${importStatus}`);
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

      if (auditErrors.length > 0) {
        await say(env, log, slackContext, auditErrors.join('\n'));
      }

      // TODO: Add CloudWatch log analysis here
      // Will check logs after preconditions and derive Slack messages directly
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
      servicePreconditions: {
        import: importAvailable,
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
