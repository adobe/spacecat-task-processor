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

import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import { formatAllowlistMessage } from '@adobe/spacecat-shared-utils';
import { say, formatBotProtectionSlackMessage } from './slack-utils.js';

/**
 * Converts abortInfo from database to bot protection stats format
 * @param {object} abortInfo - Abort info from ScrapeJob database
 * @param {boolean} isJobComplete - Whether the scrape job is complete
 * @returns {object} Bot protection statistics with isPartial flag
 */
export function convertAbortInfoToStats(abortInfo, isJobComplete, jobTotalUrls = null) {
  if (!abortInfo || abortInfo.reason !== 'bot-protection') {
    return null;
  }

  const { details } = abortInfo;

  // Validate details object exists
  if (!details) {
    return null;
  }

  const blockedUrls = details.blockedUrls || [];
  const totalBlockedCount = details.blockedUrlsCount || 0;
  const isSampled = details.blockedUrlsSampled === true;

  let highConfidenceCount;
  if (isSampled) {
    // Array is sampled - we can't know exact count, but since scraper only blocks >= 0.99,
    // all blocked URLs should be high confidence. Use total count as best estimate.
    highConfidenceCount = totalBlockedCount;
  } else {
    // Array is complete - count high confidence from actual URLs
    const highConfidenceUrls = blockedUrls.filter((url) => (url.confidence || 0) >= 0.95);
    highConfidenceCount = highConfidenceUrls.length;
  }

  // Use provided jobTotalUrls (from current job) if available, otherwise fall back to stored value
  // This ensures accuracy even if abortInfo was saved before job was fully initialized
  const totalUrlsInJob = jobTotalUrls !== null ? jobTotalUrls : (details.totalUrlsCount || 0);

  const stats = {
    totalCount: totalBlockedCount,
    byHttpStatus: details.byHttpStatus || {},
    byBlockerType: details.byBlockerType || {},
    urls: blockedUrls,
    highConfidenceCount,
    isPartial: !isJobComplete, // Flag indicating if scraping is still in progress
    totalUrlsInJob,
  };

  return stats;
}

/**
 * Checks bot protection for a single jobId
 * @param {string} jobId - The scrape job ID
 * @param {Object} context - Application context with env, log
 * @returns {Promise<Object|null>} Bot protection stats if detected, null otherwise
 */
async function checkBotProtectionForJob(jobId, context) {
  const { log } = context;

  try {
    if (!jobId) {
      return null;
    }

    const scrapeClient = ScrapeClient.createFrom(context);
    const job = await scrapeClient.getScrapeJobStatus(jobId);

    if (!job) {
      log.debug(`Job not found: jobId=${jobId}`);
      return null;
    }

    const abortInfo = job.abortInfo || null;

    if (!abortInfo || abortInfo.reason !== 'bot-protection') {
      return null;
    }

    const isJobComplete = job.status === 'COMPLETE';
    // Use current job's urlCount for accuracy (set at job creation, doesn't change)
    // This ensures we always have the correct total even if abortInfo was saved early
    const jobTotalUrls = job.urlCount || abortInfo.details?.totalUrlsCount || 0;
    const stats = convertAbortInfoToStats(abortInfo, isJobComplete, jobTotalUrls);

    if (stats) {
      log.info(
        `[BOT-CHECK] Bot protection found: jobId=${jobId}, `
        + `blockedUrls=${stats.totalCount}, totalUrls=${stats.totalUrlsInJob}, `
        + `isPartial=${stats.isPartial}`,
      );
    }

    return stats ? { jobId, stats, abortInfo } : null;
  } catch (error) {
    log.error(
      `Failed to get bot protection stats from ScrapeJob: jobId=${jobId}, error=${error.message}`,
      error,
    );
    return null;
  }
}

/**
 * Checks for bot protection across multiple jobIds and aggregates the results
 * Queries the ScrapeJob database for abort information instead of CloudWatch logs.
 *
 * @param {Object} params - Parameters object
 * @param {string|Array<string>} params.jobId - Single job ID (backward compat) or array of job IDs
 * @param {string} params.siteUrl - The site URL (for Slack message)
 * @param {Object} params.slackContext - Slack context for sending messages
 * @param {Object} params.context - Application context with env, log
 * @returns {Promise<Object|null>} Aggregated bot protection stats if detected, null otherwise
 */
export async function checkAndAlertBotProtection({
  jobId,
  siteUrl,
  slackContext,
  context,
}) {
  const { log, env } = context;

  // Support both single jobId (backward compat) and array of jobIds
  let jobIds = [];
  if (Array.isArray(jobId)) {
    jobIds = jobId.filter((id) => id); // Filter out falsy values
  } else if (jobId) {
    jobIds = [jobId];
  }

  if (jobIds.length === 0) {
    log.warn('No jobId(s) provided for bot protection check');
    return null;
  }

  log.info(
    `[BOT-CHECK] Checking bot protection for ${jobIds.length} jobId(s): [${jobIds.join(', ')}]`,
  );

  // Check bot protection for all jobIds in parallel
  const botProtectionResults = await Promise.all(
    jobIds.map((id) => checkBotProtectionForJob(id, context)),
  );

  // Filter out null results (jobs without bot protection)
  const jobsWithBotProtection = botProtectionResults.filter((result) => result !== null);

  if (jobsWithBotProtection.length === 0) {
    log.debug(`No bot protection found across ${jobIds.length} jobId(s)`);
    return null;
  }

  // Aggregate stats across all jobs
  const aggregatedStats = {
    totalCount: 0,
    totalUrlsInJob: 0,
    byHttpStatus: {},
    byBlockerType: {},
    urls: [],
    highConfidenceCount: 0,
    isPartial: false, // Will be true if ANY job is partial
    jobDetails: [], // Per-job breakdown
  };

  jobsWithBotProtection.forEach(({ jobId: jId, stats }) => {
    aggregatedStats.totalCount += stats.totalCount;
    aggregatedStats.totalUrlsInJob += stats.totalUrlsInJob;
    aggregatedStats.highConfidenceCount += stats.highConfidenceCount;
    aggregatedStats.isPartial = aggregatedStats.isPartial || stats.isPartial;
    aggregatedStats.urls.push(...stats.urls);

    // Merge byHttpStatus
    Object.entries(stats.byHttpStatus || {}).forEach(([status, count]) => {
      aggregatedStats.byHttpStatus[status] = (aggregatedStats.byHttpStatus[status] || 0) + count;
    });

    // Merge byBlockerType
    Object.entries(stats.byBlockerType || {}).forEach(([type, count]) => {
      aggregatedStats.byBlockerType[type] = (aggregatedStats.byBlockerType[type] || 0) + count;
    });

    // Store per-job details including URLs
    aggregatedStats.jobDetails.push({
      jobId: jId,
      blockedUrlsCount: stats.totalCount,
      totalUrlsCount: stats.totalUrlsInJob,
      isPartial: stats.isPartial,
      urls: stats.urls || [], // Store URLs for this job
    });
  });

  // Extract jobIds that have bot protection
  const botBlockedJobIds = jobsWithBotProtection.map(({ jobId: jId }) => jId);

  // Build log message
  const logMessage = `[BOT-BLOCKED] Bot protection detected across ${jobsWithBotProtection.length}/${jobIds.length} jobId(s): `
    + `siteUrl=${siteUrl}, allJobIds=[${jobIds.join(', ')}], `
    + `botBlockedJobIds=[${botBlockedJobIds.join(', ')}], `
    + `totalBlockedUrls=${aggregatedStats.totalCount}, `
    + `isPartial=${aggregatedStats.isPartial}`;

  log.info(logMessage);

  // Send Slack alert with aggregated stats
  try {
    const botIps = env.SPACECAT_BOT_IPS || '';
    const allowlistInfo = formatAllowlistMessage(botIps);

    await say(
      env,
      log,
      slackContext,
      formatBotProtectionSlackMessage({
        siteUrl,
        stats: aggregatedStats,
        allowlistIps: allowlistInfo.ips,
        allowlistUserAgent: allowlistInfo.userAgent,
        jobDetails: aggregatedStats.jobDetails,
      }),
    );
  } catch (slackError) {
    log.error(
      `Failed to send Slack alert: jobIds=[${jobIds.join(', ')}], error=${slackError.message}`,
      slackError,
    );
  }

  return aggregatedStats;
}
