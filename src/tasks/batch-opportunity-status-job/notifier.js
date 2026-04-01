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
import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'batch-opportunity-status-notifier';

/**
 * Formats the scraping status line, appending stats if available.
 * @param {boolean} available
 * @param {object|null} stats - { completed, failed, total }
 * @returns {string}
 */
function formatScrapingLine(available, stats) {
  const icon = available ? ':white_check_mark:' : ':x:';
  if (!stats) return `Scraping: ${icon}`;
  const { completed, failed, total } = stats;
  const detail = failed > 0
    ? `_(${completed} / ${total} complete, ${failed} failed)_`
    : `_(${completed} / ${total} complete)_`;
  return `Scraping: ${icon} ${detail}`;
}

/**
 * Formats a consolidated Slack summary from all site results returned by the
 * batch-opportunity-status-job Map state.
 *
 * Each entry in siteResults comes from the SFN ResultSelector:
 *   { "result": { siteId, baseUrl, found[], notFound[], dataSources } }
 *
 * @param {Array} siteResults - Array of per-site result wrappers from the Map state
 * @returns {string} Formatted Slack message
 */
function formatSlackSummary(siteResults) {
  // Unwrap results — SiteFailed entries have no result, skip them
  const results = siteResults
    .map((item) => item?.result)
    .filter(Boolean);

  if (results.length === 0) {
    return ':warning: No site results available.';
  }

  const blocks = [];

  for (const site of results) {
    const lines = [];

    lines.push(`*Batch Run Status Report for ${site.baseUrl} (${site.siteId})*`);

    // Scraping Status block
    lines.push('');
    lines.push('*Scraping Status:*');
    if (site.dataSources) {
      const {
        rum, ahrefsImport, scraping, scrapingStats,
      } = site.dataSources;
      lines.push(`RUM: ${rum ? ':white_check_mark:' : ':x:'}`);
      lines.push(`AHREFS Import: ${ahrefsImport ? ':white_check_mark:' : ':x:'}`);
      lines.push(formatScrapingLine(scraping, scrapingStats));
    }

    // Opportunity Status block
    lines.push('');
    lines.push('*Opportunity Status:*');
    if (site.found?.length > 0) {
      for (const f of site.found) {
        lines.push(`:white_check_mark: ${f.type} — \`${f.updatedAt}\` — Suggestions: ${f.suggestionCount ?? 0}`);
      }
    }
    if (site.notFound?.length > 0) {
      for (const f of site.notFound) {
        lines.push(`:x: ${f.type}`);
      }
    }
    if (!site.found?.length && !site.notFound?.length) {
      lines.push('_No opportunity data available._');
    }

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

/**
 * Runs the batch opportunity status notifier.
 *
 * Receives the aggregated Map state output from the batch-workflow SFN,
 * formats a single consolidated Slack message, and posts it to the provided channel.
 *
 * Message shape (sent by the SFN SendSlackSummary state):
 * {
 *   type: 'batch-opportunity-status-notifier',
 *   siteResults: Array<{ result: { siteId, baseUrl, found[], notFound[], dataSources } }>,
 *   slackContext: { channelId: string, threadTs: string }
 * }
 *
 * @param {object} message - The Lambda payload from the SFN
 * @param {object} context - The universal serverless context
 */
export async function runBatchOpportunityStatusNotifier(message, context) {
  const { log, env } = context;
  const { siteResults = [], slackContext } = message;

  const sitesReported = Array.isArray(siteResults)
    ? siteResults.filter((item) => item?.result).length
    : 0;

  if (!slackContext?.channelId) {
    log.warn(`[${TASK_TYPE}] No slackContext provided, skipping Slack notification`);
    return ok({ message: 'Slack notification skipped: no channel provided', sitesReported });
  }

  log.info(`[${TASK_TYPE}] Formatting Slack summary for ${sitesReported} site result(s)`);

  let summary;
  try {
    summary = formatSlackSummary(Array.isArray(siteResults) ? siteResults : []);
  } catch (err) {
    log.error(`[${TASK_TYPE}] Failed to format Slack summary: ${err.message}`, err);
    summary = ':warning: Batch run completed but report formatting failed.';
  }

  try {
    await say(env, log, slackContext, summary);
    log.info(`[${TASK_TYPE}] Slack summary sent to channel ${slackContext.channelId}`);
  } catch (err) {
    log.error(`[${TASK_TYPE}] Failed to send Slack message: ${err.message}`, err);
  }

  return ok({
    message: 'Batch opportunity status notification sent',
    sitesReported,
  });
}

export default runBatchOpportunityStatusNotifier;
