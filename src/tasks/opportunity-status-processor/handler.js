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
import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import {
  resolveCanonicalUrl,
  getAuditsForOpportunity,
  getOpportunityTitle,
  OPPORTUNITY_DEPENDENCY_MAP,
  getOpportunitiesForAudit,
  computeAuditCompletion,
} from '@adobe/spacecat-shared-utils';
import { checkAndAlertBotProtection } from '../../utils/bot-detection.js';
import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'opportunity-status-processor';

/**
 * Derives a tri-state scraping status from aggregated scrape-URL counts so the report
 * distinguishes "still running" from "failed". A snapshot taken mid-onboarding (many
 * URLs still PENDING/RUNNING, none COMPLETE yet) must read as in-progress, not failed.
 *
 * @param {{completed: number, failed: number, pending: number, total: number}} [stats]
 * @returns {'available'|'in_progress'|'failed'|'unknown'}
 */
export function deriveScrapingStatus(stats) {
  if (!stats || stats.total === 0) {
    return 'unknown';
  }
  if (stats.completed > 0) {
    return 'available';
  }
  if (stats.pending > 0) {
    return 'in_progress';
  }
  return 'failed';
}

/**
 * Opportunity types whose audit only runs for specific site delivery types.
 * An opportunity absent from this map is applicable to every delivery type.
 * Keeping this list conservative avoids hiding opportunities that could legitimately
 * be produced — only encode audits with a hard delivery-type gate in the audit worker.
 *
 * - security-vulnerabilities: the audit skips unless delivery type is AEM_CS
 *   (spacecat-audit-worker src/vulnerabilities/handler.js), so on aem_edge/aem_ams/etc.
 *   it can never produce an opportunity and must not be reported as missing/failed.
 */
const OPPORTUNITY_DELIVERY_TYPE_RESTRICTIONS = {
  'security-vulnerabilities': ['aem_cs'],
};

/**
 * Whether an opportunity type can be produced for a site of the given delivery type.
 * Unrestricted opportunities (and unknown delivery types) are treated as applicable.
 *
 * @param {string} opportunityType
 * @param {string} [deliveryType] - Site delivery type (e.g. 'aem_edge', 'aem_cs')
 * @returns {boolean}
 */
export function isOpportunityApplicableForDeliveryType(opportunityType, deliveryType) {
  const allowedDeliveryTypes = OPPORTUNITY_DELIVERY_TYPE_RESTRICTIONS[opportunityType];
  if (!allowedDeliveryTypes || !deliveryType) {
    return true;
  }
  return allowedDeliveryTypes.includes(deliveryType);
}

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
 * Checks if SEO import data is available by checking if top pages exist for the site
 * @param {string} siteId - The site ID to check
 * @param {object} dataAccess - The data access object
 * @param {object} context - The context object with log
 * @returns {Promise<boolean>} True if SEO import data is available, false otherwise
 */
async function isSEOImportDataAvailable(siteId, dataAccess, context) {
  const { log } = context;
  const { SiteTopPage } = dataAccess;

  try {
    const topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId, 'seo', 'global');

    const hasData = topPages && topPages.length > 0;
    log.info(`SEO Import data availability for site ${siteId}: ${hasData ? 'Available' : 'Not available'} (${topPages?.length || 0} top pages)`);

    return hasData;
  } catch (error) {
    log.error(`Error checking SEO Import data availability for site ${siteId}: ${error.message}`);
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
 * Filters scrape jobs to only include those created after onboardStartTime
 * This ensures we only check jobs from the CURRENT onboarding session,
 * not old scrape jobs from previous runs
 * @param {Array} jobs - Array of scrape jobs
 * @param {number} onboardStartTime - Onboard start timestamp (ms)
 * @returns {Array} Filtered jobs
 */
function filterJobsByTimestamp(jobs, onboardStartTime) {
  return jobs.filter((job) => {
    const jobTimestamp = new Date(job.startedAt || job.createdAt || 0).getTime();
    return jobTimestamp >= onboardStartTime;
  });
}

/**
 * Sorts scrape jobs by date (latest first)
 * @param {Array} jobs - Array of scrape jobs
 * @returns {Array} Sorted jobs
 */
function sortJobsByDate(jobs) {
  return jobs.sort((a, b) => {
    const dateA = new Date(a.startedAt || a.createdAt || 0);
    const dateB = new Date(b.startedAt || b.createdAt || 0);
    return dateB - dateA;
  });
}

/**
 * Checks if scraping functionality is available for a site by analyzing recent scrape jobs
 * Fetches latest scrape job results and provides detailed URL-level status
 *
 * @param {string} baseUrl - The base URL to check
 * @param {object} context - The context object with env and log
 * @param {number} [onboardStartTime] - Optional onboard start timestamp to filter jobs
 * @returns {Promise<{available: boolean, results: Array}>} Scraping availability and URL results
 */
async function isScrapingAvailable(baseUrl, context, onboardStartTime) {
  const { log } = context;

  try {
    // Create scrape client
    const scrapeClient = ScrapeClient.createFrom(context);

    // Get scrape jobs for this baseUrl (default processing type only)
    const jobs = await scrapeClient.getScrapeJobsByBaseURL(baseUrl, 'default');

    if (!jobs || jobs.length === 0) {
      return { available: false, results: [] };
    }

    // Filter jobs created after onboardStartTime
    const filteredJobs = filterJobsByTimestamp(jobs, onboardStartTime);

    log.info(
      `[SCRAPING-CHECK] Found ${filteredJobs.length} jobs created after onboardStartTime for siteUrl=${baseUrl}`,
    );

    if (filteredJobs.length === 0) {
      return { available: false, results: [], jobIds: [] };
    }

    // Sort jobs by date (latest first)
    const sortedJobs = sortJobsByDate(filteredJobs);

    // Find ALL jobs that have URL results (not just the first one)
    // This is needed because multiple audit types create separate jobIds
    const jobsWithResults = [];
    const allUrlResults = [];
    const allJobIds = []; // All jobIds for bot protection check

    /* eslint-disable no-await-in-loop */
    for (const job of sortedJobs) {
      allJobIds.push(job.id);
      const results = await scrapeClient.getScrapeJobUrlResults(job.id);
      if (results && results.length > 0) {
        jobsWithResults.push({
          jobId: job.id,
          job,
          results,
        });
        allUrlResults.push(...results);
      }
    }
    /* eslint-enable no-await-in-loop */

    // Count successful and failed scrapes across all jobs
    const completedCount = allUrlResults.filter((result) => result.status === 'COMPLETE').length;
    const failedCount = allUrlResults.filter((result) => result.status === 'FAILED').length;
    // Non-terminal URLs (scrape still running) — used to distinguish in-progress from failed.
    // The scrape_url_status enum is exactly { PENDING, RUNNING, REDIRECT, COMPLETE, FAILED,
    // STOPPED } (@mysticat/data-service-types); PENDING/RUNNING are the only non-terminal
    // states, so this predicate is complete. REDIRECT/FAILED/STOPPED are terminal
    // non-successes and correctly fall through to "failed" when nothing has completed.
    const pendingCount = allUrlResults.filter(
      (result) => result.status === 'PENDING' || result.status === 'RUNNING',
    ).length;
    const totalCount = allUrlResults.length;

    // Check if at least one URL was successfully scraped (status === 'COMPLETE')
    const hasSuccessfulScrape = completedCount > 0;

    const jobIds = allJobIds;

    log.info(
      `[SCRAPING-CHECK] Scraping check complete: siteUrl=${baseUrl}, `
      + `available=${hasSuccessfulScrape}, jobCount=${jobsWithResults.length}, `
      + `allJobIds=${allJobIds.length} (for bot protection check)`,
    );

    return {
      available: hasSuccessfulScrape,
      results: allUrlResults,
      jobIds, // All jobIds
      jobsWithResults, // Detailed info for each job with results
      stats: {
        completed: completedCount,
        failed: failedCount,
        pending: pendingCount,
        total: totalCount,
      },
    };
  } catch (error) {
    log.error(`Scraping check failed for ${baseUrl}:`, error);
    return { available: false, results: [] };
  }
}

/**
 * Analyzes missing opportunities and determines the root cause.
 *
 * Pure function — derives audit execution state from the DB audit records
 * (via `completedAuditTypes`, computed with `computeAuditCompletion`) instead of
 * grepping CloudWatch logs. This removes the false "audit has not been executed"
 * verdict that fired whenever a log line simply hadn't landed within the onboard
 * wait window: an audit that has not completed yet is reported as *in progress*,
 * not as a failure.
 *
 * @param {Array<string>} missingOpportunities - Expected-but-missing opportunity types
 * @param {Array<string>} auditTypes - Audit types from the profile
 * @param {Array<string>} completedAuditTypes - Audit types with a fresh DB audit record
 * @param {object} serviceStatus - Availability of each data source (rum/seoImport/scraping)
 * @returns {Array<{opportunity: string, audit: string, reason: string, inProgress?: boolean}>}
 */
export function analyzeMissingOpportunities(
  missingOpportunities,
  auditTypes,
  completedAuditTypes,
  serviceStatus,
) {
  const results = [];
  const completed = new Set(completedAuditTypes || []);

  for (const opportunityType of missingOpportunities) {
    // Find which audit(s) should generate this opportunity
    const relatedAudits = auditTypes.filter(
      (auditType) => getOpportunitiesForAudit(auditType).includes(opportunityType),
    );

    if (relatedAudits.length === 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    for (const auditType of relatedAudits) {
      // Not completed yet → still running, not a failure.
      if (!completed.has(auditType)) {
        results.push({
          opportunity: opportunityType,
          audit: auditType,
          reason: `${auditType} audit is still in progress`,
          inProgress: true,
        });
        // eslint-disable-next-line no-continue
        continue;
      }

      const dependencies = OPPORTUNITY_DEPENDENCY_MAP[opportunityType] || [];
      const unmetDeps = [];

      for (const dep of dependencies) {
        if (dep === 'RUM' && !serviceStatus.rum) {
          unmetDeps.push('RUM');
        } else if (dep === 'SEOImport' && !serviceStatus.seoImport) {
          unmetDeps.push('SEO Import');
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

      // Audit completed with all trackable dependencies met, but produced no opportunity.
      results.push({
        opportunity: opportunityType,
        audit: auditType,
        reason: 'Audit executed successfully, found no issues to report (no opportunities created)',
      });
    }
  }

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
    let seoImportAvailable = false;
    let gscConfigured = false;
    let scrapingAvailable = false;
    let scrapingStats = null;

    const opportunities = await site.getOpportunities();

    // Get expected opportunities based on audits from profile.
    // Infrastructure/auto-suggest audits (scrape-top-pages, *-auto-suggest, etc.) have no
    // opportunity mappings and are silently skipped — they must not disable opportunity filtering.
    let expectedOpportunityTypes = [];
    if (auditTypes && auditTypes.length > 0) {
      auditTypes.forEach((auditType) => {
        const opportunitiesForAudit = getOpportunitiesForAudit(auditType);
        if (opportunitiesForAudit.length > 0) {
          expectedOpportunityTypes = [...expectedOpportunityTypes, ...opportunitiesForAudit];
        }
      });
      // Remove duplicates
      expectedOpportunityTypes = [...new Set(expectedOpportunityTypes)];
      // Drop opportunities whose audit cannot run for this site's delivery type
      // (e.g. security-vulnerabilities on aem_edge), so they are not reported as
      // missing/failed when they were never going to be produced.
      const deliveryType = site.getDeliveryType();
      expectedOpportunityTypes = expectedOpportunityTypes.filter(
        (oppType) => isOpportunityApplicableForDeliveryType(oppType, deliveryType),
      );
    }

    // Calculate which dependencies are needed based on expected opportunities
    const requiredDependencies = new Set();
    expectedOpportunityTypes.forEach((oppType) => {
      const deps = OPPORTUNITY_DEPENDENCY_MAP[oppType] || [];
      deps.forEach((dep) => requiredDependencies.add(dep));
    });

    const needsRUM = requiredDependencies.has('RUM');
    const needsSEOImport = requiredDependencies.has('SEOImport');
    const needsScraping = requiredDependencies.has('scraping');
    const needsGSC = requiredDependencies.has('GSC');

    // Track bot protection stats across the handler
    let botProtectionStats = null;

    // Only check data sources that are needed
    if (siteUrl && (needsRUM || needsGSC || needsScraping)) {
      try {
        // Resolve URL for RUM and GSC checks (they need canonical URL)
        const resolvedUrl = needsRUM || needsGSC ? await resolveCanonicalUrl(siteUrl) : siteUrl;

        if (!resolvedUrl) {
          log.warn(`Could not resolve canonical URL for ${siteUrl}, skipping RUM/GSC checks`);
        } else {
          log.info(`Resolved URL: ${resolvedUrl} (for RUM/GSC)`);

          // Extract domain from resolved URL for RUM check
          let domain = null;
          try {
            domain = new URL(resolvedUrl).hostname;
          } catch (urlError) {
            log.warn(`Invalid resolved URL format: ${resolvedUrl}, skipping RUM/GSC checks`, urlError);
            // Skip RUM/GSC checks if URL parsing fails
          }

          if (domain) {
            if (needsRUM) {
              rumAvailable = await isRUMAvailable(domain, context);
            }

            if (needsGSC) {
              gscConfigured = await isGSCConfigured(resolvedUrl, context);
            }
          }
        }

        // Scraping check doesn't require resolved URL - use siteUrl directly
        // because scrape jobs are created with siteUrl from site.getBaseURL()
        if (needsScraping) {
          const scrapingCheck = await isScrapingAvailable(siteUrl, context, onboardStartTime);
          scrapingAvailable = scrapingCheck.available;
          scrapingStats = scrapingCheck.stats || null;

          // Check for bot protection using all jobIds from scraping check
          // Multiple audit types create separate jobIds during onboarding
          const jobIdsToCheck = scrapingCheck.jobIds || [];

          if (jobIdsToCheck.length > 0) {
            botProtectionStats = await checkAndAlertBotProtection({
              jobId: jobIdsToCheck, // Pass array of jobIds
              siteUrl,
              slackContext,
              context,
            });
          } else {
            log.warn(
              '[SCRAPING-CHECK] Skipping bot protection check: no jobIds in scrapingCheck '
              + `for siteUrl=${siteUrl}, available=${scrapingCheck.available}`,
            );
          }

          // Send Slack notification with scraping statistics if available
          // Always show statistics regardless of bot protection status
          // Scraping might still be running, so we show stats every time
          if (slackContext) {
            if (scrapingCheck.stats) {
              const {
                completed, failed, pending = 0, total,
              } = scrapingCheck.stats;
              // Show in-progress count so a still-running scrape isn't misread as a
              // failure (e.g. total 988 with only 159 failed + 829 still pending).
              const pendingLine = pending > 0 ? `⏳ In progress: ${pending}\n` : '';
              const statsMessage = `:mag: *Scraping Statistics for ${siteUrl}*\n`
                + `✅ Completed: ${completed}\n`
                + `❌ Failed: ${failed}\n${
                  pendingLine
                }📊 Total: ${total}`;

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
            } else {
              // Show message when scraping check didn't return stats (e.g., no jobs found yet)
              await say(
                env,
                log,
                slackContext,
                `:mag: *Scraping Statistics for ${siteUrl}*\n`
                + ':information_source: _Scraping is in progress or no results available yet._',
              );
            }
          }
        }
      } catch (error) {
        log.warn(`Could not resolve canonical URL or parse siteUrl for data source checks: ${siteUrl}`, error);
      }
    }

    if (needsSEOImport) {
      seoImportAvailable = await isSEOImportDataAvailable(siteId, dataAccess, context);
    }

    // Determine service status for dependency checking
    const serviceStatus = {
      rum: rumAvailable,
      seoImport: seoImportAvailable,
      gsc: gscConfigured,
      scraping: scrapingAvailable,
    };

    // Determine which audits have completed vs are still pending, straight from the
    // DB audit records (not CloudWatch logs). This single source drives both the
    // in-progress (⏳) opportunity statuses and the missing-opportunity analysis, so a
    // not-yet-completed audit is reported as in progress rather than "not executed".
    // Only meaningful when we have an onboardStartTime anchor to compare against.
    let pendingAuditTypes = [];
    let completedAuditTypes = [];
    if (auditTypes && auditTypes.length > 0 && onboardStartTime) {
      try {
        const { Audit } = dataAccess;
        const latestAudits = await Audit.allLatestForSite(siteId);
        const completion = computeAuditCompletion(auditTypes, onboardStartTime, latestAudits);
        pendingAuditTypes = completion.pendingAuditTypes;
        completedAuditTypes = completion.completedAuditTypes;
      } catch (auditErr) {
        log.warn(`Could not check audit completion from DB for site ${siteId}: ${auditErr.message}`);
        // Conservative fallback: mark all as pending so nothing is misreported as
        // failed/executed and the "may still be in progress" disclaimer is shown.
        pendingAuditTypes = [...auditTypes];
        completedAuditTypes = [];
      }
    }

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
        missingOpportunitiesAnalysis = analyzeMissingOpportunities(
          missingOpportunities,
          auditTypes,
          completedAuditTypes,
          serviceStatus,
        );
      }
    }

    const statusMessages = [];

    // Data source and service precondition status
    const rumStatus = rumAvailable ? ':white_check_mark:' : ':x:';
    const seoImportStatus = seoImportAvailable ? ':white_check_mark:' : ':x:';
    const gscStatus = gscConfigured ? ':white_check_mark:' : ':x:';
    // Tri-state scraping: hourglass while URLs are still being scraped, so an
    // in-progress snapshot is not mislabelled as a failure. 'unknown' (no scrape data
    // yet) shows a neutral info icon — not ❌ (which would falsely read as failed) and
    // not ⏳ (which would overclaim active progress). Only a genuinely terminal-failed
    // scrape (0 completed, 0 pending, >0 failed) shows ❌.
    const scrapingStatusKey = deriveScrapingStatus(scrapingStats);
    const scrapingEmoji = {
      available: ':white_check_mark:',
      in_progress: ':hourglass_flowing_sand:',
      unknown: ':information_source:',
      failed: ':x:',
    }[scrapingStatusKey] || ':x:';
    const scrapingStatus = scrapingEmoji;

    statusMessages.push(`RUM ${rumStatus}`);
    statusMessages.push(`SEO Import ${seoImportStatus}`);
    statusMessages.push(`GSC ${gscStatus}`);
    statusMessages.push(`Scraping ${scrapingStatus}`);

    // Process opportunities by type to avoid duplicates
    // Only process opportunities that are expected based on the profile's audit types
    const processedTypes = new Set();
    const failedOpportunities = [];

    for (const opportunity of opportunities) {
      const opportunityType = opportunity.getType();

      // Filter opportunities to those expected by the profile's audit types.
      // Infrastructure audits without opportunity mappings are excluded from
      // expectedOpportunityTypes — only profile-mapped opportunities should appear.
      const shouldFilter = auditTypes
        && auditTypes.length > 0
        && expectedOpportunityTypes.length > 0;

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

      const opportunityTitle = getOpportunityTitle(opportunityType);

      // If the source audit is still running, show ⏳ instead of stale ✅/❌
      const sourceAuditIsPending = getAuditsForOpportunity(opportunityType)
        .some((auditType) => pendingAuditTypes.includes(auditType));

      if (sourceAuditIsPending) {
        statusMessages.push(`${opportunityTitle} :hourglass_flowing_sand:`);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const suggestions = await opportunity.getSuggestions();
        const hasSuggestions = suggestions && suggestions.length > 0;
        const status = hasSuggestions ? ':white_check_mark:' : ':x:';
        statusMessages.push(`${opportunityTitle} ${status}`);

        // Track failed opportunities (no suggestions)
        if (!hasSuggestions) {
          failedOpportunities.push({
            title: opportunityTitle,
            reason: 'Audit executed successfully, opportunity added, but found no suggestions',
          });
        }
      }
    }

    // Always show statistics sections when slackContext is available
    // statusMessages should always have at least data source statuses, but show sections regardless
    if (slackContext) {
      // Section 1: Data Sources for site (only show required dependencies)
      const dataSourceMessages = [];
      if (needsRUM) {
        dataSourceMessages.push(`RUM ${rumAvailable ? ':white_check_mark:' : ':x:'}`);
      }
      if (needsSEOImport) {
        dataSourceMessages.push(`SEO Import ${seoImportAvailable ? ':white_check_mark:' : ':x:'}`);
      }
      if (needsGSC) {
        dataSourceMessages.push(`GSC ${gscConfigured ? ':white_check_mark:' : ':x:'}`);
      }
      if (needsScraping) {
        dataSourceMessages.push(`Scraping ${scrapingEmoji}`);
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
          && !msg.includes('SEO Import')
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
          const emoji = failed.reason.includes('found no suggestions') ? ' :information_source:' : ' :x:';
          auditErrors.push(`*${failed.title}*: ${failed.reason}${emoji}`);
        }
      }

      // Add missing opportunities analysis
      if (missingOpportunitiesAnalysis.length > 0) {
        for (const analysis of missingOpportunitiesAnalysis) {
          // Hourglass for audits still running, info icon for audits that ran and
          // found nothing, error icon only for actual failures (missing dependencies).
          let emoji = ':x:';
          if (analysis.inProgress) {
            emoji = ':hourglass_flowing_sand:';
          } else if (analysis.reason.includes('found no issues to report')) {
            emoji = ':information_source:';
          }
          auditErrors.push(`*${analysis.opportunity}*: ${analysis.reason} ${emoji}`);
        }
      }

      if (auditErrors.length > 0) {
        await say(env, log, slackContext, auditErrors.join('\n'));
      } else {
        await say(env, log, slackContext, 'No audit errors found');
      }

      // Audit completion disclaimer — reuse pendingAuditTypes already computed above.
      // Only list audit types that have known opportunity mappings; infrastructure audits
      // (auto-suggest, auto-fix, scrape, etc.) are not shown since they don't affect
      // the displayed opportunity statuses.
      if (auditTypes.length > 0) {
        const isRecheck = taskContext?.isRecheck === true;
        const relevantPendingTypes = pendingAuditTypes.filter(
          (t) => getOpportunitiesForAudit(t).length > 0,
        );
        if (relevantPendingTypes.length > 0) {
          const pendingOpportunityNames = relevantPendingTypes
            .flatMap((t) => getOpportunitiesForAudit(t))
            .map(getOpportunityTitle);
          const pendingList = [...new Set(pendingOpportunityNames)].join(', ');
          await say(
            env,
            log,
            slackContext,
            `:warning: *Heads-up:* The following audit${relevantPendingTypes.length > 1 ? 's' : ''} `
            + `may still be in progress: *${pendingList}*.\n`
            + 'The statuses above reflect data available at this moment and may be incomplete. '
            + `Run \`onboard status ${siteUrl}\` to re-check once all audits have completed.`,
          );
        } else if (isRecheck && onboardStartTime) {
          await say(
            env,
            log,
            slackContext,
            ':white_check_mark: All audits have completed. The statuses above are up to date.',
          );
        }
      }
    }

    log.info(`Processed ${opportunities.length} opportunities for site ${siteId}`);

    // Build response object
    const response = {
      message: `Opportunity status processor completed for ${opportunities.length} opportunities`,
      opportunitiesProcessed: opportunities.length,
      dataSources: {
        rum: rumAvailable,
        seoImport: seoImportAvailable,
        gsc: gscConfigured,
      },
      servicePreconditions: {
        import: seoImportAvailable,
        scraping: scrapingAvailable,
      },
    };

    // Only include bot protection fields when bot protection is detected
    if (botProtectionStats !== null && botProtectionStats.totalCount > 0) {
      response.botProtectionDetected = true;
      response.blockedUrlCount = botProtectionStats.totalCount;
    }

    return ok(response);
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
