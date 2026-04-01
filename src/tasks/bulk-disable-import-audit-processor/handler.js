/*
 * Copyright 2026 Adobe. All rights reserved.
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
import { Config } from '@adobe/spacecat-shared-data-access';

import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'bulk-disable-import-audit-processor';

/**
 * Runs the bulk disable import and audit processor for multiple sites.
 * Loads Configuration once and saves it once after processing all sites,
 * avoiding race conditions from concurrent per-site configuration writes.
 *
 * @param {object} message - The message object
 * @param {Array<{siteId, siteUrl, organizationId, importTypes, auditTypes, scheduledRun}>}
 *   message.sites
 * @param {object} message.taskContext
 * @param {object} message.taskContext.slackContext
 * @param {object} context - The context object
 */
export async function runBulkDisableImportAuditProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { sites = [], taskContext = {} } = message;
  const { slackContext, scheduledRun = false } = taskContext;
  const { Site, Configuration } = dataAccess;

  log.info('Processing bulk disable import and audit request:', {
    taskType: TASK_TYPE,
    siteCount: sites.length,
    scheduledRun,
  });

  if (scheduledRun) {
    log.info('Scheduled run detected - skipping bulk disable of imports and audits');
    await say(env, log, slackContext, ':information_source: Scheduled run detected - skipping bulk disable of imports and audits');
    return ok({ message: 'Scheduled run - no disable of imports and audits performed' });
  }

  if (sites.length === 0) {
    log.info('No sites to process');
    return ok({ message: 'No sites to process' });
  }

  const configuration = await Configuration.findLatest();
  const results = [];

  for (const siteEntry of sites) {
    const {
      siteUrl,
      siteId,
      importTypes = [],
      auditTypes = [],
    } = siteEntry;

    try {
      // eslint-disable-next-line no-await-in-loop
      const site = await Site.findByBaseURL(siteUrl);
      if (!site) {
        log.warn(`Site not found for siteUrl: ${siteUrl} (siteId: ${siteId})`);
        results.push({ siteUrl, status: 'not_found' });
        // eslint-disable-next-line no-continue
        continue;
      }

      const siteConfig = site.getConfig();
      for (const importType of importTypes) {
        siteConfig.disableImport(importType);
      }
      site.setConfig(Config.toDynamoItem(siteConfig));
      // eslint-disable-next-line no-await-in-loop
      await site.save();

      for (const auditType of auditTypes) {
        configuration.disableHandlerForSite(auditType, site);
      }

      log.info(`Disabled imports [${importTypes.join(', ')}] and audits [${auditTypes.join(', ')}] for site: ${siteUrl}`);
      results.push({
        siteUrl, status: 'disabled', importTypes, auditTypes,
      });
    } catch (error) {
      log.error(`Error processing site ${siteUrl}:`, error);
      results.push({ siteUrl, status: 'error', error: error.message });
    }
  }

  try {
    await configuration.save();
    log.info(`Saved configuration after processing ${sites.length} sites`);
  } catch (error) {
    log.error('Failed to save configuration:', error);
    await say(env, log, slackContext, `:x: Bulk disable: failed to save configuration after processing ${sites.length} sites: ${error.message}`);
    return ok({ message: 'Bulk disable completed with configuration save error', results });
  }

  const succeeded = results.filter((r) => r.status === 'disabled');
  const failed = results.filter((r) => r.status === 'error' || r.status === 'not_found');

  const summaryLines = succeeded.map((r) => {
    const importsText = r.importTypes?.length > 0 ? r.importTypes.join(', ') : 'None';
    const auditsText = r.auditTypes?.length > 0 ? r.auditTypes.join(', ') : 'None';
    return `:broom: *${r.siteUrl}*: disabled imports: ${importsText} | audits: ${auditsText}`;
  });

  if (summaryLines.length > 0) {
    await say(env, log, slackContext, summaryLines.join('\n'));
  }

  if (failed.length > 0) {
    const failedText = failed.map((r) => `${r.siteUrl} (${r.status})`).join(', ');
    await say(env, log, slackContext, `:warning: Bulk disable: ${failed.length} site(s) had issues: ${failedText}`);
  }

  return ok({ message: 'Bulk disable import and audit processor completed', results });
}

export default runBulkDisableImportAuditProcessor;
