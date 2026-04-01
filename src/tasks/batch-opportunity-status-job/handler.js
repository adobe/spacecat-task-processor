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
import { resolveCanonicalUrl } from '@adobe/spacecat-shared-utils';
import { getAllOpportunityTypes } from '../opportunity-status-processor/audit-opportunity-map.js';
import {
  isRUMAvailable,
  isAHREFSImportDataAvailable,
  isScrapingAvailable,
} from '../opportunity-status-processor/handler.js';

const TASK_TYPE = 'batch-opportunity-status-job';

const EMPTY_DATA_SOURCES = {
  rum: false,
  ahrefsImport: false,
  scraping: false,
  scrapingStats: null,
};

/**
 * Checks data source availability (RUM, AHREFS Import, Scraping) for a site.
 *
 * @param {string} siteId  - Site ID
 * @param {string} siteUrl - Site base URL
 * @param {object} dataAccess - Data access layer
 * @param {object} context - Universal serverless context
 * @returns {Promise<{rum: boolean, ahrefsImport: boolean, scraping: boolean}>}
 */
async function checkDataSources(siteId, siteUrl, dataAccess, context) {
  const { log } = context;
  const dataSources = { ...EMPTY_DATA_SOURCES };

  try {
    const resolvedUrl = await resolveCanonicalUrl(siteUrl);
    if (resolvedUrl) {
      const domain = new URL(resolvedUrl).hostname;
      dataSources.rum = await isRUMAvailable(domain, context);
    }
  } catch (err) {
    log.warn(`[${TASK_TYPE}] RUM check failed for ${siteUrl}: ${err.message}`);
  }

  try {
    dataSources.ahrefsImport = await isAHREFSImportDataAvailable(siteId, dataAccess, context);
  } catch (err) {
    log.warn(`[${TASK_TYPE}] AHREFS Import check failed for ${siteUrl}: ${err.message}`);
  }

  try {
    const scrapingCheck = await isScrapingAvailable(siteUrl, context);
    dataSources.scraping = scrapingCheck.available;
    dataSources.scrapingStats = scrapingCheck.stats || null;
  } catch (err) {
    log.warn(`[${TASK_TYPE}] Scraping check failed for ${siteUrl}: ${err.message}`);
  }

  return dataSources;
}

async function processSite(message, context) {
  const { log, dataAccess } = context;
  const { siteId, siteUrl, taskContext = {} } = message;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!siteId || !siteUrl) {
    log.error(`[${TASK_TYPE}] Missing required fields: siteId=${siteId}, siteUrl=${siteUrl}`);
    return ok({
      message: 'Missing required fields: siteId and siteUrl are required',
      found: [],
      notFound: [],
      dataSources: { ...EMPTY_DATA_SOURCES },
    });
  }

  const { opportunityTypes } = taskContext;
  const opportunityTypesToCheck = (Array.isArray(opportunityTypes) && opportunityTypes.length > 0)
    ? [...new Set(opportunityTypes)]
    : getAllOpportunityTypes();

  log.info(`[${TASK_TYPE}] Processing site ${siteId} (${siteUrl})`, { opportunityTypesToCheck });

  const { Site } = dataAccess;

  // ── Fetch site ─────────────────────────────────────────────────────────────
  let site;
  try {
    site = await Site.findById(siteId);
  } catch (err) {
    log.error(`[${TASK_TYPE}] DB error fetching site ${siteId}: ${err.message}`);
    return ok({
      message: `Failed to fetch site: ${siteId}`,
      siteId,
      found: [],
      notFound: opportunityTypesToCheck.map((type) => ({ siteId, type })),
      dataSources: { ...EMPTY_DATA_SOURCES },
    });
  }

  if (!site) {
    log.error(`[${TASK_TYPE}] Site not found for siteId: ${siteId}`);
    return ok({
      message: `Site not found: ${siteId}`,
      siteId,
      found: [],
      notFound: opportunityTypesToCheck.map((type) => ({ siteId, type })),
      dataSources: { ...EMPTY_DATA_SOURCES },
    });
  }

  const baseUrl = site.getBaseURL();

  // ── Data source checks ─────────────────────────────────────────────────────
  const dataSources = await checkDataSources(siteId, siteUrl, dataAccess, context);
  log.info(`[${TASK_TYPE}] Data sources for ${siteId}:`, dataSources);

  // ── Fetch opportunities ────────────────────────────────────────────────────
  let opportunities = [];
  try {
    opportunities = await site.getOpportunities();
  } catch (err) {
    log.error(`[${TASK_TYPE}] Failed to fetch opportunities for site ${siteId}: ${err.message}`);
  }

  // Group by type for O(1) lookup
  const foundByType = {};
  for (const opp of opportunities) {
    try {
      const type = opp.getType();
      if (!foundByType[type]) foundByType[type] = [];
      foundByType[type].push(opp);
    } catch (err) {
      log.warn(`[${TASK_TYPE}] Skipping malformed opportunity for site ${siteId}: ${err.message}`);
    }
  }

  // Fetch suggestion counts for all opportunities in a single parallel pass
  const suggestionCountMap = new Map();
  await Promise.all(
    opportunities.map(async (opp) => {
      try {
        const suggestions = await opp.getSuggestions();
        suggestionCountMap.set(opp, suggestions?.length ?? 0);
      } catch (err) {
        log.warn(`[${TASK_TYPE}] Failed to fetch suggestions for site ${siteId}: ${err.message}`);
        suggestionCountMap.set(opp, 0);
      }
    }),
  );

  const found = [];
  const notFound = [];

  for (const type of opportunityTypesToCheck) {
    const oppsOfType = foundByType[type] || [];

    if (oppsOfType.length === 0) {
      notFound.push({ siteId, baseUrl, type });
      log.info(`[${TASK_TYPE}] NOT FOUND – type=${type} site=${siteId}`);
    } else {
      for (const opp of oppsOfType) {
        found.push({
          siteId,
          baseUrl,
          type,
          updatedAt: opp.getUpdatedAt(),
          suggestionCount: suggestionCountMap.get(opp) ?? 0,
        });
      }
      log.info(`[${TASK_TYPE}] FOUND – type=${type} site=${siteId} updatedAt=${oppsOfType[0].getUpdatedAt()}`);
    }
  }

  log.info(`[${TASK_TYPE}] Done – site=${siteId} found=${found.length} notFound=${notFound.length}`);

  return ok({
    message: `Batch opportunity status scan completed for site ${siteId}`,
    siteId,
    baseUrl,
    opportunityTypesChecked: opportunityTypesToCheck,
    dataSources,
    found,
    notFound,
  });
}

/**
 * Runs the batch opportunity status job processor.
 *
 * Designed to be invoked once per site via a Step Functions Map state that fans
 * out one Lambda invocation per site. Checks which opportunity types exist for
 * the site and also checks data source availability (RUM, AHREFS Import, Scraping).
 *
 * Message shape (one message per site, fanned out by the Map state):
 * {
 *   type: 'batch-opportunity-status-job',
 *   siteId: string,
 *   siteUrl: string,
 *   taskContext: {
 *     opportunityTypes?: string[],  // explicit list; falls back to all known types
 *   }
 * }
 *
 * @param {object} message - The Lambda payload
 * @param {object} context - The universal serverless context
 */
export async function runBatchOpportunityStatusJob(message, context) {
  const { log } = context;
  const { siteId, siteUrl } = message;

  try {
    return await processSite(message, context);
  } catch (err) {
    log.error(`[${TASK_TYPE}] Unexpected error for site ${siteId} (${siteUrl}): ${err.message}`, err);
    return ok({
      message: `Unexpected error processing site ${siteId}: ${err.message}`,
      siteId,
      found: [],
      notFound: [],
      dataSources: { ...EMPTY_DATA_SOURCES },
    });
  }
}

export default runBatchOpportunityStatusJob;
