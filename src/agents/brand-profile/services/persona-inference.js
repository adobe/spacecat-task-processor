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
 * Persona inference service using LLM.
 *
 * Ported from brandaid/src/services/regional_context.py (PersonaInferenceService)
 */

import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import { readPromptFile, renderTemplate } from '../../base.js';

/**
 * Create generic fallback personas when LLM inference fails.
 * @returns {object} Fallback personas result
 */
function createFallbackPersonas() {
  return {
    personas: [
      {
        name: 'General Consumer',
        role: 'Typical customer researching options',
        needs: 'Finding the best product for their needs',
        unbranded_angle: 'best options in category, top rated products, which is best for',
      },
    ],
    source: 'fallback',
  };
}

/**
 * Format competitors list for injection into persona prompt.
 * @param {Array} competitors - List of competitor objects
 * @returns {string} Formatted string
 */
function formatCompetitorsForPrompt(competitors) {
  if (!Array.isArray(competitors) || competitors.length === 0) {
    return 'No competitors specified';
  }

  const lines = competitors.slice(0, 8).map((comp) => {
    const name = typeof comp === 'string' ? comp : (comp.name || comp);
    return `- ${name}`;
  });

  return lines.join('\n');
}

/**
 * Infer customer personas from brand context.
 * @param {object} params - Parameters
 * @param {string} params.brandName - Brand name
 * @param {string} params.industry - Industry description
 * @param {string} [params.targetAudience] - Target audience description
 * @param {Array} [params.competitors] - List of competitor objects
 * @param {string} [params.countryCode] - Target market country code
 * @param {object} gpt - AzureOpenAIClient instance
 * @param {object} log - Logger instance
 * @returns {Promise<object>} Personas result
 */
export async function inferPersonas({
  brandName,
  industry,
  targetAudience = '',
  competitors = [],
  countryCode = '',
}, gpt, log) {
  log.info(`Inferring personas for ${brandName} in ${industry}`);

  const competitorsFormatted = formatCompetitorsForPrompt(competitors);

  const promptTemplate = readPromptFile('brand-profile/persona-inference.prompt');
  const prompt = renderTemplate(promptTemplate, {
    brand_name: brandName,
    industry: (industry || 'General business').slice(0, 200),
    target_audience: (targetAudience || 'General audience').slice(0, 300),
    country_code: countryCode || 'Global',
    competitors: competitorsFormatted,
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
      const personas = result.personas || [];

      // Validate and format personas
      const formattedPersonas = personas.map((persona) => ({
        name: persona.name || 'Customer',
        role: persona.role || '',
        needs: persona.needs || '',
        unbranded_angle: persona.unbranded_angle || '',
      }));

      log.info(`Inferred ${formattedPersonas.length} personas: ${formattedPersonas.map((p) => p.name).join(', ')}`);

      return {
        personas: formattedPersonas,
        source: 'llm_inferred',
      };
    } catch (e) {
      log.warn(`Persona inference parse error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === maxRetries) {
        log.error(`Failed to parse persona inference after ${maxRetries + 1} attempts`);
        return createFallbackPersonas(brandName);
      }
    }
  }

  return createFallbackPersonas(brandName);
}

/**
 * Format personas for injection into generation prompt.
 * @param {Array} personas - List of persona objects
 * @returns {string} Formatted string for prompt injection
 */
export function formatPersonasForPrompt(personas) {
  if (!Array.isArray(personas) || personas.length === 0) {
    return 'General consumers researching options';
  }

  const lines = personas.slice(0, 5).map((persona) => {
    const name = persona.name || 'Customer';
    const angle = persona.unbranded_angle || '';
    return angle ? `- ${name}: ${angle}` : `- ${name}`;
  });

  /* c8 ignore next */
  return lines.length > 0 ? lines.join('\n') : 'General consumers researching options';
}

/**
 * Create a PersonaInferenceService instance bound to GPT client.
 * @param {object} env - Environment variables
 * @param {object} log - Logger instance
 * @returns {object} Service instance with bound methods
 */
export function createPersonaInferenceService(env, log) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });

  return {
    inferPersonas: (params) => inferPersonas(params, gpt, log),
    formatPersonasForPrompt,
  };
}
