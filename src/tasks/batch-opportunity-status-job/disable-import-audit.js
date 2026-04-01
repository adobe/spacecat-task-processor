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
import { Config } from '@adobe/spacecat-shared-data-access';

const TASK_TYPE = 'batch-disable-import-audit-job';

/**
 * Disables the specified import types and audit handlers for a single site.
 *
 * @param {string} siteId
 * @param {string} baseUrl
 * @param {string[]} importTypes
 * @param {string[]} auditTypes
 * @param {object} dataAccess
 * @param {object} log
 * @returns {Promise<{siteId: string, baseUrl: string, disabled: boolean, reason?: string}>}
 */
async function disableSite(siteId, baseUrl, importTypes, auditTypes, dataAccess, log) {
  const { Site, Configuration } = dataAccess;

  let site;
  try {
    site = await Site.findById(siteId);
  } catch (err) {
    log.error(`[${TASK_TYPE}] Failed to fetch site ${siteId}: ${err.message}`);
    return {
      siteId, baseUrl, disabled: false, reason: `DB error: ${err.message}`,
    };
  }

  if (!site) {
    log.warn(`[${TASK_TYPE}] Site not found: ${siteId}`);
    return {
      siteId, baseUrl, disabled: false, reason: 'site not found',
    };
  }

  try {
    const siteConfig = site.getConfig();
    for (const importType of importTypes) {
      siteConfig.disableImport(importType);
    }
    site.setConfig(Config.toDynamoItem(siteConfig));

    const configuration = await Configuration.findLatest();
    for (const auditType of auditTypes) {
      configuration.disableHandlerForSite(auditType, site);
    }

    await site.save();
    await configuration.save();

    log.info(`[${TASK_TYPE}] Disabled imports=[${importTypes}] audits=[${auditTypes}] for site ${siteId} (${baseUrl})`);
    return { siteId, baseUrl, disabled: true };
  } catch (err) {
    log.error(`[${TASK_TYPE}] Failed to disable site ${siteId}: ${err.message}`);
    return {
      siteId, baseUrl, disabled: false, reason: err.message,
    };
  }
}

/**
 * Runs the batch disable-import-and-audit job.
 *
 * Invoked by the Step Functions workflow after the per-site Map state completes.
 * Iterates over all site results, disables the specified import types and audit
 * handlers for each site, then passes the original siteResults through unchanged
 * so the downstream notifier can format its Slack summary.
 *
 * Skips all disabling when taskContext.scheduledRun is true.
 *
 * Message shape (sent by SFN after the Map state):
 * {
 *   type: 'batch-disable-import-audit-job',
 *   siteResults: Array<{ result: { siteId, baseUrl, found[], notFound[], dataSources } }>,
 *   taskContext: {
 *     importTypes: string[],   // import types to disable for every site
 *     auditTypes: string[],    // audit handlers to disable for every site
 *     scheduledRun: boolean,   // when true, skip all disabling
 *     slackContext?: { channelId: string, threadTs: string }
 *   }
 * }
 *
 * @param {object} message - Lambda payload from the SFN
 * @param {object} context - Universal serverless context
 */
export async function runBatchDisableImportAuditJob(message, context) {
  const { log, dataAccess } = context;
  const { siteResults = [], taskContext = {} } = message;
  const {
    importTypes = [],
    auditTypes = [],
    scheduledRun = false,
  } = taskContext;

  const sites = Array.isArray(siteResults)
    ? siteResults.map((item) => item?.result).filter(Boolean)
    : [];

  log.info(`[${TASK_TYPE}] Starting — sites=${sites.length} scheduledRun=${scheduledRun}`, {
    importTypes,
    auditTypes,
  });

  if (scheduledRun) {
    log.info(`[${TASK_TYPE}] Scheduled run — skipping disable of imports and audits`);
    return ok({
      message: 'Scheduled run — no imports or audits disabled',
      siteResults,
      disableResults: [],
    });
  }

  if (importTypes.length === 0 && auditTypes.length === 0) {
    log.info(`[${TASK_TYPE}] No importTypes or auditTypes specified — nothing to disable`);
    return ok({ message: 'Nothing to disable', siteResults, disableResults: [] });
  }

  // Process sites sequentially to avoid hammering the DB with parallel config saves
  const disableResults = [];
  for (const site of sites) {
    // eslint-disable-next-line no-await-in-loop
    const result = await disableSite(
      site.siteId,
      site.baseUrl,
      importTypes,
      auditTypes,
      dataAccess,
      log,
    );
    disableResults.push(result);
  }

  const succeeded = disableResults.filter((r) => r.disabled).length;
  const failed = disableResults.filter((r) => !r.disabled).length;

  log.info(`[${TASK_TYPE}] Done — disabled=${succeeded} failed=${failed}`);

  return ok({
    message: `Batch disable completed: ${succeeded} succeeded, ${failed} failed`,
    siteResults, // pass-through for the downstream notifier
    disableResults,
  });
}

export default runBatchDisableImportAuditJob;
