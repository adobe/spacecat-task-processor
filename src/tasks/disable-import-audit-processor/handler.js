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

const TASK_TYPE = 'disable-import-audit-processor';

/**
 * Runs the disable import and audit processor
 * @param {object} message - The message object containing siteId and auditContext
 * @param {object} context - The context object
 */
export async function runDisableImportAuditProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const {
    siteId, siteUrl, organizationId, taskContext,
  } = message;
  const { Site, Configuration } = dataAccess;
  const {
    importTypes = [], auditTypes = [], slackContext,
  } = taskContext;

  log.info('Processing disable import and audit request:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
    importTypes,
    auditTypes,
  });
  try {
    const site = await Site.findByBaseURL(siteUrl);
    if (!site) {
      throw new Error(`Site not found for siteId: ${siteId}`);
    }
    const siteConfig = site.getConfig();
    for (const importType of importTypes) {
      siteConfig.disableImport(importType);
    }

    const configuration = await Configuration.findLatest();
    for (const auditType of auditTypes) {
      configuration.disableHandlerForSite(auditType, site);
    }

    await site.save();
    await configuration.save();
    log.info(`For siteId: ${siteId}, Disabled imports and audits`);
    let slackMessage = `:broom: *For siteId: ${siteId}, Disabled imports*: ${importTypes.join(', ')} *and audits*: ${auditTypes.join(', ')}`;
    await say(env, log, slackContext, slackMessage);
    slackMessage = ':information_source: The list of enabled imports and audits may differ from the disabled ones because items that are already enabled are not automatically disabled.';
    await say(env, log, slackContext, slackMessage);
  } catch (error) {
    log.error('Error in disable import and audit processor:', error);
    await say(env, log, slackContext, `:x: Error disabling imports and audits: ${error.message}`);
  }

  return ok({ message: 'Disable import and audit processor completed' });
}

export default runDisableImportAuditProcessor;
