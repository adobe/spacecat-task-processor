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

/**
 * Manual integration test for running the brand-profile agent through the agent executor.
 *
 * This test is skipped unless BRAND_PROFILE_IT=1 and the required Azure env vars are defined.
 * Run locally with something like:
 *
 *   export BRAND_PROFILE_IT=1
 *   export AZURE_OPENAI_ENDPOINT=...
 *   export AZURE_OPENAI_KEY=...
 *   export AZURE_API_VERSION=...
 *   export AZURE_COMPLETION_DEPLOYMENT=...
 *   export BRAND_PROFILE_TEST_BASE_URL=https://example.com
 *   npx mocha test/it/agent-executor/brand-profile.test.js
 */

import { expect } from 'chai';

const REQUIRED_ENV = [
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_KEY',
  'AZURE_API_VERSION',
  'AZURE_COMPLETION_DEPLOYMENT',
];

const enabled = process.env.BRAND_PROFILE_IT === '1';
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (enabled && missingEnv.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(`Skipping brand-profile IT: missing env vars ${missingEnv.join(', ')}`);
}
if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('Skipping brand-profile IT: set BRAND_PROFILE_IT=1 to enable.');
}

const shouldRun = enabled && missingEnv.length === 0;
const describeFn = shouldRun ? describe : describe.skip;

describeFn('IT: brand-profile agent via agent-executor', () => {
  let runAgentExecutor;

  before(async () => {
    ({ runAgentExecutor } = await import('../../../src/tasks/agent-executor/handler.js'));
  });

  it('invokes brand-profile agent end-to-end', async () => {
    const message = {
      type: 'agent-executor',
      agentId: 'brand-profile',
      context: {
        baseURL: process.env.BRAND_PROFILE_TEST_BASE_URL || 'https://experienceleague.adobe.com',
        // No siteId => no persistence, just returns results
      },
    };

    const context = {
      env: process.env,
      log: console,
      dataAccess: {}, // persistence skipped; provide real Site access if needed
    };

    const resp = await runAgentExecutor(message, context);
    expect(resp.status).to.equal(200);
    const body = await resp.json();
    expect(body.agentId).to.equal('brand-profile');
    expect(body.result).to.be.an('object');

    const fullOutput = process.env.BRAND_PROFILE_IT_FULL === '1';
    const serialized = JSON.stringify(body.result, null, 2);
    const preview = fullOutput ? serialized : serialized.slice(0, 2000);
    // eslint-disable-next-line no-console
    console.info(`Brand profile response preview (${fullOutput ? 'full' : 'truncated'}):`, preview);
  }).timeout(60_000);
});
