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

import { PostgrestClient, postgrestClientFromContext } from '../../src/utils/postgrest-client.js';

use(sinonChai);

const BASE_URL = 'https://pgrst.example/v1';
const API_KEY = 'fake.jwt.token';

function makeResponse({
  ok: okStatus = true, status = 200, body = null, text,
} = {}) {
  return {
    ok: okStatus,
    status,
    statusText: okStatus ? 'OK' : 'Error',
    text: () => Promise.resolve(text ?? (body == null ? '' : JSON.stringify(body))),
  };
}

describe('PostgrestClient', () => {
  let sandbox;
  let log;
  let fetchStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = { debug: sandbox.spy() };
    fetchStub = sandbox.stub();
  });

  afterEach(() => sandbox.restore());

  describe('constructor', () => {
    it('throws when baseUrl is missing', () => {
      expect(() => new PostgrestClient({ apiKey: API_KEY, fetchImpl: fetchStub }))
        .to.throw(/baseUrl is required/);
    });

    it('throws when apiKey is missing', () => {
      expect(() => new PostgrestClient({ baseUrl: BASE_URL, fetchImpl: fetchStub }))
        .to.throw(/apiKey is required/);
    });

    it('throws when no fetch implementation is available', () => {
      const originalFetch = globalThis.fetch;
      delete globalThis.fetch;
      try {
        expect(() => new PostgrestClient({ baseUrl: BASE_URL, apiKey: API_KEY }))
          .to.throw(/no fetch implementation available/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('uses globalThis.fetch by default when one is available', () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => {};
      try {
        const client = new PostgrestClient({ baseUrl: BASE_URL, apiKey: API_KEY });
        expect(client.fetch).to.equal(globalThis.fetch);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('strips trailing slash from baseUrl', () => {
      const client = new PostgrestClient({
        baseUrl: `${BASE_URL}/`, apiKey: API_KEY, fetchImpl: fetchStub,
      });
      expect(client.baseUrl).to.equal(BASE_URL);
    });
  });

  describe('rpc — success cases', () => {
    let client;

    beforeEach(() => {
      client = new PostgrestClient({
        baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: fetchStub, log,
      });
    });

    it('POSTs to /rpc/<fn> with named params, profile headers, and writer JWT', async () => {
      fetchStub.resolves(makeResponse({ body: [{ month_start: '2026-04-01', month_end: '2026-04-30' }] }));

      const { data, error } = await client.rpc('rpc_url_inspector_stale_slices_for_site', {
        p_site_id: 'abc',
        p_max_months_back: 6,
      });

      expect(error).to.be.null;
      expect(data).to.deep.equal([{ month_start: '2026-04-01', month_end: '2026-04-30' }]);
      expect(fetchStub).to.have.been.calledOnce;

      const [url, init] = fetchStub.firstCall.args;
      expect(url).to.equal(`${BASE_URL}/rpc/rpc_url_inspector_stale_slices_for_site`);
      expect(init.method).to.equal('POST');
      expect(init.body).to.equal(JSON.stringify({ p_site_id: 'abc', p_max_months_back: 6 }));
      expect(init.headers).to.include({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Profile': 'public',
        'Accept-Profile': 'public',
        Authorization: `Bearer ${API_KEY}`,
      });
      expect(init.signal).to.exist;
    });

    it('uses a custom schema when configured', async () => {
      const customClient = new PostgrestClient({
        baseUrl: BASE_URL, apiKey: API_KEY, schema: 'mysticat', fetchImpl: fetchStub, log,
      });
      fetchStub.resolves(makeResponse({ body: [] }));

      await customClient.rpc('rpc_foo', {});

      const [, init] = fetchStub.firstCall.args;
      expect(init.headers['Content-Profile']).to.equal('mysticat');
      expect(init.headers['Accept-Profile']).to.equal('mysticat');
    });

    it('defaults to an empty params body when none are provided', async () => {
      fetchStub.resolves(makeResponse({ body: null, text: '' }));

      const { data, error } = await client.rpc('rpc_ping');

      expect(error).to.be.null;
      expect(data).to.be.null;
      expect(fetchStub.firstCall.args[1].body).to.equal('{}');
    });

    it('parses scalar responses (e.g. true/false from a void RPC) as JSON', async () => {
      fetchStub.resolves(makeResponse({ body: true }));

      const { data, error } = await client.rpc('wrpc_refresh_foo', { p_site_id: 'abc' });

      expect(error).to.be.null;
      expect(data).to.be.true;
    });

    it('returns raw text on responses that are not JSON', async () => {
      fetchStub.resolves(makeResponse({ text: 'not-json' }));

      const { data, error } = await client.rpc('rpc_foo');

      expect(error).to.be.null;
      expect(data).to.equal('not-json');
    });
  });

  describe('rpc — error cases', () => {
    let client;

    beforeEach(() => {
      client = new PostgrestClient({
        baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: fetchStub, log,
      });
    });

    it('returns the parsed PostgREST error body on a 4xx', async () => {
      fetchStub.resolves(makeResponse({
        ok: false,
        status: 404,
        body: {
          message: 'Could not find function in the schema cache',
          code: 'PGRST202',
          details: 'missing function',
          hint: 'reload schema',
        },
      }));

      const { data, error } = await client.rpc('rpc_missing');

      expect(data).to.be.null;
      expect(error).to.deep.include({
        message: 'Could not find function in the schema cache',
        status: 404,
        code: 'PGRST202',
        details: 'missing function',
        hint: 'reload schema',
      });
      expect(log.debug).to.have.been.called;
    });

    it('falls back to a generic message when the 5xx body has no .message', async () => {
      fetchStub.resolves(makeResponse({
        ok: false,
        status: 503,
        body: { code: 'XX000' },
      }));

      const { data, error } = await client.rpc('rpc_overloaded');

      expect(data).to.be.null;
      expect(error.status).to.equal(503);
      expect(error.message).to.equal('PostgREST 503 on /rpc/rpc_overloaded');
      expect(error.code).to.equal('XX000');
    });

    it('returns the network error in the error object (no throw)', async () => {
      fetchStub.rejects(new Error('socket hang up'));

      const { data, error } = await client.rpc('rpc_anything');

      expect(data).to.be.null;
      expect(error.status).to.equal(0);
      expect(error.message).to.equal('socket hang up');
    });

    it('falls back to a generic message when the thrown error has no .message', async () => {
      fetchStub.rejects({});

      const { data, error } = await client.rpc('rpc_anything');

      expect(data).to.be.null;
      expect(error.status).to.equal(0);
      expect(error.message).to.equal('PostgREST request failed');
    });

    it('aborts the request after the configured timeout', async () => {
      // never resolves; just records the AbortSignal so we can listen to it
      let capturedSignal;
      fetchStub.callsFake((_, init) => new Promise((_, reject) => {
        capturedSignal = init.signal;
        capturedSignal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }));

      const tightClient = new PostgrestClient({
        baseUrl: BASE_URL, apiKey: API_KEY, fetchImpl: fetchStub, log, timeoutMs: 5,
      });

      const { data, error } = await tightClient.rpc('rpc_slow');

      expect(data).to.be.null;
      expect(error.message).to.equal('aborted');
      expect(capturedSignal.aborted).to.be.true;
    });

    it('aborts immediately when an already-aborted signal is supplied', async () => {
      const ac = new AbortController();
      ac.abort(new Error('caller cancelled'));

      let observedAbort = false;
      fetchStub.callsFake((_, init) => new Promise((_, reject) => {
        observedAbort = init.signal.aborted;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }));

      const { error } = await client.rpc('rpc_foo', {}, { signal: ac.signal });

      expect(error.message).to.equal('aborted');
      expect(observedAbort).to.be.true;
    });

    it('aborts when an external signal aborts mid-flight', async () => {
      const ac = new AbortController();
      let capturedSignal;
      fetchStub.callsFake((_, init) => new Promise((_, reject) => {
        capturedSignal = init.signal;
        capturedSignal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }));

      const promise = client.rpc('rpc_foo', {}, { signal: ac.signal });
      ac.abort(new Error('caller cancelled'));
      const { error } = await promise;

      expect(error.message).to.equal('aborted');
      expect(capturedSignal.aborted).to.be.true;
    });
  });
});

describe('postgrestClientFromContext', () => {
  let sandbox;
  let fetchStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    fetchStub = sandbox.stub();
  });

  afterEach(() => sandbox.restore());

  it('reads POSTGREST_URL/POSTGREST_API_KEY/POSTGREST_SCHEMA from context.env', () => {
    const ctx = {
      env: {
        POSTGREST_URL: BASE_URL,
        POSTGREST_API_KEY: API_KEY,
        POSTGREST_SCHEMA: 'mysticat',
      },
      log: { debug: sandbox.spy() },
    };
    const client = postgrestClientFromContext(ctx, { fetchImpl: fetchStub });
    expect(client.baseUrl).to.equal(BASE_URL);
    expect(client.apiKey).to.equal(API_KEY);
    expect(client.schema).to.equal('mysticat');
  });

  it('defaults the schema to "public" when unset', () => {
    const ctx = {
      env: { POSTGREST_URL: BASE_URL, POSTGREST_API_KEY: API_KEY },
      log: { debug: sandbox.spy() },
    };
    const client = postgrestClientFromContext(ctx, { fetchImpl: fetchStub });
    expect(client.schema).to.equal('public');
  });

  it('honours POSTGREST_TIMEOUT_MS when present', () => {
    const ctx = {
      env: {
        POSTGREST_URL: BASE_URL, POSTGREST_API_KEY: API_KEY, POSTGREST_TIMEOUT_MS: '1234',
      },
      log: { debug: sandbox.spy() },
    };
    const client = postgrestClientFromContext(ctx, { fetchImpl: fetchStub });
    expect(client.timeoutMs).to.equal(1234);
  });

  it('throws via the constructor when POSTGREST_URL is missing', () => {
    const ctx = { env: { POSTGREST_API_KEY: API_KEY } };
    expect(() => postgrestClientFromContext(ctx, { fetchImpl: fetchStub }))
      .to.throw(/baseUrl is required/);
  });

  it('throws via the constructor when POSTGREST_API_KEY is missing', () => {
    const ctx = { env: { POSTGREST_URL: BASE_URL } };
    expect(() => postgrestClientFromContext(ctx, { fetchImpl: fetchStub }))
      .to.throw(/apiKey is required/);
  });

  it('tolerates an undefined context (constructor still validates required fields)', () => {
    expect(() => postgrestClientFromContext(undefined, { fetchImpl: fetchStub }))
      .to.throw(/baseUrl is required/);
  });
});
