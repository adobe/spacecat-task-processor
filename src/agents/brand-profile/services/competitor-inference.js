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
 * Competitor inference service using LLM.
 *
 * Ported from brandaid/src/services/regional_context.py (CompetitorInferenceService)
 */

import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import { readPromptFile, renderTemplate } from '../../base.js';

/**
 * Create empty fallback when LLM inference fails.
 * @param {string} brandName - Brand name
 * @param {string} industry - Industry
 * @returns {object} Empty fallback result
 */
function createFallbackCompetitors(brandName, industry) {
  return {
    competitors: [],
    market_context: `Could not infer competitors for ${brandName} in ${industry}`,
    source: 'fallback_empty',
  };
}

/**
 * Infer competitors from brand context when LLMO data is unavailable.
 * @param {object} params - Parameters
 * @param {string} params.brandName - Brand name
 * @param {string} params.industry - Industry description
 * @param {string} [params.wikipediaSummary] - Company overview from Wikipedia
 * @param {string} [params.countryCode] - Target market country code
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Competitors result
 */
export async function inferCompetitors({
  brandName,
  industry,
  wikipediaSummary = '',
  countryCode = '',
}, gpt, log) {
  log.info(`Inferring competitors for ${brandName} in ${industry}`);

  const promptTemplate = readPromptFile('brand-profile/competitor-inference.prompt');
  const prompt = renderTemplate(promptTemplate, {
    brand_name: brandName,
    industry: (industry || 'General business').slice(0, 200),
    country_code: countryCode || 'Global',
    wikipedia_summary: wikipediaSummary
      ? wikipediaSummary.slice(0, 1500)
      : 'No company overview available.',
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
      const competitors = result.competitors || [];
      const marketContext = result.market_context || '';

      // Format competitors to match expected structure
      const formattedCompetitors = competitors.map((comp) => ({
        name: comp.name || 'Unknown',
        aliases: [],
        urls: [],
        why_competitor: comp.why_competitor || '',
        source: 'llm_inferred',
      }));

      log.info(`Inferred ${formattedCompetitors.length} competitors: ${formattedCompetitors.map((c) => c.name).join(', ')}`);

      return {
        competitors: formattedCompetitors,
        market_context: marketContext,
        source: 'llm_inferred',
      };
    } catch (e) {
      log.warn(`Competitor inference parse error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === maxRetries) {
        log.error(`Failed to parse competitor inference after ${maxRetries + 1} attempts`);
        return createFallbackCompetitors(brandName, industry);
      }
    }
  }

  return createFallbackCompetitors(brandName, industry);
}

/**
 * Format competitors list for injection into generation prompt.
 * @param {Array} competitors - List of competitor objects
 * @returns {string} Formatted string for prompt
 */
export function formatCompetitorsForPrompt(competitors) {
  if (!Array.isArray(competitors) || competitors.length === 0) {
    return 'No competitors identified';
  }

  const lines = [];
  competitors.slice(0, 8).forEach((comp) => {
    const name = comp.name || 'Unknown';
    const why = comp.why_competitor || '';
    if (why) {
      lines.push(`- ${name}: ${why}`);
    } else {
      lines.push(`- ${name}`);
    }
  });

  return lines.join('\n');
}

/**
 * Create a CompetitorInferenceService instance bound to GPT client.
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createCompetitorInferenceService(env, log) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });

  return {
    inferCompetitors: (params) => inferCompetitors(params, gpt, log),
    formatCompetitorsForPrompt,
  };
}
