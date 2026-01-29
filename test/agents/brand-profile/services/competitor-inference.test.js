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

describe('services/competitor-inference', () => {
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

  describe('inferCompetitors', () => {
    it('infers competitors from brand context', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              competitors: [
                { name: 'AXA', why_competitor: 'Major Swiss insurer' },
                { name: 'Zurich Insurance', why_competitor: 'Global presence' },
              ],
              market_context: 'Swiss insurance market',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Swiss Life',
        industry: 'Insurance',
        countryCode: 'CH',
        wikipediaSummary: 'Swiss Life is an insurance company...',
      }, gpt, log);

      expect(result.competitors).to.have.length(2);
      expect(result.competitors[0].name).to.equal('AXA');
      expect(result.competitors[0].source).to.equal('llm_inferred');
      expect(result.source).to.equal('llm_inferred');
    });

    it('returns empty competitors on LLM error', async () => {
      gpt.fetchChatCompletion.rejects(new Error('API error'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.competitors).to.deep.equal([]);
      expect(result.source).to.equal('fallback_empty');
    });

    it('handles missing wikipedia summary gracefully', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              competitors: [{ name: 'Competitor1', why_competitor: 'Reason' }],
              market_context: 'Context',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
        // No wikipediaSummary
      }, gpt, log);

      expect(result.competitors).to.have.length(1);
    });

    it('retries on parse error and succeeds on second attempt', async () => {
      gpt.fetchChatCompletion
        .onFirstCall().resolves({ choices: [{ message: { content: 'invalid-json' } }] })
        .onSecondCall().resolves({
          choices: [{
            message: {
              content: JSON.stringify({
                competitors: [{ name: 'RetryCompetitor', why_competitor: 'Reason' }],
              }),
            },
          }],
        });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.competitors).to.have.length(1);
      expect(result.competitors[0].name).to.equal('RetryCompetitor');
      expect(log.warn).to.have.been.called;
    });

    it('returns fallback after all retries fail', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: 'bad-json' } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.competitors).to.deep.equal([]);
      expect(result.source).to.equal('fallback_empty');
      expect(log.error).to.have.been.called;
    });

    it('handles empty competitors array from LLM', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              competitors: [],
              market_context: 'No direct competitors found',
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Niche',
      }, gpt, log);

      expect(result.competitors).to.deep.equal([]);
      expect(result.source).to.equal('llm_inferred');
    });

    it('handles null competitors from LLM', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              competitors: null,
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.competitors).to.deep.equal([]);
    });

    it('uses default values for missing optional params', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              competitors: [{ name: 'Comp1' }],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: null,
        countryCode: '',
        wikipediaSummary: '',
      }, gpt, log);

      expect(result.competitors).to.have.length(1);
    });

    it('handles LLM response with empty choices array', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      // Should use fallback '{}' and return empty competitors
      expect(result.competitors).to.deep.equal([]);
    });

    it('handles competitors with missing name (uses Unknown)', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              competitors: [
                { why_competitor: 'Reason but no name' },
                { name: null, why_competitor: 'Another reason' },
              ],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.competitors).to.have.length(2);
      expect(result.competitors[0].name).to.equal('Unknown');
      expect(result.competitors[1].name).to.equal('Unknown');
    });

    it('handles LLM response with null message content', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: null } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferCompetitors({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      // Should use fallback '{}' and return empty competitors
      expect(result.competitors).to.deep.equal([]);
    });
  });

  describe('formatCompetitorsForPrompt edge cases', () => {
    it('handles competitor with missing name in format', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {},
      );

      const result = mod.formatCompetitorsForPrompt([
        { why_competitor: 'Reason' },
        { name: null },
      ]);

      expect(result).to.include('Unknown');
    });

    it('handles non-array input', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {},
      );

      const result = mod.formatCompetitorsForPrompt(null);

      expect(result).to.equal('No competitors identified');
    });
  });

  describe('formatCompetitorsForPrompt', () => {
    it('formats competitors with reasons', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {},
      );

      const result = mod.formatCompetitorsForPrompt([
        { name: 'AXA', why_competitor: 'Major insurer' },
        { name: 'Zurich' },
      ]);

      expect(result).to.include('- AXA: Major insurer');
      expect(result).to.include('- Zurich');
    });

    it('returns default message for empty list', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {},
      );

      const result = mod.formatCompetitorsForPrompt([]);

      expect(result).to.equal('No competitors identified');
    });

    it('limits to 8 competitors', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {},
      );

      const competitors = Array.from({ length: 15 }, (_, i) => ({
        name: `Competitor${i}`,
        why_competitor: 'Reason',
      }));

      const result = mod.formatCompetitorsForPrompt(competitors);
      const lines = result.split('\n');

      expect(lines).to.have.length(8);
    });
  });

  describe('createCompetitorInferenceService', () => {
    it('creates service with bound methods', async () => {
      const createFrom = sandbox.stub().returns(gpt);

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/competitor-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom },
          },
        },
      );

      const service = mod.createCompetitorInferenceService({}, log);

      expect(service).to.have.property('inferCompetitors');
      expect(service).to.have.property('formatCompetitorsForPrompt');
    });
  });
});
