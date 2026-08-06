/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import { MockContextBuilder } from '../../shared.js';

use(sinonChai);

const VALID_SITE_ID = '9ae8877a-bbf3-407d-9adb-d6a72ce3c5e3';

/**
 * Build a stub client whose `.rpc(name, params)` consults a per-fn-name queue
 * of fake responses. Each call shifts one off; if the queue is exhausted, the
 * last response is reused. Matches the shape of PostgrestClient.
 */
function makeStubClient(sandbox, byName) {
  const queues = {};
  for (const [name, list] of Object.entries(byName)) {
    queues[name] = Array.isArray(list) ? [...list] : [list];
  }
  return {
    rpc: sandbox.stub().callsFake((fnName, params) => {
      const q = queues[fnName];
      if (!q || q.length === 0) {
        return Promise.resolve({
          data: null,
          error: { message: `no stub queued for ${fnName}`, status: 0 },
        });
      }
      const next = q.length === 1 ? q[0] : q.shift();
      // Pass params through for assertion convenience
      return Promise.resolve(typeof next === 'function' ? next(params) : next);
    }),
  };
}

describe('runUrlInspectorRefresh', () => {
  let sandbox;
  let context;
  let runUrlInspectorRefresh;
  let sleepFn;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Import the handler fresh per test (esm cache isolation). Sleep is faked
    // via deps so retries do not actually wait.
    const mod = await import('../../../src/tasks/url-inspector-refresh/handler.js');
    runUrlInspectorRefresh = mod.runUrlInspectorRefresh;

    sleepFn = sandbox.stub().resolves();

    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .build();

    context.env = {
      POSTGREST_URL: 'https://pgrst.example/v1',
      POSTGREST_API_KEY: 'fake.jwt.token',
      POSTGREST_SCHEMA: 'public',
    };
  });

  afterEach(() => sandbox.restore());

  describe('input validation', () => {
    it('returns 400 when siteId is missing', async () => {
      const res = await runUrlInspectorRefresh({}, context, {
        client: makeStubClient(sandbox, {}),
      });
      expect(res.status).to.equal(400);
      expect(context.log.error).to.have.been.calledWithMatch(/invalid or missing siteId/);
    });

    it('returns 400 when siteId is not a UUID', async () => {
      const res = await runUrlInspectorRefresh({ siteId: 'not-a-uuid' }, context, {
        client: makeStubClient(sandbox, {}),
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 when message itself is null', async () => {
      const res = await runUrlInspectorRefresh(null, context, {
        client: makeStubClient(sandbox, {}),
      });
      expect(res.status).to.equal(400);
    });
  });

  describe('client init', () => {
    it('returns 500 when no PostgrestClient can be built from context.env', async () => {
      context.env = {}; // no POSTGREST_URL / POSTGREST_API_KEY
      const res = await runUrlInspectorRefresh({ siteId: VALID_SITE_ID }, context);
      expect(res.status).to.equal(500);
      const body = await res.json();
      expect(body.message).to.match(/baseUrl is required|apiKey is required/);
      expect(context.log.error).to.have.been.calledWithMatch(/postgrest client init failed/);
    });

    it('builds the PostgrestClient from context.env when no override is provided', async () => {
      // Inject context-built client by mocking postgrestClientFromContext via esmock
      const stubClient = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: [], error: null },
      });
      const mod = await esmock('../../../src/tasks/url-inspector-refresh/handler.js', {
        '../../../src/utils/postgrest-client.js': {
          postgrestClientFromContext: () => stubClient,
        },
      });

      const res = await mod.runUrlInspectorRefresh({ siteId: VALID_SITE_ID }, context);
      expect(res.status).to.equal(200);
      expect(stubClient.rpc).to.have.been.calledWith(
        'rpc_url_inspector_stale_slices_for_site',
        { p_site_id: VALID_SITE_ID },
      );
    });
  });

  describe('staleness query', () => {
    it('returns ok with zeros when no slices are stale', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: [], error: null },
      });
      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn },
      );

      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({
        siteId: VALID_SITE_ID, refreshed: 0, failed: 0, deferred: 0, totalStale: 0,
      });
      expect(client.rpc).to.have.been.calledOnce;
      expect(context.log.info).to.have.been.calledWithMatch(/no stale slices/);
    });

    it('tolerates a null .data payload by treating it as no stale slices', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: null, error: null },
      });
      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn },
      );

      expect(res.status).to.equal(200);
      expect((await res.json()).totalStale).to.equal(0);
    });

    it('uses the real timer-based sleep when no sleepFn is injected', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: [
          { data: null, error: { message: 'transient', status: 503 } },
          { data: [], error: null },
        ],
      });
      // sleepFn omitted on purpose so the default `sleep` runs. Set backoff to
      // 0 in the handler implicitly by using only 2 attempts and accepting the
      // ~250ms wait — keep this test budget tiny by using fake timers.
      const clock = sinon.useFakeTimers();
      const promise = runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client },
      );
      // Advance past the first retry's backoff window (RETRY_BACKOFF_MS * 1)
      await clock.tickAsync(250);
      const res = await promise;
      clock.restore();

      expect(res.status).to.equal(200);
      expect(client.rpc).to.have.been.calledTwice;
    });

    it('retries the staleness query then succeeds on the second attempt', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: [
          { data: null, error: { message: 'transient', status: 503 } },
          { data: [], error: null },
        ],
      });
      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn },
      );

      expect(res.status).to.equal(200);
      expect(client.rpc).to.have.been.calledTwice;
      expect(sleepFn).to.have.been.calledOnce;
      expect(context.log.warn).to.have.been.calledWithMatch(/retrying in/);
    });

    it('returns ok with stalenessFailed=true after attempts are exhausted', async () => {
      // No throw — lets the next 30-min tick retry naturally.
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: {
          data: null,
          error: { message: 'PGRST500', status: 500 },
        },
      });
      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn, attempts: 2 },
      );

      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.include({
        siteId: VALID_SITE_ID,
        refreshed: 0,
        failed: 0,
        deferred: 0,
        totalStale: 0,
        stalenessFailed: true,
      });
      expect(client.rpc).to.have.been.calledTwice;
      expect(context.log.error).to.have.been.calledWithMatch(/staleness query failed/);
    });
  });

  describe('refresh loop', () => {
    const stale2 = [
      { month_start: '2026-04-01', month_end: '2026-04-30' },
      { month_start: '2026-05-01', month_end: '2026-05-31' },
    ];

    it('refreshes every stale month on the happy path', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: stale2, error: null },
        wrpc_refresh_url_inspector_domain_stats: { data: null, error: null },
      });
      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn },
      );

      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({
        siteId: VALID_SITE_ID, refreshed: 2, failed: 0, deferred: 0, totalStale: 2,
      });
      // 1 staleness + 2 refreshes
      expect(client.rpc).to.have.callCount(3);
      expect(client.rpc.secondCall).to.have.been.calledWith(
        'wrpc_refresh_url_inspector_domain_stats',
        { p_site_id: VALID_SITE_ID, p_start_date: '2026-04-01', p_end_date: '2026-04-30' },
      );
      expect(client.rpc.thirdCall).to.have.been.calledWith(
        'wrpc_refresh_url_inspector_domain_stats',
        { p_site_id: VALID_SITE_ID, p_start_date: '2026-05-01', p_end_date: '2026-05-31' },
      );
    });

    it('retries one month, succeeds, then completes the other', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: stale2, error: null },
        wrpc_refresh_url_inspector_domain_stats: [
          { data: null, error: { message: 'deadlock', status: 503 } }, // first month, attempt 1 -> fail
          { data: null, error: null }, // first month, attempt 2 -> ok
          { data: null, error: null }, // second month, attempt 1 -> ok
        ],
      });

      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn },
      );

      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({
        siteId: VALID_SITE_ID, refreshed: 2, failed: 0, deferred: 0, totalStale: 2,
      });
      // 1 staleness + 3 refresh calls (one was retried)
      expect(client.rpc).to.have.callCount(4);
      // one backoff between the failed attempt and its retry
      expect(sleepFn).to.have.been.calledOnce;
    });

    it('isolates per-month failures: month 1 keeps failing, month 2 succeeds', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: stale2, error: null },
        wrpc_refresh_url_inspector_domain_stats: [
          { data: null, error: { message: 'boom', status: 500 } }, // month 1, attempt 1
          { data: null, error: { message: 'boom', status: 500 } }, // month 1, attempt 2 -> declared failed
          { data: null, error: null }, // month 2, attempt 1 -> ok
        ],
      });

      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        { client, sleepFn },
      );

      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({
        siteId: VALID_SITE_ID, refreshed: 1, failed: 1, deferred: 0, totalStale: 2,
      });
      expect(client.rpc).to.have.callCount(4);
      expect(context.log.error).to.have.been.calledWithMatch(
        /refresh failed for site.*month 2026-04-01/,
      );
      // structured log line emitted
      const errorLogLine = context.log.info.getCalls()
        .map((c) => c.args[0])
        .find((m) => typeof m === 'string' && m.includes('"status":"error"'));
      expect(errorLogLine).to.exist;
    });

    it('defers remaining months when the per-invocation budget is exhausted', async () => {
      let nowOffset = 0;
      const clock = sandbox.stub(Date, 'now').callsFake(() => 1_000_000 + nowOffset);

      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: stale2, error: null },
        wrpc_refresh_url_inspector_domain_stats: () => {
          // Each successful refresh "advances" the clock past the budget
          nowOffset += 200;
          return { data: null, error: null };
        },
      });

      const res = await runUrlInspectorRefresh(
        { siteId: VALID_SITE_ID },
        context,
        {
          client, sleepFn, budgetMs: 100,
        },
      );

      expect(res.status).to.equal(200);
      const body = await res.json();
      expect(body).to.deep.equal({
        siteId: VALID_SITE_ID, refreshed: 1, failed: 0, deferred: 1, totalStale: 2,
      });
      expect(context.log.warn).to.have.been.calledWithMatch(/budget exhausted/);

      clock.restore();
    });

    it('emits one structured success log line per refreshed month', async () => {
      const client = makeStubClient(sandbox, {
        rpc_url_inspector_stale_slices_for_site: { data: stale2, error: null },
        wrpc_refresh_url_inspector_domain_stats: { data: null, error: null },
      });

      await runUrlInspectorRefresh({ siteId: VALID_SITE_ID }, context, { client, sleepFn });

      const structured = context.log.info.getCalls()
        .map((c) => c.args[0])
        .filter((m) => typeof m === 'string' && m.includes('"event":"url-inspector-refresh.refresh"'));
      expect(structured).to.have.lengthOf(2);
      for (const line of structured) {
        const parsed = JSON.parse(line);
        expect(parsed).to.have.property('siteId', VALID_SITE_ID);
        expect(parsed).to.have.property('status', 'ok');
        expect(parsed).to.have.property('attempts');
        expect(parsed).to.have.property('durationMs');
      }
    });
  });
});
