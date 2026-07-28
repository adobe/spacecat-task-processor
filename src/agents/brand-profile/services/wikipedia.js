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
 * Wikipedia/Wikidata client for fetching brand information.
 */

import { splitHost } from './brand-resolver.js';

const WIKIPEDIA_API_BASE = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)';

// Corporate suffixes stripped before comparing an entity label to a brand name.
const CORP_SUFFIXES = /\b(inc|corp|corporation|co|ltd|limited|llc|gmbh|ag|sa|plc|nv|kk|group|holdings?|company)\b/gi;

/**
 * Fetch Wikipedia summary for a brand.
 * @param {string} searchQuery - Search query (e.g., "Swiss Life company")
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Wikipedia result with title, summary, and pageId
 */
export async function fetchWikipediaSummary(searchQuery, log) {
  log.info(`Fetching Wikipedia summary for: ${searchQuery}`);

  try {
    // First, search for the page
    const searchParams = new URLSearchParams({
      action: 'opensearch',
      search: searchQuery,
      limit: '5',
      namespace: '0',
      format: 'json',
    });

    const searchUrl = `${WIKIPEDIA_API_BASE}?${searchParams}`;
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!searchResp.ok) {
      throw new Error(`Wikipedia search failed: ${searchResp.status}`);
    }

    const searchData = await searchResp.json();
    const titles = searchData[1] || [];

    if (titles.length === 0) {
      log.info(`No Wikipedia results found for: ${searchQuery}`);
      return null;
    }

    // Use the first result
    const title = titles[0];

    // Now fetch the summary
    const summaryParams = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'extracts|pageprops',
      exintro: 'true',
      explaintext: 'true',
      ppprop: 'wikibase_item',
      format: 'json',
    });

    const summaryUrl = `${WIKIPEDIA_API_BASE}?${summaryParams}`;
    const summaryResp = await fetch(summaryUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!summaryResp.ok) {
      throw new Error(`Wikipedia summary fetch failed: ${summaryResp.status}`);
    }

    const summaryData = await summaryResp.json();
    const pages = summaryData.query?.pages || {};
    const pageId = Object.keys(pages)[0];

    if (!pageId || pageId === '-1') {
      log.info(`Wikipedia page not found for: ${title}`);
      return null;
    }

    const page = pages[pageId];
    const wikidataId = page.pageprops?.wikibase_item || null;

    log.info(`Found Wikipedia summary for "${title}" (wikidata: ${wikidataId})`);

    return {
      title: page.title,
      summary: page.extract || '',
      pageId: parseInt(pageId, 10),
      wikidataId,
    };
  } catch (e) {
    log.error(`Error fetching Wikipedia summary: ${e.message}`);
    return null;
  }
}

/**
 * Fetch full Wikipedia article text for deeper extraction.
 * @deprecated LLMO-6580: this does an unbound `opensearch` by name and blindly takes
 * `titles[0]`, which let acronyms fuzzy-match foreign articles (d*->"D-Company").
 * Use {@link fetchWikipediaExtractByTitle} with a validated entity's exact enwiki title.
 * @param {string} searchQuery - Search query
 * @param {number} [maxChars=12000] - Maximum characters to return
 * @param {object} log - Logger instance
 * @returns {Promise<string|null>} Article text or null
 */
export async function fetchWikipediaFullText(searchQuery, maxChars, log) {
  const limit = maxChars || 12000;
  log.info(`Fetching full Wikipedia text for: ${searchQuery} (max ${limit} chars)`);

  try {
    // Search for the page first
    const searchParams = new URLSearchParams({
      action: 'opensearch',
      search: searchQuery,
      limit: '1',
      namespace: '0',
      format: 'json',
    });

    const searchUrl = `${WIKIPEDIA_API_BASE}?${searchParams}`;
    const searchResp = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!searchResp.ok) {
      throw new Error(`Wikipedia search failed: ${searchResp.status}`);
    }

    const searchData = await searchResp.json();
    const titles = searchData[1] || [];

    if (titles.length === 0) {
      log.info(`No Wikipedia results found for: ${searchQuery}`);
      return null;
    }

    const title = titles[0];

    // Fetch full extract
    const contentParams = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'extracts',
      explaintext: 'true',
      format: 'json',
    });

    const contentUrl = `${WIKIPEDIA_API_BASE}?${contentParams}`;
    const contentResp = await fetch(contentUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!contentResp.ok) {
      throw new Error(`Wikipedia content fetch failed: ${contentResp.status}`);
    }

    const contentData = await contentResp.json();
    const pages = contentData.query?.pages || {};
    const pageId = Object.keys(pages)[0];

    if (!pageId || pageId === '-1') {
      return null;
    }

    const extract = pages[pageId].extract || '';
    const truncated = extract.slice(0, limit);

    log.info(`Fetched ${truncated.length} chars of Wikipedia text for "${title}"`);

    return truncated;
  } catch (e) {
    log.error(`Error fetching Wikipedia full text: ${e.message}`);
    return null;
  }
}

/**
 * Find a brand's Wikidata ID by name.
 * @deprecated LLMO-6580: returns an entity by fuzzy name match with no validation
 * against the customer's site. Use {@link findValidatedWikidataEntity} instead.
 * @param {string} brandName - Brand name to search for
 * @param {object} log - Logger instance
 * @returns {Promise<string|null>} Wikidata entity ID (e.g., "Q217994") or null
 */
export async function findWikidataId(brandName, log) {
  log.info(`Searching Wikidata for: ${brandName}`);

  try {
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: brandName,
      language: 'en',
      limit: '5',
      format: 'json',
    });

    const url = `${WIKIDATA_API}?${params}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`Wikidata search failed: ${resp.status}`);
    }

    const data = await resp.json();
    const results = data.search || [];

    if (results.length === 0) {
      log.info(`No Wikidata entity found for: ${brandName}`);
      return null;
    }

    // Look for the best match (company/brand/organization)
    const companyTerms = [
      'company', 'brand', 'manufacturer', 'corporation',
      'automaker', 'enterprise', 'business', 'organization',
      'subsidiary', 'division',
    ];

    for (const entity of results) {
      const description = (entity.description || '').toLowerCase();
      if (companyTerms.some((term) => description.includes(term))) {
        log.info(`Found Wikidata entity: ${entity.id} - ${description}`);
        return entity.id;
      }
    }

    // If no company found, return the first result
    const firstResult = results[0].id;
    log.info(`Using first Wikidata result: ${firstResult}`);
    return firstResult;
  } catch (e) {
    log.error(`Error searching Wikidata: ${e.message}`);
    return null;
  }
}

/**
 * Fetch a Wikidata entity's ground truth: its English label/aliases, its own
 * English Wikipedia article title, and the hosts of its official website (P856).
 * @param {string} entityId - Wikidata entity ID (e.g., "Q489815")
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} { id, label, aliases, enwikiTitle, officialWebsiteHosts } or null
 */
export async function getWikidataEntity(entityId, log) {
  log.info(`Fetching Wikidata entity: ${entityId}`);

  try {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: entityId,
      props: 'labels|aliases|sitelinks|claims',
      languages: 'en',
      sitefilter: 'enwiki',
      format: 'json',
    });

    const url = `${WIKIDATA_API}?${params}`;
    const resp = await fetch(url, {
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
    const aliases = (entity.aliases?.en || []).map((a) => a.value).filter(Boolean);
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
      id: entityId, label, aliases, enwikiTitle, officialWebsiteHosts,
    };
  } catch (e) {
    log.error(`Error fetching Wikidata entity ${entityId}: ${e.message}`);
    return null;
  }
}

/**
 * Normalize a company name for weak (label) comparison: lower-case, drop corporate
 * suffixes and punctuation, collapse whitespace.
 * @param {string} value - Raw name
 * @returns {string} Normalized name
 */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(CORP_SUFFIXES, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate a Wikidata entity against the customer's site.
 *
 * - Strong (`p856`): any official-website host's registrable domain equals the
 *   site's registrable domain. Decisive signal (DHL->dhl.com, DNP->dnp.co.jp).
 * - Weak (`label`): entity label/alias token-overlap with the brand name.
 * - Low-confidence brand names accept ONLY `p856` (never the weak label match).
 *
 * @param {object} params - Parameters
 * @param {object} params.entity - Entity from {@link getWikidataEntity}
 * @param {string} params.brandName - Resolved brand name
 * @param {string} params.brandConfidence - 'high' | 'medium' | 'low'
 * @param {string} params.registrableDomain - Site registrable domain
 * @returns {{ok: boolean, method: (string|null), reason: string}}
 */
export function validateEntityAgainstSite({
  entity, brandName, brandConfidence, registrableDomain,
}) {
  if (!entity) {
    return { ok: false, method: null, reason: 'no_entity' };
  }

  // Strong P856 match: entity's own official website registrable domain == site's.
  const hosts = entity.officialWebsiteHosts || [];
  for (const host of hosts) {
    const { registrableDomain: entityRegDomain } = splitHost(host);
    if (entityRegDomain && registrableDomain && entityRegDomain === registrableDomain) {
      return { ok: true, method: 'p856', reason: `P856 host ${host} matches site ${registrableDomain}` };
    }
  }

  // Low-confidence acronyms may proceed only via P856 (already checked above).
  if (brandConfidence === 'low') {
    return { ok: false, method: null, reason: 'low_confidence_requires_p856' };
  }

  // Weak label/alias token-overlap match.
  const brandTokens = new Set(normalizeName(brandName).split(' ').filter(Boolean));
  if (brandTokens.size > 0) {
    const candidates = [entity.label, ...(entity.aliases || [])].filter(Boolean);
    for (const candidate of candidates) {
      const candTokens = normalizeName(candidate).split(' ').filter(Boolean);
      if (candTokens.length > 0) {
        const overlap = candTokens.filter((t) => brandTokens.has(t)).length;
        const ratio = overlap / Math.max(brandTokens.size, candTokens.length);
        if (ratio >= 0.5) {
          return { ok: true, method: 'label', reason: `label match "${candidate}"` };
        }
      }
    }
  }

  return { ok: false, method: null, reason: 'no_match' };
}

/**
 * Search Wikidata for candidate entity IDs by name (keeps ALL candidates).
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
    const resp = await fetch(url, {
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
 * Find the first Wikidata entity that VALIDATES against the site.
 * Prefers a strong P856 match; falls back to the first weak label match
 * (only for non-low-confidence brand names). Returns null if nothing validates.
 *
 * @param {object} params - { brandName, brandConfidence, registrableDomain }
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} Entity (+ `validation` method) or null
 */
export async function findValidatedWikidataEntity({
  brandName, brandConfidence, registrableDomain,
}, log) {
  const candidateIds = await searchWikidataCandidates(brandName, log);
  if (candidateIds.length === 0) {
    log.info(`No Wikidata candidates for: ${brandName}`);
    return null;
  }

  let labelMatch = null;
  for (const id of candidateIds) {
    // eslint-disable-next-line no-await-in-loop
    const entity = await getWikidataEntity(id, log);
    const validation = entity
      ? validateEntityAgainstSite({
        entity, brandName, brandConfidence, registrableDomain,
      })
      : { ok: false, method: null, reason: 'entity_fetch_failed' };

    if (validation.ok && validation.method === 'p856') {
      log.info(`Validated Wikidata entity ${id} for "${brandName}" via P856`);
      return { ...entity, validation: 'p856' };
    }
    if (validation.ok && validation.method === 'label' && !labelMatch) {
      labelMatch = { ...entity, validation: 'label' };
    } else {
      log.info(`Rejected Wikidata candidate ${id} for "${brandName}": ${validation.reason}`);
    }
  }

  if (labelMatch) {
    log.info(`Using label-validated Wikidata entity ${labelMatch.id} for "${brandName}"`);
  }
  return labelMatch;
}

/**
 * Fetch a Wikipedia extract for an EXACT enwiki title (no opensearch, no by-name
 * search). This is the entity-bound replacement for {@link fetchWikipediaFullText}.
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
  log.info(`Fetching Wikipedia extract for exact title "${title}" (max ${limit} chars)`);

  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'extracts',
      explaintext: 'true',
      format: 'json',
    });

    const url = `${WIKIPEDIA_API_BASE}?${params}`;
    const resp = await fetch(url, {
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
 * Fetch a validated intro summary: resolve+validate the entity, then fetch the
 * intro extract for that entity's EXACT enwiki title. Returns null when nothing
 * validates or the entity has no English Wikipedia article.
 * @param {object} params - { brandName, brandConfidence, registrableDomain }
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} { title, summary, entityId } or null
 */
export async function fetchValidatedSummary({
  brandName, brandConfidence, registrableDomain,
}, log) {
  const entity = await findValidatedWikidataEntity({
    brandName, brandConfidence, registrableDomain,
  }, log);

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
    const resp = await fetch(url, {
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
 * Create a Wikipedia service instance.
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createWikipediaService(log) {
  return {
    fetchSummary: (searchQuery) => fetchWikipediaSummary(searchQuery, log),
    fetchFullText: (searchQuery, maxChars) => fetchWikipediaFullText(searchQuery, maxChars, log),
    findWikidataId: (brandName) => findWikidataId(brandName, log),
    getWikidataEntity: (entityId) => getWikidataEntity(entityId, log),
    findValidatedWikidataEntity: (params) => findValidatedWikidataEntity(params, log),
    fetchExtractByTitle: (title, maxChars) => fetchWikipediaExtractByTitle(title, maxChars, log),
    fetchValidatedSummary: (params) => fetchValidatedSummary(params, log),
  };
}
