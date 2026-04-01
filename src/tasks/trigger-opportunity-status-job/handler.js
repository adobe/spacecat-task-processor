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
import {
  getOpportunitiesForAudit,
  getAllOpportunityTypes,
} from '../opportunity-status-processor/audit-opportunity-map.js';

const TASK_TYPE = 'trigger-opportunity-status-job';

/**
 * Derives the set of expected opportunity types from a list of audit types.
 * Falls back to all known types when no auditTypes are provided.
 *
 * @param {string[]} auditTypes
 * @returns {string[]} Unique expected opportunity types
 */
function resolveExpectedOpportunityTypes(auditTypes) {
  if (!auditTypes || auditTypes.length === 0) {
    return getAllOpportunityTypes();
  }

  const types = new Set();
  for (const auditType of auditTypes) {
    for (const oppType of getOpportunitiesForAudit(auditType)) {
      types.add(oppType);
    }
  }
  // Fall back to all known types if none of the supplied audit types are in the map
  return types.size > 0 ? [...types] : getAllOpportunityTypes();
}

/**
 * Determines whether an opportunity was updated by an audit run (as opposed to
 * just being created for the first time).
 *
 * Logic:
 *  - On first creation both createdAt and updatedAt are set to the same timestamp.
 *  - A subsequent save (e.g. by an audit worker) advances only updatedAt.
 *  - Therefore: updatedAt > createdAt  →  the opportunity was updated after creation.
 *
 * If auditRunTime is supplied we additionally require that the update happened
 * on or after that timestamp, so we only count updates from the current audit run.
 *
 * @param {object} opportunity   - Opportunity model instance
 * @param {number} [auditRunTime] - Optional epoch-ms timestamp of when the audit started
 * @returns {boolean}
 */
function wasUpdatedByAudit(opportunity, auditRunTime) {
  const createdAt = new Date(opportunity.getCreatedAt()).getTime();
  const updatedAt = new Date(opportunity.getUpdatedAt()).getTime();

  const wasUpdated = updatedAt > createdAt;
  if (!wasUpdated) {
    return false;
  }

  // If an audit run time is provided, the update must have happened at or after it
  return auditRunTime ? updatedAt >= auditRunTime : true;
}

/**
 * Runs the trigger opportunity status job processor.
 *
 * For a single site, fetches its existing opportunities and:
 *  - Derives which opportunity types are expected from the provided auditTypes
 *    (mirrors the opportunityStatusJob.taskContext.auditTypes contract)
 *  - Reports which expected opportunity types were found (with siteId and baseUrl)
 *  - Reports which expected opportunity types were NOT found
 *  - Reports which found opportunities were updated after the audit ran
 *    (updatedAt > createdAt AND updatedAt >= onboardStartTime)
 *
 * Message shape — mirrors the opportunityStatusJob contract:
 * {
 *   type: 'trigger-opportunity-status-job',
 *   siteId: string,
 *   siteUrl: string,
 *   imsOrgId: string,
 *   organizationId: string,
 *   taskContext: {
 *     auditTypes: string[],      // same list passed to opportunityStatusJob
 *     onboardStartTime: number,  // epoch-ms – same field as in opportunityStatusJob
 *     slackContext?: { channelId, threadTs }
 *   }
 * }
 *
 * @param {object} message - The SQS/direct message payload
 * @param {object} context - The universal serverless context
 */
export async function runTriggerOpportunityStatusJob(message, context) {
  const { log, dataAccess } = context;
  const {
    siteId, siteUrl, taskContext = {},
  } = message;
  const {
    auditTypes = [],
    onboardStartTime, // reuse the same field name as opportunityStatusJob
  } = taskContext;

  log.info(`[${TASK_TYPE}] Starting opportunity status scan`, {
    siteId,
    siteUrl,
    auditTypes,
    onboardStartTime: onboardStartTime ? new Date(onboardStartTime).toISOString() : 'not provided',
  });

  const { Site } = dataAccess;

  // Derive expected opportunity types from the audit types that ran
  const expectedOpportunityTypes = resolveExpectedOpportunityTypes(auditTypes);
  log.info(`[${TASK_TYPE}] Expected opportunity types: [${expectedOpportunityTypes.join(', ')}]`);

  // ── Fetch site ─────────────────────────────────────────────────────────────
  const site = await Site.findById(siteId);
  if (!site) {
    log.error(`[${TASK_TYPE}] Site not found for siteId: ${siteId}`);
    return ok({
      message: `Site not found: ${siteId}`, found: [], notFound: [], updatedByAudit: [],
    });
  }

  // ── Fetch opportunities ────────────────────────────────────────────────────
  let opportunities = [];
  try {
    opportunities = await site.getOpportunities();
  } catch (err) {
    log.error(`[${TASK_TYPE}] Failed to fetch opportunities for site ${siteId}: ${err.message}`);
  }

  // ── Categorise ────────────────────────────────────────────────────────────
  const foundByType = {};
  for (const opp of opportunities) {
    const type = opp.getType();
    if (!foundByType[type]) {
      foundByType[type] = [];
    }
    foundByType[type].push(opp);
  }

  const found = [];
  const notFound = [];
  const updatedByAudit = [];

  for (const type of expectedOpportunityTypes) {
    const oppsOfType = foundByType[type] || [];

    if (oppsOfType.length === 0) {
      notFound.push({ type, siteId, baseUrl: siteUrl });
      log.info(`[${TASK_TYPE}] NOT FOUND – type=${type} site=${siteId} (${siteUrl})`);
    } else {
      found.push({ type, siteId, baseUrl: siteUrl });
      log.info(`[${TASK_TYPE}] FOUND – type=${type} site=${siteId} (${siteUrl})`);

      // Check each opportunity of this type for audit-driven updates
      for (const opp of oppsOfType) {
        if (wasUpdatedByAudit(opp, onboardStartTime)) {
          updatedByAudit.push({
            siteId,
            baseUrl: siteUrl,
            type,
            createdAt: opp.getCreatedAt(),
            updatedAt: opp.getUpdatedAt(),
          });
          log.info(
            `[${TASK_TYPE}] UPDATED BY AUDIT – type=${type} site=${siteId} `
            + `createdAt=${opp.getCreatedAt()} updatedAt=${opp.getUpdatedAt()}`,
          );
        }
      }
    }
  }

  log.info(
    `[${TASK_TYPE}] Scan complete – found=${found.length} notFound=${notFound.length} `
    + `updatedByAudit=${updatedByAudit.length}`,
  );

  return ok({
    message: `Opportunity status scan completed for site ${siteId}`,
    siteId,
    baseUrl: siteUrl,
    expectedOpportunityTypes,
    found,
    notFound,
    updatedByAudit,
  });
}

export default runTriggerOpportunityStatusJob;
