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
export function convertAbortInfoToStats(abortInfo, isJobComplete) {
  if (!abortInfo || abortInfo.reason !== 'bot-protection') {
    return null;
  }

  const { details } = abortInfo;

  // Validate details object exists
  if (!details) {
    return null;
  }

  const blockedUrls = details.blockedUrls || [];
  const highConfidenceUrls = blockedUrls.filter((url) => (url.confidence || 0) >= 0.95);

  const stats = {
    totalCount: details.blockedUrlsCount || 0,
    byHttpStatus: details.byHttpStatus || {},
    byBlockerType: details.byBlockerType || {},
    urls: blockedUrls,
    highConfidenceCount: highConfidenceUrls.length,
    isPartial: !isJobComplete, // Flag indicating if scraping is still in progress
    totalUrlsInJob: details.totalUrlsCount || 0,
  };

  return stats;
}

/**
 * Checks for bot protection and sends Slack alert if detected
 * Queries the ScrapeJob database for abort information instead of CloudWatch logs.
 *
 * @param {Object} params - Parameters object
 * @param {string} params.jobId - The scrape job ID (from isScrapingAvailable)
 * @param {string} params.siteUrl - The site URL (for Slack message)
 * @param {Object} params.slackContext - Slack context for sending messages
 * @param {Object} params.context - Application context with env, log
 * @returns {Promise<Object|null>} Bot protection stats if detected, null otherwise
 */
export async function checkAndAlertBotProtection({
  jobId,
  siteUrl,
  slackContext,
  context,
}) {
  const { log, env } = context;

  let botProtectionStats = null;

  try {
    if (!jobId) {
      log.warn('No jobId provided for bot protection check');
      return null;
    }

    const scrapeClient = ScrapeClient.createFrom(context);
    const job = await scrapeClient.getScrapeJobStatus(jobId);

    if (!job) {
      log.debug(`Job not found: jobId=${jobId}`);
      return null;
    }

    // ScrapeClient returns a plain JSON object (via ScrapeJobDto)
    // so abortInfo is always a property, never a method
    const abortInfo = job.abortInfo || null;

    log.info(
      `[BOT-CHECK] AbortInfo read from scrape client: jobId=${jobId}, `
      + `hasAbortInfo=${!!abortInfo}, reason=${abortInfo?.reason || 'none'}, `
      + `blockedUrlsCount=${abortInfo?.details?.blockedUrlsCount || 0}, `
      + `totalUrlsCount=${abortInfo?.details?.totalUrlsCount || 0}`,
    );

    if (!abortInfo) {
      log.debug(`No abortInfo found: jobId=${jobId}`);
      return null;
    }

    if (abortInfo.reason !== 'bot-protection') {
      log.debug(
        'AbortInfo present but reason is not bot-protection: '
        + `jobId=${jobId}, reason=${abortInfo.reason}`,
      );
      return null;
    }

    // isJobComplete determines if data is partial or complete
    // - If job.status === 'COMPLETE': data is complete (isPartial = false)
    // - If job.status === 'RUNNING' or undefined: data is partial (isPartial = true)
    const isJobComplete = job.status === 'COMPLETE';
    botProtectionStats = convertAbortInfoToStats(abortInfo, isJobComplete);

    if (botProtectionStats) {
      log.info(
        `[BOT-BLOCKED] Bot protection detected: jobId=${jobId}, `
        + `siteUrl=${siteUrl}, `
        + `hasAbortInfo=${!!abortInfo}, abortInfoReason=${abortInfo?.reason || 'none'}, `
        + `blockedUrls=${botProtectionStats.totalCount}, `
        + `totalUrlsInJob=${botProtectionStats.totalUrlsInJob}, `
        + `isPartial=${botProtectionStats.isPartial} (${botProtectionStats.isPartial ? 'RUNNING' : 'COMPLETE'}), `
        + `blockedRatio=${botProtectionStats.totalCount}/${botProtectionStats.totalUrlsInJob}`,
      );
    }
  } catch (error) {
    log.error(
      `Failed to get bot protection stats from ScrapeJob: jobId=${jobId}, error=${error.message}`,
      error,
    );
    return null;
  }

  if (!botProtectionStats) {
    log.debug(`No bot protection found: jobId=${jobId}`);
    return null;
  }

  // Send Slack alert - wrap in try-catch to prevent alert failures from breaking flow
  try {
    const botIps = env.SPACECAT_BOT_IPS || '';
    const allowlistInfo = formatAllowlistMessage(botIps);

    await say(
      env,
      log,
      slackContext,
      formatBotProtectionSlackMessage({
        siteUrl,
        stats: botProtectionStats,
        allowlistIps: allowlistInfo.ips,
        allowlistUserAgent: allowlistInfo.userAgent,
      }),
    );
  } catch (slackError) {
    log.error(
      `Failed to send Slack alert: jobId=${jobId}, error=${slackError.message}`,
      slackError,
    );
  }

  return botProtectionStats;
}
