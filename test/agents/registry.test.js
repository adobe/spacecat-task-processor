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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('agents/registry', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns the brand-profile agent from the registry', async () => {
    const mockAgent = {
      id: 'brand-profile',
      run: sandbox.stub().resolves({}),
      persist: sandbox.stub().resolves(),
    };

    const registryModule = await esmock('../../src/agents/registry.js', {
      '../../src/agents/brand-profile/index.js': {
        default: mockAgent,
      },
    });

    const agent = registryModule.getAgent('brand-profile');
    expect(agent).to.equal(mockAgent);
    expect(agent.id).to.equal('brand-profile');
    expect(agent.run).to.be.a('function');
  });

  it('returns null for unknown agent id', async () => {
    const registryModule = await esmock('../../src/agents/registry.js', {
      '../../src/agents/brand-profile/index.js': {
        default: {},
      },
    });
    const agent = registryModule.getAgent('unknown');
    expect(agent).to.equal(null);
  });
});
