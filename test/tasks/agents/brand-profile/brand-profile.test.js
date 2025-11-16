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

  it('run() calls Azure client with system/user prompts and parses JSON', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: { content: '{"ok":true,"n":1}' } }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../../src/tasks/agents/base.js': {
        readPromptFile: sandbox.stub()
          .onFirstCall()
          .returns('SYS_PROMPT')
          .onSecondCall()
          .returns('USER_TEMPLATE'),
        renderTemplate: sandbox.stub().returns('USER_RENDERED'),
      },
    });

    const result = await mod.default.run(
      { baseURL: 'https://example.com', params: { a: 1 } },
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
    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '../../../../src/tasks/agents/base.js': {
        readPromptFile: sandbox.stub(),
        renderTemplate: sandbox.stub(),
      },
    });
    await expect(mod.default.run({ baseURL: 'not-a-url' }, env, log))
      .to.be.rejectedWith('brand-profile: context.baseURL is required');
  });

  it('run() throws when model returns non-JSON content and logs error', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: { content: 'not-json' } }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../../src/tasks/agents/base.js': {
        readPromptFile: sandbox.stub()
          .onFirstCall()
          .returns('SYS_PROMPT')
          .onSecondCall()
          .returns('USER_TEMPLATE'),
        renderTemplate: sandbox.stub().returns('USER_RENDERED'),
      },
    });

    await expect(mod.default.run({ baseURL: 'https://example.com' }, env, log))
      .to.be.rejectedWith('brand-profile: invalid JSON returned by model');
    expect(log.error).to.have.been.calledWithMatch('brand-profile: failed to parse model JSON response');
  });

  it('run() falls back to empty object when model omits content', async () => {
    const fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: {} }],
    });
    const createFrom = sandbox.stub().returns({ fetchChatCompletion });

    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-gpt-client': {
        AzureOpenAIClient: { createFrom },
      },
      '../../../../src/tasks/agents/base.js': {
        readPromptFile: sandbox.stub()
          .onFirstCall()
          .returns('SYS_PROMPT')
          .onSecondCall()
          .returns('USER_TEMPLATE'),
        renderTemplate: sandbox.stub().returns('USER_RENDERED'),
      },
    });

    const result = await mod.default.run(
      { baseURL: 'https://example.org' },
      env,
      log,
    );
    expect(result).to.deep.equal({});
  });

  it('persist() returns early for invalid siteId', async () => {
    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {});

    await mod.default.persist(
      { context: { siteId: 'invalid' } },
      context,
      { ok: true },
    );
    expect(log.warn).to.have.been.calledWith(sinon.match('brand-profile persist: invalid siteId'));
  });

  it('persist() returns early for empty result', async () => {
    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {});
    await mod.default.persist(
      { context: { siteId: '123e4567-e89b-12d3-a456-426614174000' } },
      context,
      {},
    );
    expect(log.warn).to.have.been.calledWith(sinon.match('brand-profile persist: empty result'));
  });

  it('persist() logs and returns when site not found', async () => {
    const findById = sandbox.stub().resolves(null);
    context.dataAccess.Site = { findById };

    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {});
    await mod.default.persist(
      { context: { siteId: '123e4567-e89b-12d3-a456-426614174000' } },
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
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
    });

    await mod.default.persist(
      { context: { siteId: '123e4567-e89b-12d3-a456-426614174000', baseURL: 'https://example.com' } },
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
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
    });

    await mod.default.persist(
      { context: { siteId: '123e4567-e89b-12d3-a456-426614174000', baseURL: 'https://example.com' } },
      context,
      { unchanged: true },
    );

    expect(findById).to.have.been.calledOnce;
    expect(toDynamoItem).to.have.been.calledOnceWithExactly(cfg);
    expect(setConfig).to.have.been.calledOnce;
    expect(save).to.have.been.calledOnce;
    expect(log.info).to.have.been.calledWith(
      'brand-profile persist:',
      sinon.match.has('summary', sinon.match('Brand profile unchanged')),
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
    });
    context.dataAccess.Site = { findById };

    const toDynamoItem = sandbox.stub().callsFake((c) => c);
    const mod = await esmock('../../../../src/tasks/agents/brand-profile/index.js', {
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem },
      },
    });

    await mod.default.persist(
      { context: { siteId: '123e4567-e89b-12d3-a456-426614174000' } },
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
});
