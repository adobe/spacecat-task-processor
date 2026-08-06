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

import { badRequest, internalServerError, ok } from '@adobe/spacecat-shared-http-utils';
import { isValidUUID } from '@adobe/spacecat-shared-utils';

import { postgrestClientFromContext } from '../../utils/postgrest-client.js';

/*
 * url-inspector-refresh
 *
 * One message in: { type: 'url-inspector-refresh', siteId: <uuid> }.
 *
 * Per invocation:
 *   1. Call rpc_url_inspector_stale_slices_for_site(siteId) — cheap, indexed,
 *      returns 0..N (month_start, month_end) rows that are stale.
 *   2. For each stale month, call wrpc_refresh_url_inspector_domain_stats(
 *      siteId, month_start, month_end). The refresh RPC is idempotent
 *      (DELETE + INSERT under pg_advisory_xact_lock per site), so re-running
 *      on the same (site, month) is safe.
 *
 * Failure model:
 *   - Per-RPC retry: each PostgREST call is retried up to PER_RPC_ATTEMPTS times
 *     in-handler before being declared failed.
 *   - Per-month isolation: a failure on one month does NOT abort the rest of
 *     the site's months; the failure is logged + counted + skipped, and the
 *     loop continues.
 *   - We never throw to the SQS dispatcher: the task-processor jobs queue runs
 *     with maxReceiveCount=1, so a throw would immediately DLQ the message and
 *     require manual ops attention. Instead we lean on the every-30-min
 *     schedule + the idempotency of the refresh RPC: any month we fail to
 *     refresh stays "stale" in the next invocation's staleness query and gets
 *     retried on the next tick.
 *
 * Budget:
 *   - SQS visibility timeout for spacecat-task-processor-jobs is 900s. We cap
 *     wall time at PER_INVOCATION_BUDGET_MS (12 min) and defer the remainder
 *     to the next schedule tick.
 *
 * Observability:
 *   - Every per-month outcome is emitted as a single structured log line
 *     ({ event, siteId, month_start, status, durationMs, attempts }) so a
 *     downstream CloudWatch metric filter can turn them into counters / SLI
 *     gauges without a CloudWatch SDK dep on the hot path.
 */

const TASK_TYPE = 'url-inspector-refresh';
const PER_INVOCATION_BUDGET_MS = 12 * 60 * 1000;
const PER_RPC_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Call client.rpc(...) up to `attempts` times. Returns whatever the final attempt
 * returned (success or last error). Backs off by `backoffMs * attemptNumber`.
 */
async function withRpcRetry(client, fnName, params, {
  attempts = PER_RPC_ATTEMPTS, backoffMs = RETRY_BACKOFF_MS, log, sleepFn = sleep,
} = {}) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    /* eslint-disable no-await-in-loop */
    last = await client.rpc(fnName, params);
    if (!last.error) {
      return { ...last, attempts: i };
    }
    if (i < attempts) {
      log?.warn?.(`url-inspector-refresh: ${fnName} attempt ${i}/${attempts} failed (${last.error.message}); retrying in ${backoffMs * i}ms`);
      await sleepFn(backoffMs * i);
    }
    /* eslint-enable no-await-in-loop */
  }
  return { ...last, attempts };
}

/**
 * Main handler. Returns:
 *   - 400 (badRequest) on missing/invalid siteId
 *   - 500 (internalServerError) on un-recoverable config issues (e.g. missing
 *     POSTGREST_URL — surfaced so prod alarms can pick it up immediately)
 *   - 200 (ok) with `{ siteId, refreshed, failed, deferred, totalStale }` on
 *     every other outcome, including partial success / all-failed
 */
export async function runUrlInspectorRefresh(message, context, deps = {}) {
  const { log } = context;
  const { siteId } = message || {};

  if (!isValidUUID(siteId)) {
    log.error(`${TASK_TYPE}: invalid or missing siteId`);
    return badRequest('siteId is required and must be a valid UUID');
  }

  let client;
  try {
    client = deps.client || postgrestClientFromContext(context);
  } catch (err) {
    // baseUrl/apiKey missing — config error, NOT a transient one. Surface 500 so
    // the Lambda errors metric (and any alarm wired to it) fires.
    log.error(`${TASK_TYPE}: postgrest client init failed for site ${siteId}: ${err.message}`);
    return internalServerError(err.message);
  }

  const budgetMs = deps.budgetMs ?? PER_INVOCATION_BUDGET_MS;
  const attempts = deps.attempts ?? PER_RPC_ATTEMPTS;
  const sleepFn = deps.sleepFn ?? sleep;

  log.info(`${TASK_TYPE}: starting refresh for site ${siteId}`);

  const staleResult = await withRpcRetry(
    client,
    'rpc_url_inspector_stale_slices_for_site',
    { p_site_id: siteId },
    { attempts, log, sleepFn },
  );

  if (staleResult.error) {
    log.error(`${TASK_TYPE}: staleness query failed for site ${siteId} after ${staleResult.attempts} attempts: ${staleResult.error.message}`);
    log.info(JSON.stringify({
      event: `${TASK_TYPE}.staleness_failed`,
      siteId,
      attempts: staleResult.attempts,
      status: staleResult.error.status,
      message: staleResult.error.message,
    }));
    // Do not throw: next 30-min tick will retry. Return ok so SQS deletes the
    // message instead of sending it to DLQ.
    return ok({
      siteId, refreshed: 0, failed: 0, deferred: 0, totalStale: 0, stalenessFailed: true,
    });
  }

  const stale = Array.isArray(staleResult.data) ? staleResult.data : [];
  if (stale.length === 0) {
    log.info(`${TASK_TYPE}: site ${siteId} has no stale slices`);
    return ok({
      siteId, refreshed: 0, failed: 0, deferred: 0, totalStale: 0,
    });
  }

  log.info(`${TASK_TYPE}: site ${siteId} has ${stale.length} stale slice(s)`);

  const startedAt = Date.now();
  let refreshed = 0;
  let failed = 0;
  let deferred = 0;

  for (const slice of stale) {
    const monthStart = slice.month_start;
    const monthEnd = slice.month_end;
    const elapsed = Date.now() - startedAt;

    if (elapsed > budgetMs) {
      deferred = stale.length - refreshed - failed;
      log.warn(`${TASK_TYPE}: site ${siteId} budget exhausted after ${elapsed}ms; deferring ${deferred} slice(s) to next tick`);
      break;
    }

    const t0 = Date.now();
    /* eslint-disable no-await-in-loop */
    const res = await withRpcRetry(
      client,
      'wrpc_refresh_url_inspector_domain_stats',
      { p_site_id: siteId, p_start_date: monthStart, p_end_date: monthEnd },
      { attempts, log, sleepFn },
    );
    /* eslint-enable no-await-in-loop */
    const durationMs = Date.now() - t0;

    if (res.error) {
      failed += 1;
      log.error(`${TASK_TYPE}: refresh failed for site ${siteId} month ${monthStart} after ${res.attempts} attempt(s): ${res.error.message}`);
      log.info(JSON.stringify({
        event: `${TASK_TYPE}.refresh`,
        siteId,
        month_start: monthStart,
        status: 'error',
        attempts: res.attempts,
        durationMs,
        errorMessage: res.error.message,
        errorStatus: res.error.status,
      }));
      // A failed month stays stale; the next 30-min tick will retry it.
    } else {
      refreshed += 1;
      log.info(JSON.stringify({
        event: `${TASK_TYPE}.refresh`,
        siteId,
        month_start: monthStart,
        status: 'ok',
        attempts: res.attempts,
        durationMs,
      }));
    }
  }

  log.info(`${TASK_TYPE}: site ${siteId} complete — refreshed=${refreshed} failed=${failed} deferred=${deferred} totalStale=${stale.length}`);

  return ok({
    siteId, refreshed, failed, deferred, totalStale: stale.length,
  });
}

export default runUrlInspectorRefresh;
