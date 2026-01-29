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
 * Regional context inference service using LLM.
 *
 * Ported from brandaid/src/services/regional_context.py
 */

import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import { readPromptFile, renderTemplate } from '../../base.js';

// Country code to language mapping (fallback if LLM fails)
const COUNTRY_LANGUAGES = {
  US: ['en-US'],
  GB: ['en-GB'],
  DE: ['de-DE'],
  AT: ['de-AT'],
  CH: ['de-CH', 'fr-CH', 'it-CH'],
  FR: ['fr-FR'],
  IT: ['it-IT'],
  ES: ['es-ES'],
  NL: ['nl-NL'],
  BE: ['nl-BE', 'fr-BE'],
  JP: ['ja-JP'],
  BR: ['pt-BR'],
  AU: ['en-AU'],
  CA: ['en-CA', 'fr-CA'],
  IN: ['en-IN'],
  MX: ['es-MX'],
  PT: ['pt-PT'],
  PL: ['pl-PL'],
  SE: ['sv-SE'],
  NO: ['no-NO'],
  DK: ['da-DK'],
  FI: ['fi-FI'],
};

// Currency mapping by country code
const CURRENCY_MAP = {
  US: 'USD',
  GB: 'GBP',
  CH: 'CHF',
  JP: 'JPY',
  AU: 'AUD',
  CA: 'CAD',
  IN: 'INR',
  BR: 'BRL',
  MX: 'MXN',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
};

/**
 * Get default currency for a country.
 * @param {string} countryCode - 2-letter ISO country code
 * @returns {string} Currency code
 */
function getDefaultCurrency(countryCode) {
  return CURRENCY_MAP[countryCode] || 'EUR';
}

/**
 * Create minimal fallback context when LLM fails.
 * @param {string} countryCode - 2-letter ISO country code
 * @returns {object} Fallback regional context
 */
function createFallbackContext(countryCode) {
  const languages = COUNTRY_LANGUAGES[countryCode] || ['en-US'];
  return {
    languages,
    primary_language: languages[0],
    regulatory_context: '',
    key_terminology: {},
    market_specifics: '',
    currency: getDefaultCurrency(countryCode),
    business_model: 'B2C',
  };
}

/**
 * Normalize business model string to standard format.
 * @param {string} bm - Business model value
 * @returns {string} Normalized business model
 */
function normalizeBusinessModel(bm) {
  const upper = (bm || '').toUpperCase();
  if (upper.includes('B2B') && upper.includes('B2C')) {
    return 'B2B & B2C';
  }
  if (upper.includes('B2B')) {
    return 'B2B';
  }
  return 'B2C';
}

/**
 * Call the LLM to infer region from URL.
 * @param {string} url - Website URL to analyze
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Region inference result
 */
export async function inferRegionFromUrl(url, gpt, log) {
  log.info(`Inferring region from URL: ${url}`);

  const promptTemplate = readPromptFile('brand-profile/region-from-url.prompt');
  const prompt = renderTemplate(promptTemplate, { url });

  try {
    const resp = await gpt.fetchChatCompletion(prompt, {
      responseFormat: 'json_object',
      temperature: 0.1,
    });

    const content = resp?.choices?.[0]?.message?.content || '{}';
    const result = JSON.parse(content);

    // Validate and normalize
    let countryCode = (result.country_code || 'US').toUpperCase();
    if (countryCode.length !== 2) {
      countryCode = 'US';
    }

    result.country_code = countryCode;
    result.confidence = result.confidence || 'medium';
    result.detection_method = result.detection_method || 'unknown';
    result.reasoning = result.reasoning || '';

    log.info(`Region inferred: ${countryCode} (${result.confidence} confidence via ${result.detection_method})`);

    return result;
  } catch (e) {
    log.error(`Error inferring region from URL: ${e.message}`);
    return {
      country_code: 'US',
      confidence: 'low',
      detection_method: 'fallback',
      reasoning: `Could not analyze URL, defaulting to US: ${e.message}`,
    };
  }
}

/**
 * Infer regional context from country code and industry.
 * @param {object} params - Parameters
 * @param {string} params.countryCode - 2-letter ISO country code
 * @param {string} params.industry - Industry description
 * @param {string} params.brandName - Brand name for context
 * @param {string} [params.targetAudience] - Target audience description
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Regional context
 */
export async function inferRegionalContext({
  countryCode,
  industry,
  brandName,
  targetAudience = '',
}, gpt, log) {
  const normalizedCountryCode = (countryCode || 'US').toUpperCase().trim();

  log.info(`Inferring regional context for ${normalizedCountryCode} / ${industry}`);

  const promptTemplate = readPromptFile('brand-profile/regional-inference.prompt');
  const prompt = renderTemplate(promptTemplate, {
    country_code: normalizedCountryCode,
    industry: (industry || 'General business').slice(0, 200),
    brand_name: brandName || 'Unknown',
    target_audience: (targetAudience || 'General audience').slice(0, 300),
  });

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resp = await gpt.fetchChatCompletion(prompt, {
        responseFormat: 'json_object',
        temperature: 0.3,
      });

      const content = resp?.choices?.[0]?.message?.content || '{}';
      const result = JSON.parse(content);

      // Validate required fields with fallbacks
      if (!result.languages || !result.languages.length) {
        result.languages = COUNTRY_LANGUAGES[normalizedCountryCode] || ['en-US'];
      }
      if (!result.primary_language) {
        [result.primary_language] = result.languages;
      }
      if (!result.key_terminology) {
        result.key_terminology = {};
      }
      if (!result.regulatory_context) {
        result.regulatory_context = '';
      }
      if (!result.market_specifics) {
        result.market_specifics = '';
      }
      if (!result.currency) {
        result.currency = getDefaultCurrency(normalizedCountryCode);
      }
      if (!result.business_model) {
        result.business_model = 'B2C';
      }

      result.business_model = normalizeBusinessModel(result.business_model);

      const termCount = Object.values(result.key_terminology)
        .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

      log.info(`Regional context inferred: ${result.languages.length} languages, ${termCount} terms, business_model=${result.business_model}`);

      return result;
    } catch (e) {
      log.warn(`Regional context parse error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === maxRetries) {
        log.error(`Failed to parse regional context after ${maxRetries + 1} attempts`);
        return createFallbackContext(normalizedCountryCode);
      }
    }
  }

  return createFallbackContext(normalizedCountryCode);
}

/**
 * Format regional terminology for use in generation prompts.
 * @param {object} keyTerminology - Dict mapping language codes to term lists
 * @param {string} regulatoryContext - Regulatory context description
 * @returns {string} Formatted string for prompt injection
 */
export function formatTerminologyForPrompt(keyTerminology, regulatoryContext) {
  const lines = [];

  if (regulatoryContext) {
    lines.push(`Regulatory Context: ${regulatoryContext}`);
    lines.push('');
  }

  if (keyTerminology && Object.keys(keyTerminology).length > 0) {
    lines.push('Industry Terminology (use these exact terms):');
    Object.entries(keyTerminology).forEach(([lang, terms]) => {
      if (Array.isArray(terms) && terms.length > 0) {
        const termsStr = terms.slice(0, 15).join(', ');
        lines.push(`  [${lang}]: ${termsStr}`);
      }
    });
  }

  return lines.length > 0 ? lines.join('\n') : 'No specific regional terminology available.';
}

/**
 * Create a RegionalContextService instance bound to GPT client.
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createRegionalContextService(env, log) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });

  return {
    inferRegionFromUrl: (url) => inferRegionFromUrl(url, gpt, log),
    inferRegionalContext: (params) => inferRegionalContext(params, gpt, log),
    formatTerminologyForPrompt,
  };
}
