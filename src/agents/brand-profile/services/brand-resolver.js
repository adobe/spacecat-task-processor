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
 * Brand-name resolution for the brand-profile agent (LLMO-6580).
 *
 * Turns a base profile + site URL into a best-effort display name, a coarse
 * confidence signal (retained for logging/observability), and the site's
 * registrable domain. Downstream Wikipedia/Wikidata entity validation is
 * P856-only and keyed on the registrable domain — not on the confidence signal:
 * a candidate entity is accepted only when its official-website host (claim
 * P856) shares the site's registrable domain, so a bare acronym (e.g. `dnp`,
 * `edb`) can never drive a fuzzy by-name lookup.
 */

import { load } from 'cheerio';
import { hasText } from '@adobe/spacecat-shared-utils';

const USER_AGENT = 'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)';
const HOMEPAGE_FETCH_TIMEOUT_MS = 5000;

/**
 * Labels that must never become the brand name (subdomains / env prefixes / sections).
 */
export const STOP_LABELS = new Set([
  'www', 'www2', 'dev', 'stage', 'staging', 'test', 'qa', 'preview', 'demo',
  'store', 'shop', 'support', 'help', 'faq', 'blog', 'news', 'press', 'careers',
  'account', 'accounts', 'login', 'my', 'portal', 'app', 'apps', 'm', 'mobile',
  'en', 'us', 'uk', 'eu', 'go', 'get', 'about',
]);

/**
 * Minimal public-suffix awareness for the multi-part TLDs that broke the audit set.
 * Hand-rolled table (no runtime dependency) covering the common ccTLD second levels.
 */
export const MULTI_PART_TLDS = new Set([
  'co.jp', 'co.uk', 'com.au', 'co.nz', 'gov.sg', 'com.sg', 'com.br', 'co.in',
  'com.mx', 'gov.uk', 'ac.uk', 'org.uk', 'co.za', 'com.cn', 'com.hk', 'co.kr',
  'ne.jp', 'or.jp', 'com.tw', 'co.id', 'com.tr', 'gov.au', 'edu.au',
]);

/**
 * Generic second-level labels that form a two-label public suffix when paired with a
 * 2-character ccTLD (e.g. `com.my`, `co.th`, `gov.in`, `or.kr`). Generalising the
 * `<generic>.<cc>` shape means an unlisted ccTLD cannot collapse the registrable domain
 * down to the bare public suffix, which was the residual LLMO-6580 false-positive vector:
 * a bare-suffix registrable domain P856-matches any foreign entity on the same suffix.
 */
export const GENERIC_SECOND_LEVELS = new Set([
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
 * Is this label too weak to use as a brand name on its own?
 * True for stop labels (subdomains/sections) and short (<=3 char) acronyms.
 * Short/acronym brands (IBM, HP) are still allowed downstream via P856 validation.
 * @param {string} label - Candidate label
 * @returns {boolean}
 */
export function isLowConfidenceLabel(label) {
  const l = String(label || '').toLowerCase().trim();
  if (!l) {
    return true;
  }
  if (STOP_LABELS.has(l)) {
    return true;
  }
  return l.length <= 3;
}

/**
 * Clean a raw <title>/og:site_name into a brand-like token.
 * "Page | Brand" or "Brand - Tagline" -> first non-generic segment.
 * @param {string} raw - Raw title string
 * @returns {string|null} Cleaned name or null
 */
function cleanTitle(raw) {
  const t = String(raw || '').trim();
  if (!t) {
    return null;
  }
  const parts = t.split(/\s+[|\-–—:·]\s+/).map((p) => p.trim()).filter(Boolean);
  const generic = /^(home|homepage|official site|official website|welcome)$/i;
  const meaningful = parts.filter((p) => !generic.test(p));
  return meaningful[0] || parts[0];
}

/**
 * Best-effort fetch of the site's display name from og:site_name or <title>.
 * Never throws; returns null on any failure (network, timeout, non-HTML, bot-block).
 * @param {string} baseURL - Site base URL
 * @param {object} log - Logger instance
 * @returns {Promise<string|null>} Cleaned site name or null
 */
export async function fetchSiteName(baseURL, log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOMEPAGE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(baseURL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!resp.ok) {
      log.info(`brand-resolver: homepage fetch not ok (${resp.status}) for ${baseURL}`);
      return null;
    }
    const contentType = resp.headers?.get?.('content-type') || '';
    if (contentType && !contentType.toLowerCase().includes('html')) {
      return null;
    }
    const html = await resp.text();
    const $ = load(html);
    const ogName = cleanTitle($('meta[property="og:site_name"]').attr('content'));
    if (ogName) {
      return ogName;
    }
    return cleanTitle($('title').first().text());
  } catch (e) {
    log.info(`brand-resolver: homepage fetch failed for ${baseURL}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a brand name with a confidence signal and the site's registrable domain.
 *
 * Precedence (high -> low):
 *   1. base_profile.main_profile.brand_name        -> high  / base_profile
 *   2. competitive_context.brand_name              -> high  / competitive_context
 *   3. og:site_name / cleaned <title>              -> high  / site_title
 *   4. apex domain label (not low-confidence)      -> medium/ apex_domain
 *   5. apex domain label (short/acronym)           -> low   / apex_acronym
 *   6. nothing usable                              -> low   / none  ("Unknown Brand")
 *
 * @param {object} baseProfile - Base profile from the initial LLM call
 * @param {string} baseURL - Site base URL
 * @param {object} log - Logger instance
 * @returns {Promise<{name: string, confidence: string, source: string,
 *   siteHost: string, registrableDomain: string}>}
 */
export async function resolveBrandName(baseProfile, baseURL, log) {
  let siteHost = '';
  try {
    siteHost = new URL(baseURL).hostname;
  } catch {
    // baseURL is validated upstream; keep empty host on parse failure.
    siteHost = '';
  }

  const { apexLabel, registrableDomain } = splitHost(siteHost);

  const build = (name, confidence, source) => ({
    name, confidence, source, siteHost, registrableDomain,
  });

  const mpName = baseProfile?.main_profile?.brand_name;
  if (hasText(mpName)) {
    return build(mpName, 'high', 'base_profile');
  }

  const ccName = baseProfile?.competitive_context?.brand_name;
  if (hasText(ccName)) {
    return build(ccName, 'high', 'competitive_context');
  }

  const siteName = await fetchSiteName(baseURL, log);
  if (hasText(siteName) && !isLowConfidenceLabel(siteName)) {
    return build(siteName, 'high', 'site_title');
  }

  if (hasText(apexLabel)) {
    const display = apexLabel.charAt(0).toUpperCase() + apexLabel.slice(1);
    if (!isLowConfidenceLabel(apexLabel)) {
      return build(display, 'medium', 'apex_domain');
    }
    return build(display, 'low', 'apex_acronym');
  }

  return build('Unknown Brand', 'low', 'none');
}
