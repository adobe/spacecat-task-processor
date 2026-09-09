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

const WIKIPEDIA_API_BASE = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)';

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

/**
 * Resolve the English Wikipedia article title for a Wikidata entity via its sitelink.
 * @param {string} wikidataId - Wikidata entity ID (e.g. "Q6690181")
 * @param {object} log - Logger instance
 * @returns {Promise<string|null>} enwiki page title, or null when absent/failed
 */
export async function fetchWikidataSitelinkTitle(wikidataId, log) {
  try {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidataId,
      props: 'sitelinks',
      sitefilter: 'enwiki',
      format: 'json',
    });

    const resp = await fetch(`${WIKIDATA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`wbgetentities failed: ${resp.status}`);
    }

    const data = await resp.json();
    const title = data.entities?.[wikidataId]?.sitelinks?.enwiki?.title || null;
    log.info(`Wikidata sitelink for ${wikidataId}: ${title || 'none'}`);
    return title;
  } catch (e) {
    log.error(`Error fetching Wikidata sitelink for ${wikidataId}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch an exact Wikipedia article by title (no search), returning its text and
 * its Wikidata entity id in a single query.
 * @param {string} title - Exact article title
 * @param {number} [maxChars=12000] - Max characters of full text to return
 * @param {object} log - Logger instance
 * @returns {Promise<{title:string, fullText:string, summary:string, wikidataId:string|null}|null>}
 */
export async function fetchWikipediaArticleByTitle(title, maxChars, log) {
  const limit = maxChars ?? 12000;
  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'extracts|pageprops',
      explaintext: 'true',
      ppprop: 'wikibase_item',
      redirects: '1',
      format: 'json',
    });

    const resp = await fetch(`${WIKIPEDIA_API_BASE}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!resp.ok) {
      throw new Error(`Wikipedia article fetch failed: ${resp.status}`);
    }

    const data = await resp.json();
    const pages = data.query?.pages || {};
    const pageId = Object.keys(pages)[0];

    if (!pageId || pageId === '-1') {
      return null;
    }

    const page = pages[pageId];
    const fullText = (page.extract || '').slice(0, limit);
    const summary = fullText.split('\n\n')[0].trim();
    const wikidataId = page.pageprops?.wikibase_item || null;

    log.info(`Fetched Wikipedia article "${page.title}" (wikidata: ${wikidataId || 'none'})`);

    return {
      title: page.title,
      fullText,
      summary,
      wikidataId,
    };
  } catch (e) {
    log.error(`Error fetching Wikipedia article "${title}": ${e.message}`);
    return null;
  }
}

/**
 * Resolve the QID-anchored Wikipedia article for a brand.
 * QID -> enwiki sitelink title -> exact article -> guard on wikibase_item.
 * Never throws; degrades to empty text with a discardReason.
 * @param {string} brandName - Brand/company name
 * @param {{wikidataId?: string}} [opts] - a known QID skips the name lookup
 * @param {object} log - Logger instance
 * @returns {Promise<{wikidataId: string|null, title: string|null, fullText: string,
 *   summary: string, verified: boolean, discardReason: string|null}>}
 */
export async function resolveBrandWikipedia(brandName, opts, log) {
  const { wikidataId } = opts || {};
  // Hoisted so the outer catch can report a QID resolved inside the try.
  let qid = wikidataId || null;
  const empty = (discardReason, id = qid, title = null) => ({
    wikidataId: id,
    title,
    fullText: '',
    summary: '',
    verified: false,
    discardReason,
  });

  try {
    qid = wikidataId || await findWikidataId(brandName, log);
    if (!qid) {
      return empty('no-qid');
    }

    const title = await fetchWikidataSitelinkTitle(qid, log);
    if (!title) {
      return empty('no-sitelink', qid);
    }

    const article = await fetchWikipediaArticleByTitle(title, 12000, log);
    if (!article) {
      return empty('fetch-error', qid, title);
    }

    if (article.wikidataId !== qid) {
      log.warn(`brand-profile: wikipedia guard mismatch for ${brandName}: expected ${qid}, article '${article.title}' had ${article.wikidataId} - discarding`);
      return empty('guard-mismatch', qid, article.title);
    }

    return {
      wikidataId: qid,
      title: article.title,
      fullText: article.fullText,
      summary: article.summary,
      verified: true,
      discardReason: null,
    };
  } catch (e) {
    log.error(`brand-profile: resolveBrandWikipedia failed for ${brandName}: ${e.message}`);
    return empty('fetch-error');
  }
}

// Common two-level public suffixes, so registrableDomain keeps the org label
// (e.g. prudential.com.au, not com.au). Not exhaustive by design - it only needs
// the suffixes our customer domains actually use.
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.nz', 'co.in', 'com.sg', 'com.hk',
  'co.za', 'com.mx', 'com.tr', 'co.kr', 'com.cn', 'co.id', 'com.ph', 'com.my',
  'co.th', 'com.vn', 'co.il', 'com.tw', 'com.ar', 'com.co',
]);

/**
 * Best-effort registrable domain (eTLD+1) for a host or URL. Lowercased, `www.`
 * stripped, subdomains dropped. Handles the common two-level suffixes above so
 * `brand.toyota.com` and `toyota.com` both reduce to `toyota.com`.
 * @param {string} input - A hostname or URL
 * @returns {string|null} registrable domain, or null when it can't be derived
 */
export function registrableDomain(input) {
  if (!input) {
    return null;
  }
  let host = String(input).trim().toLowerCase();
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    // not a parseable URL - fall through and treat `host` as a bare hostname
  }
  host = host.replace(/^www\./, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) {
    return labels.length ? labels.join('.') : null;
  }
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * Fetch a Wikidata entity's official website(s) (P856) and English description.
 * @param {string} wikidataId - Wikidata entity ID
 * @param {object} log - Logger instance
 * @returns {Promise<{description: string, officialWebsites: string[]}|null>}
 */
export async function fetchWikidataEntityMeta(wikidataId, log) {
  try {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidataId,
      props: 'claims|descriptions',
      languages: 'en',
      format: 'json',
    });
    const resp = await fetch(`${WIKIDATA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) {
      throw new Error(`wbgetentities failed: ${resp.status}`);
    }
    const data = await resp.json();
    const entity = data.entities?.[wikidataId] || {};
    const description = entity.descriptions?.en?.value || '';
    const officialWebsites = (entity.claims?.P856 || [])
      .map((claim) => claim?.mainsnak?.datavalue?.value)
      .filter(Boolean);
    return { description, officialWebsites };
  } catch (e) {
    log.error(`brand-profile: fetchWikidataEntityMeta failed for ${wikidataId}: ${e.message}`);
    return null;
  }
}

/**
 * Verify that a resolved Wikidata entity actually corresponds to the brand.
 *
 * The QID guard in resolveBrandWikipedia only proves the *article* matches the
 * *QID* - it cannot catch a QID that was itself resolved to the wrong same-named
 * entity (e.g. capella.edu -> Q12970, the star Capella). This closes that gap:
 *   1. Official website (P856) registrable-domain match -> confirmed.
 *   2. Otherwise an LLM check of the entity description against the brand's
 *      domain + industry.
 * Fails OPEN (match) on any infrastructure error so it never regresses a brand
 * we simply couldn't verify; only a definitive LLM "no" rejects.
 *
 * @param {{wikidataId: string, brandName: string, domain: string, industry: string}} args
 * @param {object} gpt - AzureOpenAIClient instance (or null)
 * @param {object} log - Logger instance
 * @returns {Promise<{match: boolean, method: string, reason: string}>}
 */
export async function validateEntityMatchesBrand({
  wikidataId, brandName, domain, industry,
}, gpt, log) {
  const brandDomain = registrableDomain(domain);
  const meta = await fetchWikidataEntityMeta(wikidataId, log);
  if (!meta) {
    return { match: true, method: 'error-failopen', reason: 'entity-meta-unavailable' };
  }

  // 1) Deterministic: official website registrable-domain match.
  const websiteHit = meta.officialWebsites.find(
    (site) => brandDomain && registrableDomain(site) === brandDomain,
  );
  if (websiteHit) {
    return { match: true, method: 'official_website', reason: websiteHit };
  }

  // 2) LLM content check. Without a verifier we cannot confirm - fail open.
  if (!gpt || typeof gpt.fetchChatCompletion !== 'function') {
    return { match: true, method: 'no-verifier', reason: meta.description || '' };
  }
  try {
    const prompt = `You verify whether a Wikipedia/Wikidata entity is the same organization as a website.
Website domain: ${domain}
Brand name: ${brandName}
Industry: ${industry || 'unknown'}
Candidate entity (${wikidataId}) description: "${meta.description || 'n/a'}"
Is the candidate entity the SAME organization that operates that website? Consider the industry and domain. Answer with a single word: yes or no.`;
    const resp = await gpt.fetchChatCompletion(prompt, { temperature: 0, maxTokens: 3 });
    const answer = (resp?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    return { match: answer.startsWith('y'), method: 'llm', reason: meta.description || '' };
  } catch (e) {
    log.warn(`brand-profile: entity LLM validation failed for ${wikidataId}: ${e.message} - failing open`);
    return { match: true, method: 'error-failopen', reason: 'llm-error' };
  }
}

/**
 * Create a Wikipedia service instance.
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createWikipediaService(log) {
  return {
    findWikidataId: (brandName) => findWikidataId(brandName, log),
    resolveBrand: (brandName, opts) => resolveBrandWikipedia(brandName, opts, log),
  };
}
