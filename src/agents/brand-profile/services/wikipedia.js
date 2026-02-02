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
  };
}
