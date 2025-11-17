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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import { isNonEmptyObject, isValidUrl, isValidUUID } from '@adobe/spacecat-shared-utils';

import { readPromptFile, renderTemplate } from '../base.js';

async function callModel({
  env, log, systemPrompt, userPrompt,
}) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });
  const resp = await gpt.fetchChatCompletion(userPrompt, {
    systemPrompt,
    responseFormat: 'json_object',
  });
  const content = resp?.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content);
  } catch (e) {
    log.error('brand-profile: failed to parse model JSON response', { error: e.message, contentPreview: String(content).slice(0, 500) });
    throw new Error('brand-profile: invalid JSON returned by model');
  }
}

async function run(context, env, log) {
  const {
    baseURL,
    params = {},
  } = context;

  if (!isValidUrl(baseURL)) {
    throw new Error('brand-profile: context.baseURL is required');
  }

  const systemPrompt = readPromptFile('brand-profile/system.prompt');
  const userTemplate = readPromptFile('brand-profile/user.prompt');
  const userPrompt = renderTemplate(userTemplate, { baseURL, params: JSON.stringify(params) });

  return callModel({
    env, log, systemPrompt, userPrompt,
  });
}

async function persist(message, context, result) {
  const { log, dataAccess } = context;
  const siteId = message?.siteId;

  if (!isValidUUID(siteId)) {
    log.warn(`brand-profile persist: invalid siteId ${siteId}`);
    return;
  }

  if (!isNonEmptyObject(result)) {
    log.warn(`brand-profile persist: empty result for site ${siteId}`);
    return;
  }

  const { Site } = dataAccess;
  const site = await Site.findById(siteId);
  if (!site) {
    log.warn(`brand-profile persist: site not found ${siteId}`);
    return;
  }
  const cfg = site.getConfig();
  const before = cfg.getBrandProfile?.() || {};
  const beforeHash = before?.contentHash || null;
  cfg.updateBrandProfile(result);
  const after = cfg.getBrandProfile?.() || {};
  const afterHash = after?.contentHash || null;
  const changed = beforeHash !== afterHash;
  site.setConfig(Config.toDynamoItem(cfg));
  await site.save();

  // Emit concise summary for observability/Slack step consumers via logs
  const baseURL = message?.context?.baseURL;
  const version = after?.version;
  const summary = changed
    ? `Brand profile updated to v${version} for site ${siteId}${baseURL}.`
    : `Brand profile unchanged (v${version}) for site ${siteId}${baseURL}.`;
  log.info('brand-profile persist:', {
    siteId,
    version,
    changed,
    contentHash: afterHash,
    baseURL,
    summary,
  });
}

export default {
  id: 'brand-profile',
  run,
  persist,
};
