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

/**
 * Wikidata/Wikipedia client, bound to a site-validated entity (LLMO-6580).
 *
 * The only accepted validation signal is a strong P856 (official-website) host match
 * against the site's registrable domain. There is deliberately no by-name / fuzzy path:
 * if no candidate's official website matches the site, the pipeline produces no products.
 */

import { splitHost, MULTI_PART_TLDS, GENERIC_SECOND_LEVELS } from './brand-resolver.js';

const WIKIPEDIA_API_BASE = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)';

// Upper bound on any single Wikidata/Wikipedia round trip. findValidatedWikidataEntity
// issues several serial calls, so an unbounded hang on any one would stall the whole task.
const EXTERNAL_FETCH_TIMEOUT_MS = 10000;

/**
 * fetch() with an AbortController timeout so a hung upstream cannot stall the task.
 * Mirrors the pattern in brand-resolver.fetchSiteName.
 * @param {string} url - Request URL
 * @param {object} [options] - fetch options (headers, etc.)
 * @returns {Promise<Response>}
 */
async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this registrable domain actually a bare public suffix (no registrable label in front)?
 * Such a domain must never produce a P856 match, or any foreign entity on the same suffix
 * would validate against the site (LLMO-6580). Mirrors the public-suffix logic in
 * `splitHost`: an explicit multi-part TLD (`co.uk`) OR the generalized two-label
 * `<generic>.<2-char ccTLD>` shape (`com.my`, `co.th`, `gov.in`) is a bare suffix.
 * @param {string} domain - Registrable domain
 * @returns {boolean}
 */
function isBareSuffix(domain) {
  const labels = String(domain || '')
    .toLowerCase()
    .split('.')
    .filter(Boolean);
  if (labels.length < 2) {
    return true;
  }
  if (MULTI_PART_TLDS.has(labels.join('.'))) {
    return true;
  }
  if (labels.length === 2) {
    const [secondLevel, tld] = labels;
    if (tld.length === 2 && GENERIC_SECOND_LEVELS.has(secondLevel)) {
      return true;
    }
  }
  return false;
}

/**
 * Fetch a Wikidata entity's ground truth: its English label, its own English Wikipedia
 * article title, and the hosts of its official website (P856).
 * @param {string} entityId - Wikidata entity ID (e.g., "Q489815")
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} { id, label, enwikiTitle, officialWebsiteHosts } or null
 */
export async function getWikidataEntity(entityId, log) {
  log.info(`Fetching Wikidata entity: ${entityId}`);

  try {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: entityId,
      props: 'labels|sitelinks|claims',
      languages: 'en',
      sitefilter: 'enwiki',
      format: 'json',
    });

    const url = `${WIKIDATA_API}?${params}`;
    const resp = await timedFetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`Wikidata entity fetch failed: ${resp.status}`);
    }

    const data = await resp.json();
    const entity = data.entities?.[entityId];
    if (!entity) {
      log.info(`No Wikidata entity data for: ${entityId}`);
      return null;
    }

    const label = entity.labels?.en?.value || null;
    const enwikiTitle = entity.sitelinks?.enwiki?.title || null;

    const officialWebsiteHosts = (entity.claims?.P856 || [])
      .map((claim) => claim?.mainsnak?.datavalue?.value)
      .filter(Boolean)
      .map((websiteUrl) => {
        try {
          return new URL(websiteUrl).hostname;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      id: entityId,
      label,
      enwikiTitle,
      officialWebsiteHosts,
    };
  } catch (e) {
    log.error(`Error fetching Wikidata entity ${entityId}: ${e.message}`);
    return null;
  }
}

/**
 * Validate a Wikidata entity against the customer's site via a strong P856 match:
 * any official-website host's registrable domain equals the site's registrable domain
 * (DHL->dhl.com, DNP->dnp.co.jp). This is the only accepted signal; a bare public-suffix
 * site domain (e.g. `co.uk`) never matches. No by-name / label fallback (LLMO-6580).
 *
 * @param {object} params - Parameters
 * @param {object} params.entity - Entity from {@link getWikidataEntity}
 * @param {string} params.registrableDomain - Site registrable domain
 * @returns {{ok: boolean, method: (string|null), reason: string}}
 */
export function validateEntityAgainstSite({ entity, registrableDomain }) {
  if (!entity) {
    return { ok: false, method: null, reason: 'no_entity' };
  }

  if (isBareSuffix(registrableDomain)) {
    return { ok: false, method: null, reason: 'no_match' };
  }

  const hosts = entity.officialWebsiteHosts || [];
  for (const host of hosts) {
    const { registrableDomain: entityRegDomain } = splitHost(host);
    if (
      entityRegDomain
      && registrableDomain
      && entityRegDomain === registrableDomain
    ) {
      return {
        ok: true,
        method: 'p856',
        reason: `P856 host ${host} matches site ${registrableDomain}`,
      };
    }
  }

  return { ok: false, method: null, reason: 'no_match' };
}

/**
 * Search Wikidata for candidate entity IDs by name (keeps ALL candidates for validation).
 * @param {string} brandName - Brand name to search for
 * @param {object} log - Logger instance
 * @returns {Promise<string[]>} Candidate entity IDs (order preserved)
 */
async function searchWikidataCandidates(brandName, log) {
  try {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: brandName,
      language: 'en',
      limit: '5',
      format: 'json',
    });

    const url = `${WIKIDATA_API}?${params}`;
    const resp = await timedFetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`Wikidata search failed: ${resp.status}`);
    }

    const data = await resp.json();
    return (data.search || []).map((e) => e.id).filter(Boolean);
  } catch (e) {
    log.error(`Error searching Wikidata candidates: ${e.message}`);
    return [];
  }
}

/**
 * Find the first Wikidata entity that VALIDATES against the site by a strong P856 match.
 * Returns null if nothing validates.
 *
 * @param {object} params - { brandName, registrableDomain }
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} Entity (+ `validation: 'p856'`) or null
 */
export async function findValidatedWikidataEntity(
  { brandName, registrableDomain },
  log,
) {
  const candidateIds = await searchWikidataCandidates(brandName, log);
  if (candidateIds.length === 0) {
    log.info(`No Wikidata candidates for: ${brandName}`);
    return null;
  }

  for (const id of candidateIds) {
    // eslint-disable-next-line no-await-in-loop
    const entity = await getWikidataEntity(id, log);
    const validation = entity
      ? validateEntityAgainstSite({ entity, registrableDomain })
      : { ok: false, method: null, reason: 'entity_fetch_failed' };

    if (validation.ok && validation.method === 'p856') {
      log.info(`Validated Wikidata entity ${id} for "${brandName}" via P856`);
      return { ...entity, validation: 'p856' };
    }
    log.info(
      `Rejected Wikidata candidate ${id} for "${brandName}": ${validation.reason}`,
    );
  }

  return null;
}

/**
 * Fetch a Wikipedia extract for an EXACT enwiki title (no opensearch, no by-name search).
 * The title comes from a validated entity's sitelink.
 * @param {string} title - Exact enwiki article title (from a validated entity sitelink)
 * @param {number} [maxChars=12000] - Maximum characters to return
 * @param {object} log - Logger instance
 * @returns {Promise<string|null>} Article extract or null
 */
export async function fetchWikipediaExtractByTitle(title, maxChars, log) {
  const limit = maxChars || 12000;
  if (!title) {
    return null;
  }
  log.info(
    `Fetching Wikipedia extract for exact title "${title}" (max ${limit} chars)`,
  );

  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'extracts',
      explaintext: 'true',
      format: 'json',
    });

    const url = `${WIKIPEDIA_API_BASE}?${params}`;
    const resp = await timedFetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`Wikipedia extract fetch failed: ${resp.status}`);
    }

    const data = await resp.json();
    const pages = data.query?.pages || {};
    const pageId = Object.keys(pages)[0];

    if (!pageId || pageId === '-1') {
      return null;
    }

    const extract = pages[pageId].extract || '';
    return extract.slice(0, limit);
  } catch (e) {
    log.error(`Error fetching Wikipedia extract by title: ${e.message}`);
    return null;
  }
}

/**
 * Fetch a validated intro summary: resolve+validate the entity, then fetch the intro
 * extract for that entity's EXACT enwiki title. Returns null when nothing validates or
 * the entity has no English Wikipedia article.
 * @param {object} params - { brandName, registrableDomain }
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} { title, summary, entityId } or null
 */
export async function fetchValidatedSummary(
  { brandName, registrableDomain },
  log,
) {
  const entity = await findValidatedWikidataEntity(
    { brandName, registrableDomain },
    log,
  );

  if (!entity || !entity.enwikiTitle) {
    return null;
  }

  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: entity.enwikiTitle,
      prop: 'extracts',
      exintro: 'true',
      explaintext: 'true',
      format: 'json',
    });

    const url = `${WIKIPEDIA_API_BASE}?${params}`;
    const resp = await timedFetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`Wikipedia validated summary fetch failed: ${resp.status}`);
    }

    const data = await resp.json();
    const pages = data.query?.pages || {};
    const pageId = Object.keys(pages)[0];

    if (!pageId || pageId === '-1') {
      return null;
    }

    return {
      title: entity.enwikiTitle,
      summary: pages[pageId].extract || '',
      entityId: entity.id,
    };
  } catch (e) {
    log.error(`Error fetching validated summary: ${e.message}`);
    return null;
  }
}

/**
 * Create a Wikipedia service instance (entity-bound methods only).
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createWikipediaService(log) {
  return {
    getWikidataEntity: (entityId) => getWikidataEntity(entityId, log),
    findValidatedWikidataEntity: (params) => findValidatedWikidataEntity(params, log),
    fetchExtractByTitle: (title, maxChars) => fetchWikipediaExtractByTitle(title, maxChars, log),
    fetchValidatedSummary: (params) => fetchValidatedSummary(params, log),
  };
}
