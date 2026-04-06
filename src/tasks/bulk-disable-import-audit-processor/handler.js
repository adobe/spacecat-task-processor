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

import { ok, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { Config } from '@adobe/spacecat-shared-data-access';

import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'bulk-disable-import-audit-processor';
const SITE_BATCH_SIZE = 10;

async function processSiteEntry(siteEntry, Site, log) {
  const {
    siteUrl,
    siteId,
    importTypes = [],
    auditTypes = [],
    scheduledRun: siteScheduledRun = false,
  } = siteEntry;

  if (!siteUrl) {
    log.warn(`Skipping site entry with missing siteUrl (siteId: ${siteId})`);
    return { siteUrl: siteId || 'unknown', status: 'error', error: 'Missing siteUrl' };
  }

  if (siteScheduledRun) {
    log.info(`Scheduled run for site ${siteUrl} - skipping`);
    return { siteUrl, status: 'skipped' };
  }

  try {
    const site = await Site.findByBaseURL(siteUrl);
    if (!site) {
      log.warn(`Site not found for siteUrl: ${siteUrl} (siteId: ${siteId})`);
      return { siteUrl, status: 'not_found' };
    }

    const siteConfig = site.getConfig();
    for (const importType of importTypes) {
      siteConfig.disableImport(importType);
    }
    site.setConfig(Config.toDynamoItem(siteConfig));
    await site.save();

    log.info(`Disabled imports [${importTypes.join(', ')}] and audits [${auditTypes.join(', ')}] for site: ${siteUrl}`);
    return {
      site, siteUrl, importTypes, auditTypes, status: 'disabled',
    };
  } catch (error) {
    log.error(`Error processing site ${siteUrl}:`, error);
    return { siteUrl, status: 'error', error: 'Site processing failed' };
  }
}

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

  let configuration;
  try {
    configuration = await Configuration.findLatest();
  } catch (error) {
    log.error('Failed to load configuration:', error);
    await say(env, log, slackContext, ':x: Bulk disable: failed to load configuration');
    return internalServerError('Failed to load configuration');
  }

  const results = [];

  for (let i = 0; i < sites.length; i += SITE_BATCH_SIZE) {
    const batch = sites.slice(i, i + SITE_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const batchOutcomes = await Promise.allSettled(
      batch.map((siteEntry) => processSiteEntry(siteEntry, Site, log)),
    );

    for (const outcome of batchOutcomes) {
      // processSiteEntry always resolves — rejected case is a safeguard only
      const result = outcome.status === 'fulfilled'
        ? outcome.value
        : { siteUrl: 'unknown', status: 'error', error: 'Unexpected processing error' };

      if (result.status === 'disabled') {
        for (const auditType of result.auditTypes) {
          configuration.disableHandlerForSite(auditType, result.site);
        }
        results.push({
          siteUrl: result.siteUrl,
          status: 'disabled',
          importTypes: result.importTypes,
          auditTypes: result.auditTypes,
        });
      } else {
        results.push({ siteUrl: result.siteUrl, status: result.status, error: result.error });
      }
    }
  }

  try {
    await configuration.save();
    log.info(`Saved configuration after processing ${sites.length} sites`);
  } catch (error) {
    log.error('Failed to save configuration:', error);
    await say(env, log, slackContext, `:x: Bulk disable: failed to save configuration after processing ${sites.length} sites`);
    return internalServerError('Failed to save configuration');
  }

  const succeeded = results.filter((r) => r.status === 'disabled');
  const failed = results.filter((r) => r.status === 'error' || r.status === 'not_found');

  try {
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
  } catch (error) {
    log.error('Failed to send Slack summary:', error);
  }

  return ok({ message: 'Bulk disable import and audit processor completed', results });
}

export default runBulkDisableImportAuditProcessor;
