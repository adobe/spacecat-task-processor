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
import { MockContextBuilder } from '../../shared.js';

use(sinonChai);
use(chaiAsPromised);

describe('agent-executor handler', () => {
  let sandbox;
  let context;
  let runAgentExecutor;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    context = new MockContextBuilder().withSandbox(sandbox).build();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns 400 when agentId is missing', async () => {
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns(null),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: (s) => !!s && s.length > 0,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const resp = await runAgentExecutor({}, context);
    expect(resp.status).to.equal(400);
  });

  it('returns 400 when agent is unknown', async () => {
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns(null),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const message = { agentId: 'unknown', context: {} };
    const resp = await runAgentExecutor(message, context);
    expect(resp.status).to.equal(400);
  });

  it('runs agent without persist and returns result', async () => {
    const runStub = sandbox.stub().resolves({ a: 1 });
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns({ run: runStub }),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const agentContext = { baseURL: 'https://example.com' };
    const message = { agentId: 'brand-profile', context: agentContext };
    const resp = await runAgentExecutor(message, context);
    expect(resp.status).to.equal(200);

    // Assert agent.run called with correct arguments
    expect(runStub).to.have.been.calledOnceWithExactly(agentContext, context.env, context.log);

    const body = await resp.json();
    expect(body.agentId).to.equal('brand-profile');
    expect(body.context).to.deep.equal(agentContext);
    expect(body.result).to.deep.equal({ a: 1 });
  });

  it('runs agent with persist when provided', async () => {
    const runStub = sandbox.stub().resolves({ updated: true });
    const persistStub = sandbox.stub().resolves();
    const getAgent = sandbox.stub().returns({ run: runStub, persist: persistStub });

    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': { getAgent },
      '@adobe/spacecat-shared-utils': { hasText: () => true },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const message = {
      agentId: 'brand-profile',
      context: { baseURL: 'https://example.com', siteId: 'abc' },
    };
    const resp = await runAgentExecutor(message, context);
    expect(resp.status).to.equal(200);
    // Ensure persist receives the full message, context and the run result
    expect(persistStub).to.have.been.calledOnceWithExactly(message, context, { updated: true });
  });

  it('bubbles up errors thrown by agent.run', async () => {
    const runStub = sandbox.stub().rejects(new Error('run failed'));
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns({ run: runStub }),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const message = { agentId: 'brand-profile', context: { baseURL: 'https://example.com' } };
    await expect(runAgentExecutor(message, context)).to.be.rejectedWith('run failed');
  });

  it('bubbles up errors thrown by agent.persist', async () => {
    const runStub = sandbox.stub().resolves({ ok: true });
    const persistStub = sandbox.stub().rejects(new Error('persist failed'));
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns({ run: runStub, persist: persistStub }),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const message = { agentId: 'brand-profile', context: { baseURL: 'https://example.com' } };
    await expect(runAgentExecutor(message, context)).to.be.rejectedWith('persist failed');
  });

  it('returns 400 when message is undefined', async () => {
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns(null),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: (s) => !!s && s.length > 0,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;
    const resp = await runAgentExecutor(undefined, context);
    expect(resp.status).to.equal(400);
  });

  it('includes persistMeta when agent.persist returns non-empty object', async () => {
    const runStub = sandbox.stub().resolves({ ok: true });
    const persistStub = sandbox.stub().resolves({ stored: true, version: 2 });
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns({ run: runStub, persist: persistStub }),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
        isNonEmptyObject: (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const message = { agentId: 'brand-profile', context: { baseURL: 'https://example.com' } };
    const resp = await runAgentExecutor(message, context);
    const body = await resp.json();
    expect(body.result).to.deep.equal({ ok: true });
    expect(body.persistMeta).to.deep.equal({ stored: true, version: 2 });
  });

  it('omits persistMeta when agent.persist returns empty object', async () => {
    const runStub = sandbox.stub().resolves({ ok: true });
    const persistStub = sandbox.stub().resolves({});
    const handlerModule = await esmock('../../../src/tasks/agent-executor/handler.js', {
      '../../../src/tasks/agents/registry.js': {
        getAgent: sandbox.stub().returns({ run: runStub, persist: persistStub }),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
        isNonEmptyObject: (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0,
      },
    });
    runAgentExecutor = handlerModule.runAgentExecutor;

    const message = { agentId: 'brand-profile', context: { baseURL: 'https://example.com' } };
    const resp = await runAgentExecutor(message, context);
    const body = await resp.json();
    expect(body.result).to.deep.equal({ ok: true });
    expect(body).to.not.have.property('persistMeta');
  });
});
