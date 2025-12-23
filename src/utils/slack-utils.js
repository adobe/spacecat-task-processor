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
import { hasText, SPACECAT_BOT_USER_AGENT, SPACECAT_BOT_IPS } from '@adobe/spacecat-shared-utils';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
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
 * Formats bot protection details for Slack notifications
 * @param {Object} options - Options
 * @param {string} options.siteUrl - Site URL
 * @param {Object} options.botProtection - Bot protection details
 * @param {string} [options.auditType] - Audit type (optional, for context)
 * @param {string} [options.environment='prod'] - Environment ('prod' or 'dev')
 * @param {number} [options.blockedCount] - Number of blocked URLs (optional)
 * @param {number} [options.totalCount] - Total number of URLs (optional)
 * @returns {string} Formatted Slack message
 */
export function formatBotProtectionSlackMessage({
  siteUrl,
  botProtection,
  auditType,
  environment = 'prod',
  blockedCount,
  totalCount,
}) {
  const ips = environment === 'prod'
    ? SPACECAT_BOT_IPS.production
    : SPACECAT_BOT_IPS.development;
  const ipList = ips.map((ip) => `• \`${ip}\``).join('\n');

  const auditInfo = auditType ? ` during ${auditType} audit` : '';
  const envLabel = environment === 'prod' ? 'Production' : 'Development';

  let message = `:warning: *Bot Protection Detected${auditInfo}*\n\n`
    + `*Site:* ${siteUrl}\n`
    + `*Protection Type:* ${botProtection.type}\n`
    + `*Confidence:* ${(botProtection.confidence * 100).toFixed(0)}%\n`;

  // Add blocked count if provided
  if (blockedCount !== undefined && totalCount !== undefined) {
    const blockedPercent = ((blockedCount / totalCount) * 100).toFixed(0);
    message += `*Blocked URLs:* ${blockedCount}/${totalCount} (${blockedPercent}%)\n`;
  }

  if (botProtection.reason) {
    message += `*Reason:* ${botProtection.reason}\n`;
  }

  message += '\n'
    + '*Impact on Audit Results:*\n'
    + '• Scraper received challenge pages instead of real content\n'
    + '• Audit results may be incorrect or incomplete\n'
    + '• Opportunities may be inaccurate or missing\n'
    + '\n'
    + '*Action Required:*\n'
    + `Customer must allowlist SpaceCat in their ${botProtection.type} configuration:\n`
    + '\n'
    + '*User-Agent to allowlist:*\n'
    + `\`${SPACECAT_BOT_USER_AGENT}\`\n`
    + '\n'
    + `*${envLabel} IPs to allowlist:*\n`
    + `${ipList}\n`
    + '\n'
    + '_After allowlisting, re-run audits to get accurate results._';

  return message;
}
