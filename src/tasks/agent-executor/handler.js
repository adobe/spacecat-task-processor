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
import { hasText, isNonEmptyArray, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

import { getAgent } from '../../agents/registry.js';

const NOTIFICATION_KEYS = ['success', 'failure'];

function normalizeNotifications(source) {
  if (!isNonEmptyObject(source)) {
    return undefined;
  }

  const normalized = {};
  NOTIFICATION_KEYS.forEach((key) => {
    const value = source[key];
    if (!isNonEmptyObject(value)) {
      return;
    }

    const entry = {};
    if (hasText(value.text)) {
      entry.text = value.text;
    }
    if (isNonEmptyArray(value.blocks)) {
      entry.blocks = value.blocks;
    }
    if (isNonEmptyArray(value.attachments)) {
      entry.attachments = value.attachments;
    }

    if (Object.keys(entry).length > 0) {
      normalized[key] = entry;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Message shape:
 * {
 *   type: 'agent-executor',
 *   agentId: 'brand-profile',
 *   context: { siteId?, baseURL, provider?, model?, params? },
 *   slackContext?: { channelId, threadTs },
 *   idempotencyKey?: string
 * }
 */
export async function runAgentExecutor(message, context) {
  const { log } = context;
  const { agentId, context: agentContext } = message || {};

  if (!hasText(agentId)) {
    return badRequest('agentId is required');
  }

  const agent = getAgent(agentId);
  if (!agent) {
    return badRequest(`Unknown agentId: ${agentId}`);
  }

  // Run the agent (returns plain result object)
  const result = await agent.run(agentContext, context.env, log);
  // Optionally persist if the agent supports persistence
  let persistMeta;
  let notifications;
  if (typeof agent.persist === 'function') {
    try {
      persistMeta = await agent.persist(message, context, result);
    } catch (e) {
      log.error(`agent-executor: persist failed for agent ${agentId}`, { error: e.message });
      throw e;
    }
  }
  const payload = {
    agentId,
    context: agentContext,
    result,
  };
  if (isNonEmptyObject(persistMeta)) {
    const { notifications: persistNotifications, ...rest } = persistMeta;
    if (isNonEmptyObject(rest)) {
      payload.persistMeta = rest;
    }
    const normalized = normalizeNotifications(persistNotifications);
    if (normalized) {
      notifications = normalized;
    }
  }
  if (notifications) {
    payload.notifications = notifications;
  }
  return ok(payload);
}
