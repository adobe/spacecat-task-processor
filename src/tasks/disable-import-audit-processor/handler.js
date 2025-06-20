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
    // Database operations
    log.info('Starting database operations');
    const site = await Site.findByBaseURL(siteUrl);
    if (!site) {
      throw new Error(`Site not found for siteId: ${siteId}`);
    }
    const siteConfig = site.getConfig();
    for (const importType of importTypes) {
      log.info(`:broom: Disabling import type: ${importType}`);
      siteConfig.disableImport(importType);
    }
    log.info('Import types disabled');

    const configuration = await Configuration.findLatest();
    for (const auditType of auditTypes) {
      log.info(`:broom: Disabling audit type: ${auditType}`);
      configuration.disableHandlerForSite(auditType, site);
    }
    log.info('Audit types disabled');

    await site.save();
    await configuration.save();
    log.info('Database changes saved successfully');

    const slackMessage = `:broom: *Disabled imports*: ${importTypes.join(', ')} *and audits*: ${auditTypes.join(', ')}`;
    await say(env, log, slackContext, slackMessage);
  } catch (error) {
    log.error('Error in disable import and audit processor:', {
      error: error.message,
      stack: error.stack,
      errorType: error.name,
    });
  }
}

export default runDisableImportAuditProcessor;
