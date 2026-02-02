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

/* eslint-env mocha */

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);
use(chaiAsPromised);

describe('services/regional-context', () => {
  let sandbox;
  let log;
  let gpt;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    gpt = {
      fetchChatCompletion: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('inferRegionFromUrl', () => {
    it('infers region from URL using LLM', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              country_code: 'CH',
              confidence: 'high',
              detection_method: 'tld',
              reasoning: 'Swiss ccTLD',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionFromUrl('https://swisslife.ch', gpt, log);

      expect(result.country_code).to.equal('CH');
      expect(result.confidence).to.equal('high');
      expect(result.detection_method).to.equal('tld');
    });

    it('returns fallback on LLM error', async () => {
      gpt.fetchChatCompletion.rejects(new Error('API error'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionFromUrl('https://example.com', gpt, log);

      expect(result.country_code).to.equal('US');
      expect(result.confidence).to.equal('low');
      expect(result.detection_method).to.equal('fallback');
    });

    it('normalizes invalid country codes to US', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              country_code: 'INVALID',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionFromUrl('https://example.com', gpt, log);

      expect(result.country_code).to.equal('US');
    });

    it('handles LLM response with empty choices array', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionFromUrl('https://example.com', gpt, log);

      // Should use fallback '{}' and default to US
      expect(result.country_code).to.equal('US');
    });

    it('handles LLM response with null message content', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: null } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionFromUrl('https://example.com', gpt, log);

      // Should use fallback '{}' and default to US
      expect(result.country_code).to.equal('US');
    });

    it('handles missing confidence, detection_method, and reasoning', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              country_code: 'DE',
              // Missing: confidence, detection_method, reasoning
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionFromUrl('https://example.de', gpt, log);

      expect(result.country_code).to.equal('DE');
      expect(result.confidence).to.equal('medium');
      expect(result.detection_method).to.equal('unknown');
      expect(result.reasoning).to.equal('');
    });
  });

  describe('inferRegionalContext', () => {
    it('infers regional context for Swiss insurance', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['de-CH', 'fr-CH', 'it-CH'],
              primary_language: 'de-CH',
              regulatory_context: 'Swiss 3-pillar pension system',
              key_terminology: {
                de: ['Säule 3a', 'Pensionskasse'],
                fr: ['3ème pilier'],
              },
              market_specifics: 'Swiss market specifics',
              currency: 'CHF',
              business_model: 'B2B & B2C',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'CH',
        industry: 'Insurance',
        brandName: 'Swiss Life',
        targetAudience: 'Swiss consumers',
      }, gpt, log);

      expect(result.languages).to.deep.equal(['de-CH', 'fr-CH', 'it-CH']);
      expect(result.primary_language).to.equal('de-CH');
      expect(result.currency).to.equal('CHF');
      expect(result.business_model).to.equal('B2B & B2C');
    });

    it('returns fallback on parse error', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: 'not-json' } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'DE',
        industry: 'Technology',
        brandName: 'Test',
      }, gpt, log);

      // Should use fallback
      expect(result.languages).to.deep.equal(['de-DE']);
      expect(result.currency).to.equal('EUR');
    });

    it('normalizes business model values', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
              business_model: 'b2b',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Enterprise Software',
        brandName: 'Test',
      }, gpt, log);

      expect(result.business_model).to.equal('B2B');
    });

    it('normalizes null business model to B2C', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
              business_model: null, // Null value
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      expect(result.business_model).to.equal('B2C');
    });

    it('uses default values when industry and brandName are null', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: null, // Null industry
        brandName: null, // Null brandName
      }, gpt, log);

      expect(result.languages).to.deep.equal(['en-US']);
    });

    it('uses fallback languages when LLM returns empty', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: [],
              primary_language: null,
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'CH',
        industry: 'Insurance',
        brandName: 'Test',
      }, gpt, log);

      expect(result.languages).to.deep.equal(['de-CH', 'fr-CH', 'it-CH']);
      expect(result.primary_language).to.equal('de-CH');
    });

    it('uses default en-US for unknown country code when LLM returns empty languages', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: [], // Empty languages
              // Use unknown country code that's not in COUNTRY_LANGUAGES
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      // Use a country code that's NOT in COUNTRY_LANGUAGES (e.g., 'ZZ' or 'XX')
      const result = await mod.inferRegionalContext({
        countryCode: 'ZZ', // Unknown country code
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      // Should fall back to default ['en-US'] when country not in map
      expect(result.languages).to.deep.equal(['en-US']);
    });

    it('uses fallback currency when not provided', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-GB'],
              currency: null,
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'GB',
        industry: 'Finance',
        brandName: 'Test',
      }, gpt, log);

      expect(result.currency).to.equal('GBP');
    });

    it('handles missing regulatory context and market specifics', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      expect(result.regulatory_context).to.equal('');
      expect(result.market_specifics).to.equal('');
      expect(result.key_terminology).to.deep.equal({});
    });

    it('handles missing business model', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
              business_model: null,
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      expect(result.business_model).to.equal('B2C');
    });

    it('uses default country code when null', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: null,
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      expect(result).to.have.property('languages');
    });

    it('retries on parse error and eventually returns fallback', async () => {
      gpt.fetchChatCompletion
        .onFirstCall()
        .resolves({ choices: [{ message: { content: 'bad-json' } }] })
        .onSecondCall()
        .resolves({ choices: [{ message: { content: 'still-bad' } }] })
        .onThirdCall()
        .resolves({ choices: [{ message: { content: 'still-bad' } }] });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'JP',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      expect(result.languages).to.deep.equal(['ja-JP']);
      expect(log.warn).to.have.been.called;
    });

    it('uses fallback for unknown country code', async () => {
      gpt.fetchChatCompletion
        .resolves({ choices: [{ message: { content: 'invalid-json' } }] })
        .onSecondCall()
        .resolves({ choices: [{ message: { content: 'still-bad' } }] })
        .onThirdCall()
        .resolves({ choices: [{ message: { content: 'still-bad' } }] });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      // Use an unknown country code that's not in COUNTRY_LANGUAGES
      const result = await mod.inferRegionalContext({
        countryCode: 'ZZ',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      // Should use fallback ['en-US'] when country not found
      expect(result.languages).to.deep.equal(['en-US']);
    });

    it('handles LLM response with empty choices array', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      // Should use fallback '{}' and return with default values
      expect(result.languages).to.deep.equal(['en-US']);
    });

    it('handles LLM response with null message content', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: null } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      // Should use fallback '{}' and return with default values
      expect(result.languages).to.deep.equal(['en-US']);
    });

    it('handles missing primary_language by using first language', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['de-DE', 'en-DE'],
              primary_language: null, // Missing
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'DE',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      // primary_language should be first language
      expect(result.primary_language).to.equal('de-DE');
    });

    it('handles key_terminology with non-array values', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              languages: ['en-US'],
              key_terminology: {
                en: ['term1', 'term2'],
                de: 'not-an-array', // Invalid, should be array
                fr: null, // Null
              },
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferRegionalContext({
        countryCode: 'US',
        industry: 'Tech',
        brandName: 'Test',
      }, gpt, log);

      expect(result.key_terminology).to.have.property('en');
    });
  });

  describe('formatTerminologyForPrompt', () => {
    it('formats terminology with regulatory context', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {},
      );

      const result = mod.formatTerminologyForPrompt(
        { de: ['Säule 3a', 'BVG'], fr: ['3ème pilier'] },
        'Swiss pension system',
      );

      expect(result).to.include('Regulatory Context: Swiss pension system');
      expect(result).to.include('[de]: Säule 3a, BVG');
      expect(result).to.include('[fr]: 3ème pilier');
    });

    it('returns default message when empty', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {},
      );

      const result = mod.formatTerminologyForPrompt({}, '');

      expect(result).to.equal('No specific regional terminology available.');
    });

    it('handles null terminology', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {},
      );

      const result = mod.formatTerminologyForPrompt(null, 'Some context');

      expect(result).to.include('Regulatory Context: Some context');
    });

    it('handles terminology with empty arrays', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {},
      );

      const result = mod.formatTerminologyForPrompt(
        { de: [], fr: [] },
        '',
      );

      // The header is added but no terms, so just the header line
      expect(result).to.include('Industry Terminology');
    });

    it('truncates long terminology lists', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {},
      );

      const longTerms = Array.from({ length: 20 }, (_, i) => `term${i}`);
      const result = mod.formatTerminologyForPrompt({ de: longTerms }, '');

      // Should only include first 15 terms
      expect(result).to.include('term0');
      expect(result).to.include('term14');
      expect(result).not.to.include('term15');
    });
  });

  describe('createRegionalContextService', () => {
    it('creates service with bound methods', async () => {
      const createFrom = sandbox.stub().returns(gpt);

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/regional-context.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom },
          },
        },
      );

      const service = mod.createRegionalContextService({}, log);

      expect(service).to.have.property('inferRegionFromUrl');
      expect(service).to.have.property('inferRegionalContext');
      expect(service).to.have.property('formatTerminologyForPrompt');
    });
  });
});
