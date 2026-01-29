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

describe('agents/brand-profile', () => {
  let sandbox;
  let context;
  let env;
  let log;

  // Mock service creators - paths relative to src/agents/brand-profile/index.js
  const createMockServices = (sb) => ({
    '../../../src/agents/brand-profile/services/regional-context.js': {
      createRegionalContextService: () => ({
        inferRegionFromUrl: sb.stub().resolves({
          country_code: 'US',
          confidence: 'medium',
          detection_method: 'default',
          reasoning: 'Default',
        }),
        inferRegionalContext: sb.stub().resolves({
          languages: ['en-US'],
          primary_language: 'en-US',
          regulatory_context: '',
          key_terminology: {},
          market_specifics: '',
          currency: 'USD',
          business_model: 'B2C',
        }),
      }),
    },
    '../../../src/agents/brand-profile/services/competitor-inference.js': {
      createCompetitorInferenceService: () => ({
        inferCompetitors: sb.stub().resolves({
          competitors: [],
          source: 'llm_inferred',
        }),
      }),
    },
    '../../../src/agents/brand-profile/services/persona-inference.js': {
      createPersonaInferenceService: () => ({
        inferPersonas: sb.stub().resolves({
          personas: [],
          source: 'llm_inferred',
        }),
      }),
    },
    '../../../src/agents/brand-profile/services/product-extractor.js': {
      createProductExtractorService: () => ({
        extractFromSitemap: sb.stub().resolves({
          products: [],
          services: [],
          sub_brands: [],
          discontinued: [],
          metadata: { source: 'sitemap', count: 0 },
        }),
        extractProducts: sb.stub().resolves({
          products: [],
          services: [],
          sub_brands: [],
          discontinued: [],
          metadata: { source: 'none', count: 0 },
        }),
      }),
    },
    '../../../src/agents/brand-profile/services/wikipedia.js': {
      createWikipediaService: () => ({
        fetchSummary: sb.stub().resolves(null),
        fetchFullText: sb.stub().resolves(null),
      }),
    },
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    env = {};
    log = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    context = { env, log, dataAccess: {} };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('run() calls Azure client with system/user prompts and parses JSON when enhance=false', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: { content: '{"ok":true,"n":1}' } }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../src/agents/base.js': {
        readPromptFile: sandbox.stub()
          .onFirstCall()
          .returns('SYS_PROMPT')
          .onSecondCall()
          .returns('USER_TEMPLATE'),
        renderTemplate: sandbox.stub().returns('USER_RENDERED'),
      },
      ...createMockServices(sandbox),
    });

    const result = await mod.default.run(
      { baseURL: 'https://example.com', params: { enhance: false, a: 1 } },
      env,
      log,
    );

    expect(createFrom).to.have.been.calledOnceWithExactly({ env, log });
    expect(fetchChatCompletion).to.have.been.calledOnceWithExactly('USER_RENDERED', {
      systemPrompt: 'SYS_PROMPT',
      responseFormat: 'json_object',
    });
    expect(result).to.deep.equal({ ok: true, n: 1 });
  });

  it('run() throws on invalid baseURL', async () => {
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '../../../src/agents/base.js': {
        readPromptFile: sandbox.stub(),
        renderTemplate: sandbox.stub(),
      },
      ...createMockServices(sandbox),
    });
    await expect(mod.default.run({ baseURL: 'not-a-url' }, env, log))
      .to.be.rejectedWith('brand-profile: context.baseURL is required');
  });

  it('run() with enhance=true runs all enhancement services', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{
        message: {
          content: JSON.stringify({
            main_profile: {
              target_audience: 'Consumers',
            },
            competitive_context: {
              industry: 'Technology',
            },
          }),
        },
      }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mockRegionalService = {
      inferRegionFromUrl: sandbox.stub().resolves({
        country_code: 'CH',
        confidence: 'high',
        detection_method: 'tld',
        reasoning: 'Swiss TLD',
      }),
      inferRegionalContext: sandbox.stub().resolves({
        languages: ['de-CH', 'fr-CH'],
        primary_language: 'de-CH',
        regulatory_context: 'Swiss regulations',
        key_terminology: { de: ['term1'] },
        market_specifics: 'Swiss market',
        currency: 'CHF',
        business_model: 'B2B & B2C',
      }),
    };

    const mockCompetitorService = {
      inferCompetitors: sandbox.stub().resolves({
        competitors: [{ name: 'Competitor1', why_competitor: 'Reason', source: 'llm_inferred' }],
        source: 'llm_inferred',
      }),
    };

    const mockPersonaService = {
      inferPersonas: sandbox.stub().resolves({
        personas: [{
          name: 'Persona1', role: 'Role', needs: 'Needs', unbranded_angle: 'angle',
        }],
        source: 'llm_inferred',
      }),
    };

    const mockProductService = {
      extractProducts: sandbox.stub().resolves({
        products: [{ name: 'Product1', category: 'Software' }],
        services: [],
        sub_brands: [],
        discontinued: [],
        metadata: { source: 'wikidata', count: 1 },
      }),
    };

    const mockWikipediaService = {
      fetchSummary: sandbox.stub().resolves({ summary: 'Company summary' }),
      fetchFullText: sandbox.stub().resolves('Full text'),
    };

    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../src/agents/base.js': {
        readPromptFile: sandbox.stub().returns('PROMPT'),
        renderTemplate: sandbox.stub().returns('RENDERED'),
      },
      '../../../src/agents/brand-profile/services/regional-context.js': {
        createRegionalContextService: () => mockRegionalService,
      },
      '../../../src/agents/brand-profile/services/competitor-inference.js': {
        createCompetitorInferenceService: () => mockCompetitorService,
      },
      '../../../src/agents/brand-profile/services/persona-inference.js': {
        createPersonaInferenceService: () => mockPersonaService,
      },
      '../../../src/agents/brand-profile/services/product-extractor.js': {
        createProductExtractorService: () => mockProductService,
      },
      '../../../src/agents/brand-profile/services/wikipedia.js': {
        createWikipediaService: () => mockWikipediaService,
      },
    });

    const result = await mod.default.run(
      { baseURL: 'https://swisslife.ch', params: { enhance: true } },
      env,
      log,
    );

    // Verify all services were called
    expect(mockRegionalService.inferRegionFromUrl).to.have.been.called;
    expect(mockRegionalService.inferRegionalContext).to.have.been.called;
    expect(mockCompetitorService.inferCompetitors).to.have.been.called;
    expect(mockPersonaService.inferPersonas).to.have.been.called;
    expect(mockProductService.extractProducts).to.have.been.called;

    // Verify result includes enhanced data
    expect(result.country_code).to.equal('CH');
    expect(result.languages).to.deep.equal(['de-CH', 'fr-CH']);
    expect(result.currency).to.equal('CHF');
    expect(result.business_model).to.equal('B2B & B2C');
    expect(result.competitors).to.have.length(1);
    expect(result.personas).to.have.length(1);
    expect(result.products.items).to.have.length(1);
  });

  it('run() uses LLMO competitors when provided', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{
        message: {
          content: JSON.stringify({
            main_profile: {},
            competitive_context: { industry: 'Insurance' },
          }),
        },
      }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mockCompetitorService = {
      inferCompetitors: sandbox.stub().resolves({ competitors: [], source: 'llm_inferred' }),
    };

    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../src/agents/base.js': {
        readPromptFile: sandbox.stub().returns('PROMPT'),
        renderTemplate: sandbox.stub().returns('RENDERED'),
      },
      '../../../src/agents/brand-profile/services/regional-context.js': {
        createRegionalContextService: () => ({
          inferRegionFromUrl: sandbox.stub().resolves({ country_code: 'US' }),
          inferRegionalContext: sandbox.stub().resolves({ languages: ['en-US'] }),
        }),
      },
      '../../../src/agents/brand-profile/services/competitor-inference.js': {
        createCompetitorInferenceService: () => mockCompetitorService,
      },
      '../../../src/agents/brand-profile/services/persona-inference.js': {
        createPersonaInferenceService: () => ({
          inferPersonas: sandbox.stub().resolves({ personas: [] }),
        }),
      },
      '../../../src/agents/brand-profile/services/product-extractor.js': {
        createProductExtractorService: () => ({
          extractProducts: sandbox.stub().resolves({ products: [], metadata: {} }),
        }),
      },
      '../../../src/agents/brand-profile/services/wikipedia.js': {
        createWikipediaService: () => ({
          fetchSummary: sandbox.stub().resolves(null),
          fetchFullText: sandbox.stub().resolves(null),
        }),
      },
    });

    const result = await mod.default.run(
      {
        baseURL: 'https://example.com',
        params: {
          enhance: true,
          competitors: ['LLMO Competitor 1', 'LLMO Competitor 2'],
        },
      },
      env,
      log,
    );

    // inferCompetitors should NOT be called when LLMO competitors provided
    expect(mockCompetitorService.inferCompetitors).to.not.have.been.called;
    expect(result.competitors_source).to.equal('llmo');
    expect(result.competitors).to.have.length(2);
    expect(result.competitors[0].name).to.equal('LLMO Competitor 1');
  });

  it('run() throws when model returns non-JSON content and logs error', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: { content: 'not-json' } }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../src/agents/base.js': {
        readPromptFile: sandbox.stub()
          .onFirstCall()
          .returns('SYS_PROMPT')
          .onSecondCall()
          .returns('USER_TEMPLATE'),
        renderTemplate: sandbox.stub().returns('USER_RENDERED'),
      },
      ...createMockServices(sandbox),
    });

    await expect(mod.default.run({ baseURL: 'https://example.com', params: { enhance: false } }, env, log))
      .to.be.rejectedWith('brand-profile: invalid JSON returned by model');
    expect(log.error).to.have.been.calledWithMatch('brand-profile: failed to parse model JSON response');
  });

  it('run() falls back to empty object when model omits content with enhance=false', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: {} }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../src/agents/base.js': {
        readPromptFile: sandbox.stub()
          .onFirstCall()
          .returns('SYS_PROMPT')
          .onSecondCall()
          .returns('USER_TEMPLATE'),
        renderTemplate: sandbox.stub().returns('USER_RENDERED'),
      },
      ...createMockServices(sandbox),
    });

    const result = await mod.default.run(
      { baseURL: 'https://example.org', params: { enhance: false } },
      env,
      log,
    );
    expect(result).to.deep.equal({});
  });

  it('persist() returns early for invalid siteId', async () => {
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {});

    await mod.default.persist(
      { siteId: 'invalid' },
      context,
      { ok: true },
    );
    expect(log.warn).to.have.been.calledWith(sinon.match('brand-profile persist: invalid siteId'));
  });

  it('persist() returns early for empty result', async () => {
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {});
    await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000' },
      context,
      {},
    );
    expect(log.warn).to.have.been.calledWith(sinon.match('brand-profile persist: empty result'));
  });

  it('persist() logs and returns when site not found', async () => {
    const findById = sandbox.stub().resolves(null);
    context.dataAccess.Site = { findById };

    const mod = await esmock('../../../src/agents/brand-profile/index.js', {});
    await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000' },
      context,
      { ok: true },
    );
    expect(findById).to.have.been.calledOnce;
    expect(log.warn).to.have.been.calledWith(sinon.match('brand-profile persist: site not found'));
  });

  it('persist() updates site config, saves, and logs summary when changed', async () => {
    const beforeProfile = { contentHash: 'old', version: 1 };
    let currentProfile = beforeProfile;
    const cfg = {
      getBrandProfile: () => currentProfile,
      updateBrandProfile: (p) => {
        currentProfile = { ...p, contentHash: 'new', version: 2 };
      },
    };
    const setConfig = sinon.stub();
    const save = sinon.stub().resolves();
    const findById = sandbox.stub().resolves({
      getConfig: () => cfg,
      setConfig,
      save,
      getBaseURL: () => 'https://example.com',
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
    });

    await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000', baseURL: 'https://example.com' },
      context,
      { any: 'result' },
    );

    expect(findById).to.have.been.calledOnce;
    expect(toDynamoItem).to.have.been.calledOnceWithExactly(cfg);
    expect(setConfig).to.have.been.calledOnce;
    expect(save).to.have.been.calledOnce;
    expect(log.info).to.have.been.calledWithMatch('brand-profile persist:');
  });

  it('persist() logs unchanged summary when content hash is same', async () => {
    const profile = { contentHash: 'same', version: 5 };
    const cfg = {
      getBrandProfile: () => profile,
      updateBrandProfile: sinon.stub(), // leaves hash unchanged
    };
    const setConfig = sinon.stub();
    const save = sinon.stub().resolves();
    const findById = sandbox.stub().resolves({
      getConfig: () => cfg,
      setConfig,
      save,
      getBaseURL: () => 'https://example.com',
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
    });

    await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000', baseURL: 'https://example.com' },
      context,
      { unchanged: true },
    );

    expect(findById).to.have.been.calledOnce;
    expect(toDynamoItem).to.have.been.calledOnceWithExactly(cfg);
    expect(setConfig).to.have.been.calledOnce;
    expect(save).to.have.been.calledOnce;
    expect(log.info).to.have.been.calledWith(
      'brand-profile persist:',
      sinon.match.has('summary', sinon.match(':information_source: Brand profile already up to date (v5) for https://example.com')),
    );
  });

  it('persist() handles configs without getBrandProfile implementation', async () => {
    const cfg = {
      updateBrandProfile: sinon.stub(),
      // getBrandProfile intentionally undefined to hit fallback branches
    };
    const setConfig = sinon.stub();
    const save = sinon.stub().resolves();
    const findById = sandbox.stub().resolves({
      getConfig: () => cfg,
      setConfig,
      save,
      getBaseURL: () => 'https://example.com',
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
    });

    await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000' },
      context,
      { foo: 'bar' },
    );

    expect(toDynamoItem).to.have.been.calledOnceWithExactly(cfg);
    expect(setConfig).to.have.been.calledOnce;
    expect(save).to.have.been.calledOnce;
    expect(log.info).to.have.been.calledWith(
      'brand-profile persist:',
      sinon.match.object,
    );
  });

  it('persist() includes highlight blocks when main profile data is present', async () => {
    let currentProfile = { version: 1, contentHash: 'old' };
    const cfg = {
      getBrandProfile: () => currentProfile,
      updateBrandProfile: (profile) => {
        currentProfile = { ...profile, version: 2, contentHash: 'new' };
      },
    };
    const setConfig = sinon.stub();
    const save = sinon.stub().resolves();
    const findById = sandbox.stub().resolves({
      getConfig: () => cfg,
      setConfig,
      save,
      getBaseURL: () => 'https://example.com',
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
      ...createMockServices(sandbox),
    });

    const result = await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000' },
      context,
      {
        main_profile: {
          tone_attributes: { primary: ['confident', 'warm', 'pragmatic', 'extra'] },
          communication_style: 'Conversational expert guidance',
          target_audience: 'Digital leaders',
        },
      },
    );

    expect(result.notifications.success.blocks[1]).to.deep.equal({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Primary voice:* confident, warm, pragmatic\n*Style:* Conversational expert guidance\n*Audience:* Digital leaders',
      },
    });
  });

  it('persist() includes enhanced context highlights in Slack blocks', async () => {
    let currentProfile = { version: 1, contentHash: 'old' };
    const cfg = {
      getBrandProfile: () => currentProfile,
      updateBrandProfile: (profile) => {
        currentProfile = { ...profile, version: 2, contentHash: 'new' };
      },
    };
    const setConfig = sinon.stub();
    const save = sinon.stub().resolves();
    const findById = sandbox.stub().resolves({
      getConfig: () => cfg,
      setConfig,
      save,
      getBaseURL: () => 'https://swisslife.ch',
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../src/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
      ...createMockServices(sandbox),
    });

    const result = await mod.default.persist(
      { siteId: '123e4567-e89b-12d3-a456-426614174000' },
      context,
      {
        main_profile: {
          tone_attributes: { primary: ['professional'] },
          target_audience: 'Swiss consumers',
        },
        country_code: 'CH',
        region_inference: { confidence: 'high' },
        business_model: 'B2B & B2C',
        competitors: [
          { name: 'AXA' },
          { name: 'Zurich' },
        ],
        personas: [
          { name: 'Empty Nester' },
          { name: 'Young Professional' },
        ],
        products: {
          items: [{ name: 'Product1' }, { name: 'Product2' }, { name: 'Product3' }],
        },
      },
    );

    const highlightBlock = result.notifications.success.blocks[1];
    expect(highlightBlock.text.text).to.include('*Region:* CH (high confidence)');
    expect(highlightBlock.text.text).to.include('*Business Model:* B2B & B2C');
    expect(highlightBlock.text.text).to.include('*Top Competitors:* AXA, Zurich');
    expect(highlightBlock.text.text).to.include('*Personas:* Empty Nester, Young Professional');
    expect(highlightBlock.text.text).to.include('*Products:* 3 extracted');
  });
});
