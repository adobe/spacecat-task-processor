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
 * Product/Service catalogue extraction service.
 *
 * Ported from brandaid/src/services/product_extractor.py
 *
 * Extracts products, services, and sub-brands for a company using:
 * 1. Sitemap URL + LLM (when provided - most accurate for current products)
 * 2. Wikidata SPARQL (primary fallback - structured data)
 * 3. Wikipedia + LLM (secondary fallback - text extraction)
 */

import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import { readPromptFile, renderTemplate } from '../../base.js';
import { findValidatedWikidataEntity, fetchWikipediaExtractByTitle } from './wikipedia.js';

const USER_AGENT = 'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const MIN_PRODUCTS_THRESHOLD = 3;

// Harm denylist (LLMO-6580 / AI-ethics Tier-2). Word-boundary matched against product/
// service/sub-brand names and categories. Deliberate stems (terror, smuggl, insurgen)
// avoid false hits on words like "armature" or "Churchill".
const HARM_PATTERNS = [
  // crime / terror
  /\bterror/i, /\bsmuggl/i, /\binsurgen/i, /\bcartel/i, /\bmafia/i, /\bcriminal/i, /\bnarco/i,
  // weapons / military
  /\bweapon/i, /\bfirearm/i, /\bammunition/i, /\bmissile/i, /\bwarhead/i, /\bexplosive/i,
  // adult / sexual
  /\bpornograph/i, /\bescort\b/i,
  // drugs
  /\bnarcotic/i, /\bheroin\b/i, /\bcocaine\b/i, /\bmethamphetamine\b/i,
  // hate / extremism
  /\bextremis/i, /\bneo-?nazi/i, /\bjihad/i,
];

// Generic SPARQL query - works for any industry
const PRODUCTS_SPARQL = `
SELECT DISTINCT ?item ?itemLabel ?typeLabel ?inception ?discontinued WHERE {
  {
    ?item wdt:P176 wd:{wikidata_id} .
  } UNION {
    ?item wdt:P178 wd:{wikidata_id} .
  } UNION {
    wd:{wikidata_id} wdt:P1056 ?item .
  } UNION {
    ?item wdt:P127 wd:{wikidata_id} .
    ?item wdt:P31/wdt:P279* wd:Q4830453 .
  }
  OPTIONAL { ?item wdt:P31 ?type . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P576 ?discontinued . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
LIMIT 200
`;

// Common product path segments (industry-agnostic)
const PRODUCT_SEGMENTS = [
  '/trucks/', '/suvs/', '/sedans/', '/coupes/', '/electric/',
  '/performance/', '/vans/', '/commercial/', '/vehicles/', '/cars/',
  '/models/', '/lineup/',
  '/products/', '/solutions/', '/apps/', '/tools/', '/features/',
  '/services/', '/platforms/',
  '/shop/', '/collections/', '/categories/',
  '/catalog/', '/offerings/',
];

// Exclude patterns (archives, support pages, etc.)
const EXCLUDE_PATTERNS = [
  '/previous-year/', '/legacy/', '/archive/', '/discontinued/',
  '/support/', '/help/', '/faq/', '/blog/', '/news/', '/press/',
  '/about/', '/careers/', '/contact/', '/privacy/', '/terms/',
  '/login/', '/account/', '/cart/', '/checkout/',
  '.pdf', '.jpg', '.png', '.gif',
];

/**
 * Extract year from Wikidata date string.
 * @param {string} dateString - Date in format like "1991-01-01T00:00:00Z"
 * @returns {number|null} Year as integer, or null
 */
function extractYear(dateString) {
  if (!dateString) {
    return null;
  }
  try {
    if (dateString.includes('T')) {
      return parseInt(dateString.split('-')[0], 10);
    }
    return parseInt(dateString.slice(0, 4), 10);
  /* c8 ignore next 3 */
  } catch {
    return null;
  }
}

/**
 * Clean Wikidata type label into a readable category.
 * @param {string} typeLabel - Raw type label from Wikidata
 * @returns {string} Cleaned category string
 */
function cleanCategory(typeLabel) {
  if (!typeLabel) {
    return '';
  }
  const clean = typeLabel.replace(/_/g, ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

/**
 * Filter URLs to product-relevant pages.
 * @param {string[]} urls - All URLs from sitemap
 * @returns {string[]} Filtered list of product-relevant URLs
 */
function filterProductUrls(urls) {
  const filtered = urls.filter((url) => {
    const urlLower = url.toLowerCase();

    // Skip excluded patterns
    if (EXCLUDE_PATTERNS.some((pattern) => urlLower.includes(pattern))) {
      return false;
    }

    // Include if matches product segment
    if (PRODUCT_SEGMENTS.some((segment) => urlLower.includes(segment))) {
      return true;
    }

    // Also include URLs that end with a potential product name
    return /\/[a-z0-9]+-?[a-z0-9]*\/?$/.test(urlLower);
  });

  // Limit to avoid token explosion
  return filtered.slice(0, 300);
}

/**
 * Fetch and extract all URLs from a sitemap XML.
 * @param {string} sitemapUrl - URL of the sitemap.xml
 * @param {object} log - Logger instance
 * @returns {Promise<string[]>} List of URLs found in the sitemap
 */
async function fetchSitemapUrls(sitemapUrl, log) {
  log.info(`Fetching sitemap: ${sitemapUrl}`);

  const resp = await fetch(sitemapUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!resp.ok) {
    throw new Error(`Sitemap fetch failed: ${resp.status}`);
  }

  const text = await resp.text();
  // Extract URLs from <loc> tags using regex
  const urls = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  log.info(`Found ${urls.length} URLs in sitemap`);
  return urls;
}

/**
 * Query Wikidata SPARQL for products manufactured/developed by the brand.
 * @param {string} wikidataId - Wikidata entity ID for the brand
 * @param {object} log - Logger instance
 * @returns {Promise<object[]>} List of product dicts
 */
async function queryWikidataProducts(wikidataId, log) {
  log.info(`Querying Wikidata products for: ${wikidataId}`);

  const query = PRODUCTS_SPARQL.replace(/{wikidata_id}/g, wikidataId);
  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(query)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
      },
    });

    if (!resp.ok) {
      throw new Error(`SPARQL query failed: ${resp.status}`);
    }

    const data = await resp.json();
    const seenNames = new Set();

    const products = (data.results?.bindings || [])
      .filter((binding) => {
        const name = binding.itemLabel?.value || '';
        // Skip if no name, already seen, or Wikidata ID as label
        if (!name || seenNames.has(name) || /^Q\d+$/.test(name)) {
          return false;
        }
        seenNames.add(name);
        return true;
      })
      .map((binding) => {
        const name = binding.itemLabel?.value || '';
        const itemUri = binding.item?.value || '';
        const itemId = itemUri ? itemUri.split('/').pop() : '';
        const typeLabel = binding.typeLabel?.value || '';
        const inception = binding.inception?.value || '';
        const discontinued = binding.discontinued?.value || '';

        return {
          name,
          category: cleanCategory(typeLabel),
          wikidata_id: itemId,
          inception_year: extractYear(inception),
          status: discontinued ? 'discontinued' : 'current',
        };
      });

    log.info(`Found ${products.length} products from Wikidata`);
    return products;
  } catch (e) {
    log.error(`Wikidata SPARQL query failed: ${e.message}`);
    return [];
  }
}

/**
 * Normalize product/service list from LLM response.
 * @param {object[]} items - Raw items from LLM
 * @param {string} status - Status to assign ("current" or "discontinued")
 * @returns {object[]} Normalized items
 */
function normalizeItems(items, status = 'current') {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => {
    if (typeof item === 'string') {
      return { name: item, category: '', status };
    }
    return {
      name: item.name || '',
      category: item.category || '',
      variants: item.variants || [],
      status,
    };
  }).filter((item) => item.name);
}

/**
 * Normalize and deduplicate extraction results.
 * @param {object} result - Extraction result to normalize
 * @returns {object} Normalized result
 */
function normalizeResults(result) {
  // Deduplicate products by name
  const seenProducts = new Set();
  const uniqueProducts = (result.products || []).filter((p) => {
    const nameLower = (p.name || '').toLowerCase();
    if (nameLower && !seenProducts.has(nameLower)) {
      seenProducts.add(nameLower);
      return true;
    }
    return false;
  });

  // Deduplicate services by name
  const seenServices = new Set();
  const uniqueServices = (result.services || []).filter((s) => {
    const nameLower = (s.name || '').toLowerCase();
    if (nameLower && !seenServices.has(nameLower)) {
      seenServices.add(nameLower);
      return true;
    }
    return false;
  });

  // Calculate count
  const totalCount = uniqueProducts.length
    + uniqueServices.length
    + (result.sub_brands || []).length
    + (result.discontinued || []).length;

  return {
    ...result,
    products: uniqueProducts,
    services: uniqueServices,
    metadata: {
      ...result.metadata,
      count: totalCount,
    },
  };
}

/**
 * Merge two extraction results.
 * @param {object} primary - Primary results (usually Wikidata)
 * @param {object} secondary - Secondary results (usually Wikipedia)
 * @returns {object} Merged result
 */
function mergeResults(primary, secondary) {
  // `primary` is always the well-formed result object (four arrays; Wikidata product
  // names are non-empty by construction). `secondary` is extractFromWikipedia output
  // (four arrays, but LLM entries may have empty names).
  const existingProductNames = new Set(primary.products.map((p) => p.name.toLowerCase()));
  const existingServiceNames = new Set(primary.services.map((s) => s.name.toLowerCase()));
  const existingSubBrands = new Set(primary.sub_brands);
  const existingDiscontinued = new Set(primary.discontinued.map((d) => d.name.toLowerCase()));

  const newProducts = secondary.products.filter((product) => {
    const nameLower = (product.name || '').toLowerCase();
    return nameLower && !existingProductNames.has(nameLower);
  });

  const newServices = secondary.services.filter((service) => {
    const nameLower = (service.name || '').toLowerCase();
    return nameLower && !existingServiceNames.has(nameLower);
  });

  const newSubBrands = secondary.sub_brands.filter((sub) => !existingSubBrands.has(sub));

  const newDiscontinued = secondary.discontinued.filter((disc) => {
    const nameLower = (disc.name || '').toLowerCase();
    return nameLower && !existingDiscontinued.has(nameLower);
  });

  return {
    ...primary,
    products: [...primary.products, ...newProducts],
    services: [...primary.services, ...newServices],
    sub_brands: [...primary.sub_brands, ...newSubBrands],
    discontinued: [...primary.discontinued, ...newDiscontinued],
  };
}

/**
 * Does a string trip the harm denylist?
 * @param {string} text - Text to scan
 * @returns {boolean}
 */
function hitsHarm(text) {
  const t = String(text || '');
  return HARM_PATTERNS.some((re) => re.test(t));
}

/**
 * Does a normalized product/service item ({ name, category }) trip the harm denylist?
 * @param {object} item - Item to scan
 * @returns {boolean}
 */
function itemHitsHarm(item) {
  return hitsHarm(item.name) || hitsHarm(item.category);
}

/**
 * Content-safety / plausibility backstop (LLMO-6580 ask 4, defence in depth).
 *
 * Provenance rule:
 * - When the content came from a strongly (P856) validated entity — or the
 *   customer's own sitemap (`own_site`) — a real defense/pharma/gaming customer
 *   may legitimately list sensitive products: KEEP the content and set
 *   `metadata.sensitive_category` for human review.
 * - When the source is unvalidated or only weakly (label) matched, HARD-DROP any
 *   harmful item/service/sub-brand and set `metadata.safety_filtered`.
 *
 * @param {object} result - Extraction result (mutated defensively via copy)
 * @param {object} opts - { entityValidated: 'p856'|'label'|'own_site'|null }
 * @param {object} log - Logger instance
 * @returns {object} Possibly-filtered result
 */
function applyContentSafetyGate(result, { entityValidated }, log) {
  // Strong provenance = a P856-validated Wikidata entity or the customer's own sitemap.
  const strongProvenance = entityValidated === 'p856' || entityValidated === 'own_site';

  // `result` always carries the four arrays (initialized by every caller).
  const dropped = [
    ...result.products.filter(itemHitsHarm).map((p) => p.name),
    ...result.services.filter(itemHitsHarm).map((s) => s.name),
    ...result.sub_brands.filter(hitsHarm),
    ...result.discontinued.filter(itemHitsHarm).map((d) => d.name),
  ];

  if (dropped.length === 0) {
    return result;
  }

  if (strongProvenance) {
    // Keep legitimate sensitive content (defense/pharma/gaming), flag for review.
    log.warn(`Sensitive categories from validated source kept for review: ${dropped.join(', ')}`);
    return {
      ...result,
      metadata: { ...result.metadata, sensitive_category: true },
    };
  }

  // Weak/no provenance: hard-drop harmful content.
  log.warn(`Dropping harmful content from unvalidated source: ${dropped.join(', ')}`);
  return {
    ...result,
    products: result.products.filter((it) => !itemHitsHarm(it)),
    services: result.services.filter((it) => !itemHitsHarm(it)),
    sub_brands: result.sub_brands.filter((s) => !hitsHarm(s)),
    discontinued: result.discontinued.filter((it) => !itemHitsHarm(it)),
    metadata: { ...result.metadata, safety_filtered: true },
  };
}

/**
 * Extract current products from sitemap URLs using LLM.
 * @param {string} sitemapUrl - URL of the brand's sitemap.xml
 * @param {string} brandName - Brand name for context
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Extraction result
 */
export async function extractFromSitemap(sitemapUrl, brandName, gpt, log) {
  log.info(`Extracting products from sitemap for ${brandName}: ${sitemapUrl}`);

  const result = {
    products: [],
    services: [],
    sub_brands: [],
    discontinued: [],
    metadata: {
      source: 'sitemap',
      sitemap_url: sitemapUrl,
      extracted_at: new Date().toISOString(),
      count: 0,
    },
  };

  let urls;
  try {
    urls = await fetchSitemapUrls(sitemapUrl, log);
    result.metadata.total_urls = urls.length;
  } catch (e) {
    log.error(`Failed to fetch sitemap: ${e.message}`);
    result.metadata.source = 'sitemap_failed';
    result.metadata.error = e.message;
    return result;
  }

  if (!urls || urls.length === 0) {
    log.warn(`No URLs found in sitemap: ${sitemapUrl}`);
    result.metadata.source = 'sitemap_empty';
    return result;
  }

  const productUrls = filterProductUrls(urls);
  log.info(`Filtered to ${productUrls.length} product-relevant URLs`);
  result.metadata.product_urls = productUrls.length;

  if (productUrls.length === 0) {
    log.warn('No product URLs found in sitemap');
    result.metadata.source = 'sitemap_no_products';
    return result;
  }

  // Ask LLM to deduce products from URLs
  const urlsText = productUrls.slice(0, 200).join('\n');
  const promptTemplate = readPromptFile('brand-profile/product-sitemap.prompt');
  const prompt = renderTemplate(promptTemplate, {
    brand_name: brandName,
    urls_text: urlsText,
  });

  try {
    const resp = await gpt.fetchChatCompletion(prompt, {
      responseFormat: 'json_object',
      temperature: 0.1,
    });

    const content = resp?.choices?.[0]?.message?.content || '{}';
    const llmResult = JSON.parse(content);

    result.products = normalizeItems(llmResult.products, 'current');
    result.services = normalizeItems(llmResult.services, 'current');
    result.sub_brands = llmResult.sub_brands || [];
    result.discontinued = normalizeItems(llmResult.discontinued, 'discontinued');
    result.metadata.confidence = llmResult.confidence || 'unknown';
    result.metadata.notes = llmResult.notes || '';
  } catch (e) {
    log.error(`Sitemap extraction LLM call failed: ${e.message}`);
    result.metadata.source = 'sitemap_llm_failed';
    result.metadata.error = e.message;
    return result;
  }

  // Content-safety backstop. The sitemap is the customer's OWN site, so treat it as
  // strong (`own_site`) provenance: keep legitimate sensitive content but flag it.
  const gated = applyContentSafetyGate(result, { entityValidated: 'own_site' }, log);
  return normalizeResults(gated);
}

/**
 * Extract products from Wikipedia text using LLM.
 * @param {string} brandName - Brand name
 * @param {string} wikipediaText - Wikipedia article text
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object|null>} Extraction result or null
 */
async function extractFromWikipedia(brandName, wikipediaText, gpt, log) {
  if (!wikipediaText) {
    log.info(`No Wikipedia text available for ${brandName}`);
    return null;
  }

  // Truncate if too long
  const maxChars = 8000;
  const text = wikipediaText.length > maxChars
    ? `${wikipediaText.slice(0, maxChars)}...`
    : wikipediaText;

  const promptTemplate = readPromptFile('brand-profile/product-wikipedia.prompt');
  const prompt = renderTemplate(promptTemplate, {
    brand_name: brandName,
    wikipedia_text: text,
  });

  try {
    const resp = await gpt.fetchChatCompletion(prompt, {
      responseFormat: 'json_object',
      temperature: 0.1,
    });

    const content = resp?.choices?.[0]?.message?.content || '{}';
    const llmResult = JSON.parse(content);

    return {
      products: normalizeItems(llmResult.products, 'current'),
      services: normalizeItems(llmResult.services, 'current'),
      sub_brands: llmResult.sub_brands || [],
      discontinued: normalizeItems(llmResult.discontinued, 'discontinued'),
    };
  } catch (e) {
    log.error(`Wikipedia extraction failed: ${e.message}`);
    return null;
  }
}

/**
 * Extract products bound to a VALIDATED Wikidata entity (LLMO-6580).
 *
 * Every Wikipedia/Wikidata fetch is bound to an entity that validates against the
 * customer's site (P856 host match, or a weak label match for non-low-confidence
 * names). If nothing validates, we produce NO products rather than guessing.
 *
 * @param {object} options - Options
 * @param {string} options.brandName - Brand/company name
 * @param {string} [options.brandConfidence='medium'] - 'high' | 'medium' | 'low'
 * @param {string} [options.registrableDomain=''] - Site registrable domain
 * @param {string} [options.wikipediaSummary=null] - Optional pre-fetched fallback text
 * @param {boolean} [options.enableWikiProducts=true] - Kill-switch for the entire path
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Extraction result
 */
export async function extractProducts({
  brandName,
  brandConfidence = 'medium',
  registrableDomain = '',
  wikipediaSummary = null,
  enableWikiProducts = true,
}, gpt, log) {
  log.info(`Extracting products for brand: ${brandName} (confidence=${brandConfidence})`);

  const result = {
    products: [],
    services: [],
    sub_brands: [],
    discontinued: [],
    metadata: {
      source: 'none',
      brand_wikidata_id: null,
      extracted_at: new Date().toISOString(),
      count: 0,
    },
  };

  // Kill-switch: entire Wikipedia/Wikidata product path disabled.
  if (!enableWikiProducts) {
    log.info('brand-profile: Wikipedia/Wikidata product extraction disabled by flag');
    result.metadata.source = 'disabled';
    return normalizeResults(result);
  }

  // Step 1: Resolve+validate the entity. A bare low-confidence acronym only validates
  // via a strong P856 host match; otherwise findValidatedWikidataEntity returns null.
  const entity = await findValidatedWikidataEntity({
    brandName, brandConfidence, registrableDomain,
  }, log);

  if (!entity) {
    log.info(`No validated Wikidata entity for ${brandName}; producing no products`);
    result.metadata.source = brandConfidence === 'low'
      ? 'skipped_low_confidence'
      : 'none_no_validated_entity';
    result.metadata.rejected = true;
    return normalizeResults(result);
  }

  result.metadata.brand_wikidata_id = entity.id;
  result.metadata.source_entity_label = entity.label;
  result.metadata.validation = entity.validation;

  // Step 2: Query Wikidata SPARQL for products (inherently entity-bound, safe).
  const wikidataProducts = await queryWikidataProducts(entity.id, log);
  if (wikidataProducts.length > 0) {
    result.products = wikidataProducts;
    result.metadata.source = 'wikidata';
    result.metadata.count = wikidataProducts.length;
    log.info(`Found ${wikidataProducts.length} products from Wikidata`);
  }

  // Step 3: Fallback/augment with the validated entity's OWN enwiki article only.
  if (result.products.length < MIN_PRODUCTS_THRESHOLD) {
    log.info(`Wikidata returned ${result.products.length} products (threshold: ${MIN_PRODUCTS_THRESHOLD}), trying entity-bound Wikipedia fallback`);

    let wikiText = wikipediaSummary;
    if (!wikiText && entity.enwikiTitle) {
      wikiText = await fetchWikipediaExtractByTitle(entity.enwikiTitle, 12000, log);
      result.metadata.source_wikipedia_title = entity.enwikiTitle;
    }

    const wikiResult = await extractFromWikipedia(brandName, wikiText, gpt, log);
    if (wikiResult) {
      const merged = mergeResults(result, wikiResult);
      Object.assign(result, merged);
      result.metadata.source = result.metadata.source === 'wikidata' ? 'hybrid' : 'wikipedia_llm';
    }
  }

  // Step 4: Content-safety backstop, gated by entity provenance.
  const gated = applyContentSafetyGate(result, { entityValidated: entity.validation }, log);
  return normalizeResults(gated);
}

/**
 * Format extracted products into a string for prompt injection.
 * @param {object} extractionResult - Result from extractProducts()
 * @returns {string} Formatted string listing products and services
 */
export function formatProductsForPrompt(extractionResult) {
  const lines = [];

  const products = extractionResult.products || [];
  if (products.length > 0) {
    // Group by category
    const byCategory = {};
    for (const p of products) {
      const cat = p.category || 'Other';
      byCategory[cat] = byCategory[cat] || [];
      byCategory[cat].push(p.name);
    }

    for (const [cat, names] of Object.entries(byCategory).sort()) {
      if (names.length <= 5) {
        lines.push(`${cat}: ${names.join(', ')}`);
      } else {
        lines.push(`${cat}: ${names.slice(0, 5).join(', ')}, ...`);
      }
    }
  }

  const services = extractionResult.services || [];
  if (services.length > 0) {
    const serviceNames = services.map((s) => s.name).slice(0, 10);
    lines.push(`Services: ${serviceNames.join(', ')}`);
  }

  const subBrands = extractionResult.sub_brands || [];
  if (subBrands.length > 0) {
    lines.push(`Sub-brands: ${subBrands.slice(0, 10).join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'No product catalogue available.';
}

/**
 * Create a ProductExtractorService instance bound to GPT client.
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createProductExtractorService(env, log) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });

  return {
    extractFromSitemap: (sitemapUrl, brandName) => (
      extractFromSitemap(sitemapUrl, brandName, gpt, log)
    ),
    extractProducts: (options) => extractProducts(options, gpt, log),
    formatProductsForPrompt,
  };
}
