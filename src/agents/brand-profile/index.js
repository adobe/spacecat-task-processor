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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import {
  hasText,
  isNonEmptyObject,
  isValidUrl,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { readPromptFile, renderTemplate } from '../base.js';

// Enhanced services
import { createRegionalContextService } from './services/regional-context.js';
import { createCompetitorInferenceService } from './services/competitor-inference.js';
import { createPersonaInferenceService } from './services/persona-inference.js';
import { createProductExtractorService } from './services/product-extractor.js';
import { createWikipediaService } from './services/wikipedia.js';

/**
 * Call the model with system and user prompts.
 * @param {object} options - Call options
 * @returns {Promise<object>} Parsed JSON response
 */
async function callModel({
  env, log, systemPrompt, userPrompt,
}) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });
  const resp = await gpt.fetchChatCompletion(userPrompt, {
    systemPrompt,
    responseFormat: 'json_object',
  });
  const content = resp?.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content);
  } catch (e) {
    log.error('brand-profile: failed to parse model JSON response', { error: e.message, contentPreview: String(content).slice(0, 500) });
    throw new Error('brand-profile: invalid JSON returned by model');
  }
}

/**
 * Extract brand name from base profile or URL.
 * @param {object} baseProfile - Base profile from initial LLM call
 * @param {string} baseURL - Site base URL
 * @returns {string} Brand name
 */
function extractBrandName(baseProfile, baseURL) {
  // Try to get brand name from profile
  if (baseProfile?.main_profile?.brand_name) {
    return baseProfile.main_profile.brand_name;
  }

  // Try competitive_context
  if (baseProfile?.competitive_context?.brand_name) {
    return baseProfile.competitive_context.brand_name;
  }

  // Fall back to domain extraction
  try {
    const url = new URL(baseURL);
    const parts = url.hostname.split('.');
    // Remove www and TLD
    const domainParts = parts.filter((p) => p !== 'www' && p.length > 2);
    if (domainParts.length > 0) {
      return domainParts[0].charAt(0).toUpperCase() + domainParts[0].slice(1);
    }
  /* c8 ignore next 3 */
  } catch {
    // Ignore URL parse errors
  }

  return 'Unknown Brand';
}

/**
 * Extract industry from base profile.
 * @param {object} baseProfile - Base profile from initial LLM call
 * @returns {string} Industry description
 */
function extractIndustry(baseProfile) {
  return baseProfile?.competitive_context?.industry
    || baseProfile?.main_profile?.industry
    || 'General business';
}

/**
 * Extract target audience from base profile.
 * @param {object} baseProfile - Base profile from initial LLM call
 * @returns {string} Target audience description
 */
function extractTargetAudience(baseProfile) {
  return baseProfile?.main_profile?.target_audience || '';
}

/**
 * Run the enhanced brand profile agent.
 * This orchestrates multiple inference services to build a comprehensive profile.
 *
 * @param {object} context - Agent context
 * @param {string} context.baseURL - Site base URL (required)
 * @param {object} [context.params] - Additional parameters
 * @param {boolean} [context.params.enhance] - Whether to run enhanced inference (default: true)
 * @param {string} [context.params.sitemapUrl] - Sitemap URL for product extraction
 * @param {string[]} [context.params.competitors] - Known competitors from LLMO
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Enhanced brand profile
 */
async function run(context, env, log) {
  const {
    baseURL,
    params = {},
  } = context;

  if (!isValidUrl(baseURL)) {
    throw new Error('brand-profile: context.baseURL is required');
  }

  const {
    enhance = true,
    sitemapUrl,
    competitors: llmoCompetitors = [],
  } = params;

  log.info(`brand-profile: starting analysis for ${baseURL} (enhance=${enhance})`);

  // Phase 1: Run the base voice/brand analysis
  const systemPrompt = readPromptFile('brand-profile/system.prompt');
  const userTemplate = readPromptFile('brand-profile/user.prompt');
  const userPrompt = renderTemplate(userTemplate, { baseURL, params: JSON.stringify(params) });

  log.info('brand-profile: running base voice analysis');
  const baseProfile = await callModel({
    env, log, systemPrompt, userPrompt,
  });

  // If enhancement is disabled, return base profile only
  if (!enhance) {
    log.info('brand-profile: enhancement disabled, returning base profile');
    return baseProfile;
  }

  // Extract key fields from base profile for enhanced inference
  const brandName = extractBrandName(baseProfile, baseURL);
  const industry = extractIndustry(baseProfile);
  const targetAudience = extractTargetAudience(baseProfile);

  log.info(`brand-profile: enhancing profile for "${brandName}" in "${industry}"`);

  // Initialize services
  const regionalService = createRegionalContextService(env, log);
  const competitorService = createCompetitorInferenceService(env, log);
  const personaService = createPersonaInferenceService(env, log);
  const productService = createProductExtractorService(env, log);
  const wikipediaService = createWikipediaService(log);

  // Phase 2: Infer region from URL
  log.info('brand-profile: inferring region from URL');
  const regionInference = await regionalService.inferRegionFromUrl(baseURL);
  const countryCode = regionInference.country_code;

  // Phase 3: Infer regional context
  log.info('brand-profile: inferring regional context');
  const regionalContext = await regionalService.inferRegionalContext({
    countryCode,
    industry,
    brandName,
    targetAudience,
  });

  // Combine region inference with regional context
  const enhancedContext = {
    ...regionalContext,
    country_code: countryCode,
    region_inference: regionInference,
  };

  // Phase 4: Infer competitors (if not provided from LLMO)
  let competitors;
  let competitorsSource;

  if (Array.isArray(llmoCompetitors) && llmoCompetitors.length > 0) {
    log.info(`brand-profile: using ${llmoCompetitors.length} competitors from LLMO`);
    competitors = llmoCompetitors.map((c) => ({
      name: typeof c === 'string' ? c : c.name,
      why_competitor: 'From LLMO config',
      source: 'llmo',
    }));
    competitorsSource = 'llmo';
  } else {
    log.info('brand-profile: inferring competitors');
    // Optionally fetch Wikipedia summary for better competitor inference
    const wikiResult = await wikipediaService.fetchSummary(`${brandName} company`);
    const wikiSummary = wikiResult?.summary || '';

    const competitorResult = await competitorService.inferCompetitors({
      brandName,
      industry,
      countryCode,
      wikipediaSummary: wikiSummary,
    });
    competitors = competitorResult.competitors || [];
    competitorsSource = 'inferred';
  }

  // Phase 5: Infer customer personas
  log.info('brand-profile: inferring customer personas');
  const personaResult = await personaService.inferPersonas({
    brandName,
    industry,
    targetAudience,
    competitors,
    countryCode,
  });

  // Phase 6: Extract product catalogue
  log.info('brand-profile: extracting product catalogue');
  let productsResult;

  if (hasText(sitemapUrl)) {
    log.info(`brand-profile: using sitemap for product extraction: ${sitemapUrl}`);
    productsResult = await productService.extractFromSitemap(sitemapUrl, brandName);
  } else {
    // Use Wikipedia/Wikidata extraction
    const wikiText = await wikipediaService.fetchFullText(`${brandName} company`, 12000);
    productsResult = await productService.extractProducts(brandName, wikiText);
  }

  // Assemble the enhanced profile
  const enhancedProfile = {
    ...baseProfile,

    // Regional Context
    languages: enhancedContext.languages,
    primary_language: enhancedContext.primary_language,
    regulatory_context: enhancedContext.regulatory_context,
    key_terminology: enhancedContext.key_terminology,
    market_specifics: enhancedContext.market_specifics,
    currency: enhancedContext.currency,
    business_model: enhancedContext.business_model,
    country_code: enhancedContext.country_code,
    region_inference: enhancedContext.region_inference,

    // Competitors
    competitors,
    competitors_source: competitorsSource,

    // Personas
    personas: personaResult.personas || [],
    personas_source: personaResult.source || 'inferred',

    // Products
    products: {
      items: productsResult.products || [],
      services: productsResult.services || [],
      sub_brands: productsResult.sub_brands || [],
      discontinued: productsResult.discontinued || [],
    },
    products_metadata: productsResult.metadata || {},
  };

  log.info('brand-profile: enhancement complete', {
    languages: enhancedProfile.languages?.length || 0,
    competitors: enhancedProfile.competitors?.length || 0,
    personas: enhancedProfile.personas?.length || 0,
    products: enhancedProfile.products?.items?.length || 0,
  });

  return enhancedProfile;
}

/**
 * Persist the brand profile to the site configuration.
 * @param {object} message - Original message with siteId
 * @param {object} context - Lambda context with dataAccess
 * @param {object} result - Profile result to persist
 * @returns {Promise<object>} Persistence metadata
 */
async function persist(message, context, result) {
  const { log, dataAccess } = context;
  const siteId = message?.siteId;

  if (!isValidUUID(siteId)) {
    log.warn(`brand-profile persist: invalid siteId ${siteId}`);
    return {};
  }

  if (!isNonEmptyObject(result)) {
    log.warn(`brand-profile persist: empty result for site ${siteId}`);
    return {};
  }

  const { Site } = dataAccess;
  const site = await Site.findById(siteId);
  if (!site) {
    log.warn(`brand-profile persist: site not found ${siteId}`);
    return {};
  }
  const cfg = site.getConfig();
  const baseURL = site.getBaseURL();
  const before = cfg.getBrandProfile?.() || {};
  const beforeHash = before?.contentHash || null;
  cfg.updateBrandProfile(result);
  const after = cfg.getBrandProfile?.() || {};
  const afterHash = after?.contentHash || null;
  const changed = beforeHash !== afterHash;
  site.setConfig(Config.toDynamoItem(cfg));
  await site.save();

  // Emit concise summary for observability/Slack step consumers via logs
  const version = after?.version;
  const isDev = context.env.AWS_ENV === 'dev';
  const summary = changed
    ? `:white_check_mark: Brand profile updated to v${version} for ${baseURL}.`
    : `:information_source: Brand profile already up to date (v${version}) for ${baseURL}.`;
  log.info('brand-profile persist:', {
    siteId,
    version,
    changed,
    contentHash: afterHash,
    baseURL,
    summary,
  });

  // Build highlight lines for Slack message
  const highlightLines = [];

  // Voice highlights
  const primaryVoice = Array.isArray(after?.main_profile?.tone_attributes?.primary)
    ? after.main_profile.tone_attributes.primary.slice(0, 3)
    : [];
  if (primaryVoice.length > 0) {
    highlightLines.push(`*Primary voice:* ${primaryVoice.join(', ')}`);
  }
  if (hasText(after?.main_profile?.communication_style)) {
    highlightLines.push(`*Style:* ${after.main_profile.communication_style}`);
  }
  if (hasText(after?.main_profile?.target_audience)) {
    highlightLines.push(`*Audience:* ${after.main_profile.target_audience}`);
  }

  // Enhanced context highlights
  if (after?.country_code) {
    highlightLines.push(`*Region:* ${after.country_code} (${after.region_inference?.confidence || 'unknown'} confidence)`);
  }
  if (after?.business_model) {
    highlightLines.push(`*Business Model:* ${after.business_model}`);
  }
  if (Array.isArray(after?.competitors) && after.competitors.length > 0) {
    const competitorNames = after.competitors.slice(0, 3).map((c) => c.name).join(', ');
    highlightLines.push(`*Top Competitors:* ${competitorNames}`);
  }
  if (Array.isArray(after?.personas) && after.personas.length > 0) {
    const personaNames = after.personas.slice(0, 3).map((p) => p.name).join(', ');
    highlightLines.push(`*Personas:* ${personaNames}`);
  }
  if (after?.products?.items?.length > 0) {
    highlightLines.push(`*Products:* ${after.products.items.length} extracted`);
  }

  const highlightText = highlightLines.join('\n');
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${summary}\n*Site:* ${baseURL}`,
      },
    },
  ];
  if (hasText(highlightText)) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: highlightText,
      },
    });
  }
  const contextElements = [
    { type: 'mrkdwn', text: `*Site ID:* ${siteId}` },
  ];
  if (version) {
    contextElements.push({ type: 'mrkdwn', text: `*Version:* ${version}` });
  }
  if (afterHash) {
    contextElements.push({ type: 'mrkdwn', text: `*Hash:* \`${afterHash}\`` });
  }
  contextElements.push({
    type: 'mrkdwn',
    text: `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/sites/${siteId}/brand-profile`,
  });
  blocks.push({
    type: 'context',
    elements: contextElements,
  });

  return {
    siteId,
    version,
    changed,
    contentHash: afterHash,
    summary,
    notifications: {
      success: {
        text: summary,
        blocks,
      },
    },
  };
}

export default {
  id: 'brand-profile',
  run,
  persist,
};
