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
        SLACK_BOT_TOKEN: slackContext.slackBotToken,
        SLACK_SIGNING_SECRET: slackContext.slackSigningSecret,
        SLACK_TOKEN_WORKSPACE_INTERNAL: slackContext.slackTokenWorkspaceInternal,
        SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: slackContext.slackOpsChannelWorkspaceInternal,
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
