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

/**
 * Minimal PostgREST RPC client.
 *
 * Why we don't reuse `@adobe/spacecat-shared-data-access` v3 here:
 *   - task-processor runs in DynamoDB (v2) mode for every other handler; flipping
 *     `DATA_SERVICE_PROVIDER=postgres` would change the global behaviour for all of
 *     them. This client opts a single handler into PostgREST without that side
 *     effect.
 *   - The url-inspector-refresh handler only needs RPC calls (no model CRUD), so the
 *     full v3 layer is overkill. A ~80-line `fetch` wrapper is easier to reason
 *     about and to mock in tests.
 *
 * Surface matches the subset of supabase-js that the api-service controllers use:
 *   `const { data, error } = await client.rpc(name, namedParams);`
 * so future migration to v3 is a one-line swap if we ever flip the task-processor
 * to PostgREST for everything.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Build a PostgREST error object that mirrors supabase-js's shape:
 *   { message, status, code?, details?, hint?, body? }
 * `body` is the parsed JSON or raw text returned by PostgREST when available; it's
 * exposed so callers can log full server-side context without re-parsing.
 */
function toError({
  message, status, body,
}) {
  const code = body && typeof body === 'object' ? body.code : undefined;
  const details = body && typeof body === 'object' ? body.details : undefined;
  const hint = body && typeof body === 'object' ? body.hint : undefined;
  return {
    message, status, code, details, hint, body,
  };
}

export class PostgrestClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl       PostgREST root, e.g. https://pgrst.example/v1
   * @param {string} opts.apiKey        Writer JWT (HS256) — sent as Bearer token
   * @param {string} [opts.schema]      Postgres schema (default: 'public')
   * @param {number} [opts.timeoutMs]   Per-request timeout (default: 60s)
   * @param {Function} [opts.fetchImpl] Injectable fetch; defaults to global fetch
   * @param {object} [opts.log]         Logger; only `.debug` is used
   */
  constructor({
    baseUrl, apiKey, schema = 'public', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, log,
  }) {
    if (!baseUrl) throw new Error('PostgrestClient: baseUrl is required');
    if (!apiKey) throw new Error('PostgrestClient: apiKey is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.schema = schema;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log;
    if (typeof this.fetch !== 'function') {
      throw new Error('PostgrestClient: no fetch implementation available');
    }
  }

  /**
   * Call a PostgREST RPC (i.e. POST /rpc/<fnName>).
   *
   * @param {string} fnName       Function name (without `/rpc/` prefix)
   * @param {object} [params]     Named arguments, posted as JSON body
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]  External abort signal (composed with the
   *                                        per-request timeout)
   * @returns {Promise<{ data: any, error: object|null }>}
   *
   * Never throws. Network errors, timeouts, and non-2xx responses all surface as
   * `{ data: null, error }` so handlers can `if (error) ...` without try/catch.
   */
  async rpc(fnName, params = {}, { signal } = {}) {
    const url = `${this.baseUrl}/rpc/${fnName}`;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Both profile headers are needed when the function lives outside the
      // exposed schema; harmless when it doesn't.
      'Content-Profile': this.schema,
      'Accept-Profile': this.schema,
      Authorization: `Bearer ${this.apiKey}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error(`PostgREST timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
    // Compose: if the caller's signal fires, abort our internal one too.
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
    }

    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      return {
        data: null,
        error: toError({
          message: err?.message || 'PostgREST request failed',
          status: 0,
          body: null,
        }),
      };
    } finally {
      clearTimeout(timeoutId);
    }

    const rawText = await response.text();
    let body = null;
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
    }

    if (!response.ok) {
      const message = body && typeof body === 'object' && body.message
        ? body.message
        : `PostgREST ${response.status} on /rpc/${fnName}`;
      this.log?.debug?.(`PostgREST ${response.status} on /rpc/${fnName}: ${rawText}`);
      return {
        data: null,
        error: toError({ message, status: response.status, body }),
      };
    }

    return { data: body, error: null };
  }
}

/**
 * Build a PostgrestClient from a UniversalContext-shaped object.
 *
 * Reads:
 *   - POSTGREST_URL        (required)
 *   - POSTGREST_API_KEY    (required) — writer JWT
 *   - POSTGREST_SCHEMA     (optional, default 'public')
 *   - POSTGREST_TIMEOUT_MS (optional)
 *
 * Lazy by design: the env vars are only read here, not at module load, so
 * vault-secrets middleware has a chance to populate `context.env` first.
 */
export function postgrestClientFromContext(context, overrides = {}) {
  const { env = {}, log } = context || {};
  return new PostgrestClient({
    baseUrl: env.POSTGREST_URL,
    apiKey: env.POSTGREST_API_KEY,
    schema: env.POSTGREST_SCHEMA || 'public',
    timeoutMs: env.POSTGREST_TIMEOUT_MS ? Number(env.POSTGREST_TIMEOUT_MS) : undefined,
    log,
    ...overrides,
  });
}
