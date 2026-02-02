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

describe('services/persona-inference', () => {
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

  describe('inferPersonas', () => {
    it('infers customer personas from brand context', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [
                {
                  name: 'Empty Nester',
                  role: 'Retired couple planning finances',
                  needs: 'Secure retirement income',
                  unbranded_angle: 'best pension options for retirees',
                },
                {
                  name: 'Young Professional',
                  role: 'Career-focused individual',
                  needs: 'Building wealth early',
                  unbranded_angle: 'tax-advantaged savings for young workers',
                },
              ],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Swiss Life',
        industry: 'Insurance',
        targetAudience: 'Swiss consumers',
        competitors: [{ name: 'AXA' }],
        countryCode: 'CH',
      }, gpt, log);

      expect(result.personas).to.have.length(2);
      expect(result.personas[0].name).to.equal('Empty Nester');
      expect(result.personas[0].unbranded_angle).to.include('retirees');
      expect(result.source).to.equal('llm_inferred');
    });

    it('returns fallback persona on LLM error', async () => {
      gpt.fetchChatCompletion.rejects(new Error('API error'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.personas).to.have.length(1);
      expect(result.personas[0].name).to.equal('General Consumer');
      expect(result.source).to.equal('fallback');
    });

    it('handles competitors as string array', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [{
                name: 'Test Persona', role: 'Role', needs: 'Needs', unbranded_angle: 'angle',
              }],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
        competitors: ['Competitor1', 'Competitor2'],
      }, gpt, log);

      expect(result.personas).to.have.length(1);
    });

    it('retries on parse error and succeeds on second attempt', async () => {
      gpt.fetchChatCompletion
        .onFirstCall().resolves({ choices: [{ message: { content: 'invalid' } }] })
        .onSecondCall().resolves({
          choices: [{
            message: {
              content: JSON.stringify({
                personas: [{ name: 'RetryPersona', role: 'Role', needs: 'Needs' }],
              }),
            },
          }],
        });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.personas).to.have.length(1);
      expect(result.personas[0].name).to.equal('RetryPersona');
      expect(log.warn).to.have.been.called;
    });

    it('returns fallback after all retries fail', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: 'always-bad-json' } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.personas).to.have.length(1);
      expect(result.personas[0].name).to.equal('General Consumer');
      expect(result.source).to.equal('fallback');
      expect(log.error).to.have.been.called;
    });

    it('handles empty personas array from LLM', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.personas).to.deep.equal([]);
      expect(result.source).to.equal('llm_inferred');
    });

    it('handles null personas from LLM', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: null,
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.personas).to.deep.equal([]);
    });

    it('uses default values for missing optional params', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [{ name: 'Persona1' }],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: null,
        targetAudience: '',
        competitors: null,
        countryCode: '',
      }, gpt, log);

      expect(result.personas).to.have.length(1);
    });

    it('handles competitors with objects in array', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [{ name: 'Persona' }],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
        competitors: [
          { name: 'Comp1', why_competitor: 'Reason1' },
          { name: 'Comp2' },
        ],
      }, gpt, log);

      expect(result.personas).to.have.length(1);
    });

    it('handles competitor objects without name property (uses object itself)', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [{ name: 'Persona' }],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      // Pass competitors as objects without name property - should fallback to using the object
      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
        competitors: [
          { why_competitor: 'Reason but no name' },
          { name: null, why_competitor: 'Name is null' },
        ],
      }, gpt, log);

      expect(result.personas).to.have.length(1);
    });

    it('handles LLM response with empty choices array', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      // Should use fallback '{}' and return empty personas
      expect(result.personas).to.deep.equal([]);
      expect(result.source).to.equal('llm_inferred');
    });

    it('handles LLM response with null message content', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: null } }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      // Should use fallback '{}' and return empty personas
      expect(result.personas).to.deep.equal([]);
    });

    it('handles personas with missing name field (uses Customer)', async () => {
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              personas: [
                { role: 'Role only', needs: 'Needs', unbranded_angle: 'angle' },
                { name: null, role: 'Another role' },
              ],
            }),
          },
        }],
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom: () => gpt },
          },
        },
      );

      const result = await mod.inferPersonas({
        brandName: 'Test',
        industry: 'Tech',
      }, gpt, log);

      expect(result.personas).to.have.length(2);
      expect(result.personas[0].name).to.equal('Customer');
      expect(result.personas[1].name).to.equal('Customer');
    });
  });

  describe('formatPersonasForPrompt', () => {
    it('formats personas with unbranded angles', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {},
      );

      const result = mod.formatPersonasForPrompt([
        { name: 'Empty Nester', unbranded_angle: 'retirement planning options' },
        { name: 'Young Professional', unbranded_angle: 'wealth building strategies' },
      ]);

      expect(result).to.include('- Empty Nester: retirement planning options');
      expect(result).to.include('- Young Professional: wealth building strategies');
    });

    it('returns default message for empty list', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {},
      );

      const result = mod.formatPersonasForPrompt([]);

      expect(result).to.equal('General consumers researching options');
    });

    it('limits to 5 personas', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {},
      );

      const personas = Array.from({ length: 10 }, (_, i) => ({
        name: `Persona${i}`,
        unbranded_angle: 'angle',
      }));

      const result = mod.formatPersonasForPrompt(personas);
      const lines = result.split('\n');

      expect(lines).to.have.length(5);
    });

    it('handles personas without unbranded_angle', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {},
      );

      const result = mod.formatPersonasForPrompt([
        { name: 'Test Persona' },
      ]);

      expect(result).to.include('- Test Persona');
    });

    it('handles personas with missing name (uses Customer)', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {},
      );

      const result = mod.formatPersonasForPrompt([
        { unbranded_angle: 'angle only' },
        { name: null, unbranded_angle: 'name is null' },
      ]);

      expect(result).to.include('- Customer: angle only');
      expect(result).to.include('- Customer: name is null');
    });

    it('handles non-array input', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {},
      );

      const result = mod.formatPersonasForPrompt(null);

      expect(result).to.equal('General consumers researching options');
    });
  });

  describe('createPersonaInferenceService', () => {
    it('creates service with bound methods', async () => {
      const createFrom = sandbox.stub().returns(gpt);

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/persona-inference.js',
        {
          '@adobe/spacecat-shared-gpt-client': {
            AzureOpenAIClient: { createFrom },
          },
        },
      );

      const service = mod.createPersonaInferenceService({}, log);

      expect(service).to.have.property('inferPersonas');
      expect(service).to.have.property('formatPersonasForPrompt');
    });
  });
});
