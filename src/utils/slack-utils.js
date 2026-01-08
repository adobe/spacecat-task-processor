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

// eslint-disable-next-line import/no-unresolved
import { hasText } from '@adobe/spacecat-shared-utils';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { formatHttpStatus, formatBlockerType } from './cloudwatch-utils.js';
/**
 * Sends a message to Slack using the provided client and context
 * @param {object} slackClient - The Slack client instance
 * @param {object} slackContext - The Slack context containing channelId and threadTs
 * @param {string} message - The message text to send
 * @returns {Promise<void>}
 */
export async function say(env, log, slackContext, message) {
  try {
    const slackClientContext = {
      channelId: slackContext.channelId,
      threadTs: slackContext.threadTs,
      env: {
        SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
        SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
        SLACK_TOKEN_WORKSPACE_INTERNAL: env.SLACK_TOKEN_WORKSPACE_INTERNAL,
        SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: env.SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL,
      },
    };
    const slackTarget = SLACK_TARGETS.WORKSPACE_INTERNAL;
    const slackClient = BaseSlackClient.createFrom(slackClientContext, slackTarget);
    if (hasText(slackContext.threadTs) && hasText(slackContext.channelId)) {
      await slackClient.postMessage({
        channel: slackContext.channelId,
        thread_ts: slackContext.threadTs,
        text: message,
        unfurl_links: false,
      });
    }
  } catch (error) {
    log.error('Error sending Slack message:', {
      error: error.message,
      stack: error.stack,
      errorType: error.name,
    });
  }
}

/**
 * Formats bot protection details for Slack notifications with detailed statistics
 * @param {Object} options - Options
 * @param {string} options.siteUrl - Site URL
 * @param {Object} options.stats - Bot protection statistics (from aggregateBotProtectionStats)
 * @param {number} options.totalUrlCount - Total number of URLs scraped
 * @param {Array<string>} options.allowlistIps - Array of IPs to allowlist
 * @param {string} options.allowlistUserAgent - User-Agent to allowlist
 * @returns {string} Formatted Slack message
 */
export function formatBotProtectionSlackMessage({
  siteUrl,
  stats,
  totalUrlCount,
  allowlistIps = [],
  allowlistUserAgent,
}) {
  const {
    totalCount,
    byHttpStatus,
    byBlockerType,
    urls,
    highConfidenceCount,
  } = stats;

  const percentage = ((totalCount / totalUrlCount) * 100).toFixed(0);

  // Format HTTP status breakdown
  const statusBreakdown = Object.entries(byHttpStatus)
    .sort((a, b) => b[1] - a[1]) // Sort by count descending
    .map(([status, count]) => `  • ${formatHttpStatus(status)}: ${count} URL${count > 1 ? 's' : ''}`)
    .join('\n');

  // Format blocker type breakdown
  const blockerBreakdown = Object.entries(byBlockerType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `  • ${formatBlockerType(type)}: ${count} URL${count > 1 ? 's' : ''}`)
    .join('\n');

  // Sample URLs (show up to 3, prioritize high confidence)
  const sampleUrls = urls
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 3)
    .map((u) => {
      const confidenceLabel = u.confidence >= 0.95 ? '(high confidence)' : '';
      return `  • ${u.url}\n    ${formatHttpStatus(u.httpStatus)} · ${formatBlockerType(u.blockerType)} ${confidenceLabel}`;
    })
    .join('\n');

  const ipList = allowlistIps.map((ip) => `  • \`${ip}\``).join('\n');

  let message = ':warning: *Bot Protection Detected*\n\n'
    + `*Summary:* ${totalCount} of ${totalUrlCount} URLs (${percentage}%) are blocked\n\n`
    + '*📊 Detection Statistics*\n'
    + `• *Total Blocked:* ${totalCount} URLs\n`
    + `• *High Confidence:* ${highConfidenceCount} URLs\n\n`
    + '*By HTTP Status:*\n'
    + `${statusBreakdown || '  • No status data available'}\n\n`
    + '*By Blocker Type:*\n'
    + `${blockerBreakdown || '  • No blocker data available'}\n\n`
    + '*🔍 Sample Blocked URLs*\n'
    + `${sampleUrls || '  • No URL details available'}\n`;

  if (totalCount > 3) {
    message += `  ... and ${totalCount - 3} more URLs\n`;
  }

  message += '\n'
    + '*✅ How to Resolve*\n'
    + 'Allowlist SpaceCat Bot in your CDN/WAF:\n\n'
    + '*User-Agent:*\n'
    + `  • \`${allowlistUserAgent}\`\n\n`
    + '*IP Addresses:*\n'
    + `${ipList}\n\n`
    + `*Site:* ${siteUrl}\n\n`
    + ':bulb: _After allowlisting, re-run onboarding or trigger a new scrape._';

  return message;
}
