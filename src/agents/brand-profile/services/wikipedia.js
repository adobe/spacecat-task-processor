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
 *
 * LLMO-6580: in addition to the original by-name helpers, this module exposes an
 * entity-binding path. A Wikidata entity is only trusted once its official-website
 * claim (P856) resolves to the site's registrable domain; Wikipedia is then read from
 * that validated entity's exact `enwiki` sitelink title rather than a fuzzy by-name
 * search. This prevents a same-initials article (e.g. a `d*` acronym resolving to the
 * "D-Company" organised-crime article) from being mistaken for the customer's brand.
 */

const WIKIPEDIA_API_BASE = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)';

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

/*
 * --- Entity-binding path (LLMO-6580) ---------------------------------------
 * Everything below resolves and validates a Wikidata entity against the site's
 * registrable domain via a strong P856 (official-website) host match, then reads
 * Wikipedia by the validated entity's exact enwiki sitelink title. There is no
 * by-name / fuzzy fallback: if no candidate's official website matches the site,
 * the caller gets null and produces no brand data.
 */

/**
 * Minimal public-suffix awareness for the multi-part TLDs that broke the audit set.
 * Hand-rolled table (no runtime dependency) covering the common ccTLD second levels.
 */
const MULTI_PART_TLDS = new Set([
  'co.jp', 'co.uk', 'com.au', 'co.nz', 'gov.sg', 'com.sg', 'com.br', 'co.in',
  'com.mx', 'gov.uk', 'ac.uk', 'org.uk', 'co.za', 'com.cn', 'com.hk', 'co.kr',
  'ne.jp', 'or.jp', 'com.tw', 'co.id', 'com.tr', 'gov.au', 'edu.au',
]);

/**
 * Generic second-level labels that form a two-label public suffix when paired with a
 * 2-character ccTLD (e.g. `com.my`, `co.th`, `gov.in`, `or.kr`). Generalising the
 * `<generic>.<cc>` shape means an unlisted ccTLD cannot collapse the registrable domain
 * down to the bare public suffix, which is the residual LLMO-6580 false-positive vector:
 * a bare-suffix registrable domain P856-matches any foreign entity on the same suffix.
 */
const GENERIC_SECOND_LEVELS = new Set([
  'com', 'co', 'org', 'net', 'gov', 'edu', 'ac', 'mil', 'ne', 'or', 'go', 'gob', 'gouv',
]);

/**
 * Split a hostname into its subdomain labels, apex label, and registrable domain,
 * honouring the minimal multi-part TLD table.
 * @param {string} hostname - Hostname (e.g. "dev.amrize.com", "dnp.co.jp")
 * @returns {{subdomainLabels: string[], apexLabel: string, registrableDomain: string}}
 */
export function splitHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').trim();
  const labels = host.split('.').filter(Boolean);

  if (labels.length <= 1) {
    return { subdomainLabels: [], apexLabel: labels[0] || '', registrableDomain: host };
  }

  let registrableLabelCount = 2;
  const lastTwo = labels.slice(-2).join('.');
  const tld = labels.at(-1);
  const secondLevel = labels.at(-2);
  // Explicit multi-part TLD, OR the general `<generic-second-level>.<2-char-ccTLD>` shape
  // (co.uk, com.my, co.th, gov.in, or.kr, ...). Both are two-label public suffixes, so the
  // registrable domain keeps a real label in front of them instead of collapsing to the
  // bare suffix (LLMO-6580: a bare-suffix registrable domain yields false P856 matches).
  if (labels.length >= 3
    && (MULTI_PART_TLDS.has(lastTwo)
      || (tld.length === 2 && GENERIC_SECOND_LEVELS.has(secondLevel)))) {
    registrableLabelCount = 3;
  }

  const registrableLabels = labels.slice(-registrableLabelCount);
  const registrableDomain = registrableLabels.join('.');
  const apexLabel = registrableLabels[0];
  const subdomainLabels = labels.slice(0, labels.length - registrableLabelCount);

  return { subdomainLabels, apexLabel, registrableDomain };
}

/**
 * Is this registrable domain actually a bare public suffix (no registrable label in front)?
 * Such a domain must never produce a P856 match, or any foreign entity on the same suffix
 * would validate against the site (LLMO-6580). Mirrors the public-suffix logic in
 * {@link splitHost}: an explicit multi-part TLD (`co.uk`) OR the generalized two-label
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
 * site domain (e.g. `co.uk`) never matches. There is no by-name / label fallback.
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
    // Entity-binding path (LLMO-6580).
    getWikidataEntity: (entityId) => getWikidataEntity(entityId, log),
    findValidatedWikidataEntity: (params) => findValidatedWikidataEntity(params, log),
    fetchExtractByTitle: (title, maxChars) => fetchWikipediaExtractByTitle(title, maxChars, log),
    fetchValidatedSummary: (params) => fetchValidatedSummary(params, log),
  };
}
