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
import { ok, badRequest } from '@adobe/spacecat-shared-http-utils';
import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { say } from '../../utils/slack-utils.js';

/**
 * Message shape:
 * {
 *   type: 'slack-notify',
 *   slackContext: { channelId, threadTs },
 *   text: 'message text',
 *   blocks?: [...]
 * }
 */
export async function runSlackNotify(message, context) {
  const slackContext = message?.slackContext;
  const payload = isNonEmptyObject(message?.message) ? message.message : {};
  const hasPayloadText = typeof payload.text === 'string' && payload.text.length > 0;
  const rawText = hasPayloadText ? payload.text : message?.text;
  const text = hasText(rawText) ? rawText : '';
  const blocksSource = Array.isArray(payload?.blocks) && payload.blocks.length > 0
    ? payload.blocks
    : message?.blocks;
  const attachmentsSource = Array.isArray(payload?.attachments) && payload.attachments.length > 0
    ? payload.attachments
    : message?.attachments;
  const blocks = Array.isArray(blocksSource) ? blocksSource : [];
  const attachments = Array.isArray(attachmentsSource) ? attachmentsSource : [];
  const hasStructuredPayload = blocks.length > 0 || attachments.length > 0;

  if (!hasText(slackContext?.channelId)) {
    return badRequest('slackContext.channelId is required');
  }

  if (!hasStructuredPayload && !hasText(text)) {
    return badRequest('text is required when no blocks or attachments are provided');
  }

  // Prefer the shared say() utility for simple text notifications
  if (!hasStructuredPayload) {
    await say(context.env, context.log, slackContext, text);
  } else {
    // Fallback for advanced block messages
    const client = BaseSlackClient.createFrom(context, SLACK_TARGETS.WORKSPACE_INTERNAL);
    const messageBody = {
      channel: slackContext.channelId,
      thread_ts: slackContext.threadTs,
      text: hasText(text) ? text : ' ',
    };
    if (blocks.length > 0) {
      messageBody.blocks = blocks;
    }
    if (attachments.length > 0) {
      messageBody.attachments = attachments;
    }
    await client.postMessage(messageBody);
  }
  return ok({ status: 'sent' });
}
