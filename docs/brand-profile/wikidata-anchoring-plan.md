# Brand-profile QID-anchored Wikipedia resolution - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor the brand-profile agent's Wikipedia lookups (products/sub_brands and the competitor-inference summary) on the resolved Wikidata QID instead of a name search, so same-named companies (Lovisa vs Lovesac) can no longer contaminate a brand profile.

**Architecture:** Add three QID-anchored functions to `wikipedia.js` (`fetchWikidataSitelinkTitle`, `fetchWikipediaArticleByTitle`, `resolveBrandWikipedia`) exposed through `createWikipediaService` as `resolveBrand`. `extractProducts` takes a pre-resolved `{ wikidataId, wikipediaText }` context instead of a name-searched string. `index.js` performs one gated resolve and shares it across the competitor phase and the product phase. The two name-based functions are deleted. A `wikipedia_verified` / `wikipedia_discard_reason` breadcrumb is written to the existing `products_metadata`.

**Tech Stack:** Node.js ESM (no TypeScript), Adobe standard ESLint, mocha + c8, chai + sinon + sinon-chai, esmock, `sinon` stub on `globalThis.fetch`. MediaWiki Action API (`en.wikipedia.org/w/api.php`) and Wikidata Action API (`www.wikidata.org/w/api.php`).

**Spec:** `docs/brand-profile/wikidata-anchoring-fix.md`

## Global Constraints

- ESM modules only; no TypeScript. Follow the existing file style in `src/agents/brand-profile/`.
- Pin any new npm dependency to an exact version, no `^`/`~` (this plan adds none).
- Run the affected suite before every commit: `npm test` (or scope to the brand-profile tests during iteration).
- Every network function returns `null`/`[]`/empty on failure and logs; nothing on these paths throws.
- No em-dashes in code comments or docs; use `-`.
- USER_AGENT for all Wikimedia calls stays the existing `'SpaceCat/1.0 (https://github.com/adobe/spacecat; spacecat@adobe.com)'`.
- `MIN_PRODUCTS_THRESHOLD` stays 3; the Wikidata SPARQL primary path is unchanged.
- Do NOT commit to `main`; work on branch `fix/brand-profile-qid-anchored-wikipedia`.
- Persisted brand-profile output shape is unchanged; the breadcrumb goes in the already free-form `products_metadata` object only.

---

### Task 1: `fetchWikidataSitelinkTitle` - resolve the enwiki article title from a QID

**Files:**
- Modify: `src/agents/brand-profile/services/wikipedia.js`
- Test: `test/agents/brand-profile/services/wikipedia.test.js`

**Interfaces:**
- Consumes: nothing new (uses existing `WIKIDATA_API`, `USER_AGENT` module constants).
- Produces: `export async function fetchWikidataSitelinkTitle(wikidataId, log): Promise<string|null>` - the English Wikipedia page title for the QID, or `null` when the entity has no `enwiki` sitelink or the call fails.

- [ ] **Step 1: Write the failing tests**

Add a `describe('fetchWikidataSitelinkTitle', ...)` block. Use the existing `fetchStub`/`log` sandbox from the top of the file.

```javascript
import { fetchWikidataSitelinkTitle } from '../../../../src/agents/brand-profile/services/wikipedia.js';

describe('fetchWikidataSitelinkTitle', () => {
  it('returns the enwiki title for a QID', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => ({
        entities: { Q6690181: { sitelinks: { enwiki: { title: 'Lovesac' } } } },
      }),
    });
    const title = await fetchWikidataSitelinkTitle('Q6690181', log);
    expect(title).to.equal('Lovesac');
    const calledUrl = fetchStub.firstCall.args[0];
    expect(calledUrl).to.include('action=wbgetentities');
    expect(calledUrl).to.include('sitefilter=enwiki');
    expect(calledUrl).to.include('Q6690181');
  });

  it('returns null when the entity has no enwiki sitelink', async () => {
    fetchStub.resolves({
      ok: true,
      json: async () => ({ entities: { Q6690181: { sitelinks: {} } } }),
    });
    expect(await fetchWikidataSitelinkTitle('Q6690181', log)).to.equal(null);
  });

  it('returns null on a non-ok response', async () => {
    fetchStub.resolves({ ok: false, status: 500 });
    expect(await fetchWikidataSitelinkTitle('Q6690181', log)).to.equal(null);
  });

  it('returns null when fetch rejects', async () => {
    fetchStub.rejects(new Error('network'));
    expect(await fetchWikidataSitelinkTitle('Q6690181', log)).to.equal(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha test/agents/brand-profile/services/wikipedia.test.js -g fetchWikidataSitelinkTitle`
Expected: FAIL - `fetchWikidataSitelinkTitle is not a function`.

- [ ] **Step 3: Implement `fetchWikidataSitelinkTitle`**

Add to `wikipedia.js` (near `findWikidataId`):

```javascript
/**
 * Resolve the English Wikipedia article title for a Wikidata entity via its sitelink.
 * @param {string} wikidataId - Wikidata entity ID (e.g. "Q6690181")
 * @param {object} log - Logger instance
 * @returns {Promise<string|null>} enwiki page title, or null when absent/failed
 */
export async function fetchWikidataSitelinkTitle(wikidataId, log) {
  try {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidataId,
      props: 'sitelinks',
      sitefilter: 'enwiki',
      format: 'json',
    });
    const resp = await fetch(`${WIKIDATA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) {
      throw new Error(`wbgetentities failed: ${resp.status}`);
    }
    const data = await resp.json();
    const title = data.entities?.[wikidataId]?.sitelinks?.enwiki?.title || null;
    log.info(`Wikidata sitelink for ${wikidataId}: ${title || 'none'}`);
    return title;
  } catch (e) {
    log.error(`Error fetching Wikidata sitelink for ${wikidataId}: ${e.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha test/agents/brand-profile/services/wikipedia.test.js -g fetchWikidataSitelinkTitle`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/agents/brand-profile/services/wikipedia.js test/agents/brand-profile/services/wikipedia.test.js
git commit -m "feat(brand-profile): add fetchWikidataSitelinkTitle (QID -> enwiki title)"
```

---

### Task 2: `fetchWikipediaArticleByTitle` - fetch an exact article with its wikibase_item

**Files:**
- Modify: `src/agents/brand-profile/services/wikipedia.js`
- Test: `test/agents/brand-profile/services/wikipedia.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export async function fetchWikipediaArticleByTitle(title, maxChars, log): Promise<{ title, fullText, summary, wikidataId }|null>`. One MediaWiki `query` with `prop=extracts|pageprops`, `explaintext=true`, `redirects=1`, `ppprop=wikibase_item`. `fullText` truncated to `maxChars` (default 12000); `summary` is the first paragraph of `fullText`; `wikidataId` from `pageprops.wikibase_item`. `null` on a missing page or failure.

- [ ] **Step 1: Write the failing tests**

```javascript
import { fetchWikipediaArticleByTitle } from '../../../../src/agents/brand-profile/services/wikipedia.js';

describe('fetchWikipediaArticleByTitle', () => {
  const page = (over = {}) => ({
    ok: true,
    json: async () => ({
      query: {
        pages: {
          123: {
            title: 'Lovesac',
            extract: 'Lovesac is a furniture company.\n\nIt makes modular couches.',
            pageprops: { wikibase_item: 'Q6690181' },
            ...over,
          },
        },
      },
    }),
  });

  it('fetches extract + wikibase_item in one call, requests redirects=1', async () => {
    fetchStub.resolves(page());
    const res = await fetchWikipediaArticleByTitle('Lovesac', 12000, log);
    expect(res).to.deep.include({ title: 'Lovesac', wikidataId: 'Q6690181' });
    expect(res.fullText).to.include('modular couches');
    expect(res.summary).to.equal('Lovesac is a furniture company.');
    const url = fetchStub.firstCall.args[0];
    expect(url).to.include('prop=extracts');
    expect(url).to.include('pageprops');
    expect(url).to.include('redirects=1');
    expect(url).to.not.include('action=opensearch');
  });

  it('truncates fullText to maxChars', async () => {
    fetchStub.resolves(page({ extract: 'x'.repeat(50) }));
    const res = await fetchWikipediaArticleByTitle('Lovesac', 10, log);
    expect(res.fullText).to.have.length(10);
  });

  it('returns wikidataId null when the page has no wikibase_item', async () => {
    fetchStub.resolves(page({ pageprops: {} }));
    const res = await fetchWikipediaArticleByTitle('Lovesac', 12000, log);
    expect(res.wikidataId).to.equal(null);
  });

  it('returns null for a missing page (-1)', async () => {
    fetchStub.resolves({ ok: true, json: async () => ({ query: { pages: { '-1': {} } } }) });
    expect(await fetchWikipediaArticleByTitle('Nope', 12000, log)).to.equal(null);
  });

  it('returns null on non-ok and on reject', async () => {
    fetchStub.resolves({ ok: false, status: 500 });
    expect(await fetchWikipediaArticleByTitle('Lovesac', 12000, log)).to.equal(null);
    fetchStub.rejects(new Error('network'));
    expect(await fetchWikipediaArticleByTitle('Lovesac', 12000, log)).to.equal(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha test/agents/brand-profile/services/wikipedia.test.js -g fetchWikipediaArticleByTitle`
Expected: FAIL - not a function.

- [ ] **Step 3: Implement `fetchWikipediaArticleByTitle`**

```javascript
/**
 * Fetch an exact Wikipedia article by title (no search), returning its text and
 * its Wikidata entity id in a single query.
 * @param {string} title - Exact article title
 * @param {number} [maxChars=12000] - Max characters of full text to return
 * @param {object} log - Logger instance
 * @returns {Promise<{title:string, fullText:string, summary:string, wikidataId:string|null}|null>}
 */
export async function fetchWikipediaArticleByTitle(title, maxChars, log) {
  const limit = maxChars || 12000;
  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'extracts|pageprops',
      explaintext: 'true',
      ppprop: 'wikibase_item',
      redirects: '1',
      format: 'json',
    });
    const resp = await fetch(`${WIKIPEDIA_API_BASE}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) {
      throw new Error(`Wikipedia article fetch failed: ${resp.status}`);
    }
    const data = await resp.json();
    const pages = data.query?.pages || {};
    const pageId = Object.keys(pages)[0];
    if (!pageId || pageId === '-1') {
      return null;
    }
    const p = pages[pageId];
    const fullText = (p.extract || '').slice(0, limit);
    const summary = fullText.split('\n\n')[0].trim();
    const wikidataId = p.pageprops?.wikibase_item || null;
    log.info(`Fetched Wikipedia article "${p.title}" (wikidata: ${wikidataId || 'none'})`);
    return {
      title: p.title, fullText, summary, wikidataId,
    };
  } catch (e) {
    log.error(`Error fetching Wikipedia article "${title}": ${e.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha test/agents/brand-profile/services/wikipedia.test.js -g fetchWikipediaArticleByTitle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/brand-profile/services/wikipedia.js test/agents/brand-profile/services/wikipedia.test.js
git commit -m "feat(brand-profile): add fetchWikipediaArticleByTitle (exact title + wikibase_item)"
```

---

### Task 3: `resolveBrandWikipedia` orchestrator + guard + `resolveBrand` service binding

**Files:**
- Modify: `src/agents/brand-profile/services/wikipedia.js`
- Test: `test/agents/brand-profile/services/wikipedia.test.js`

**Interfaces:**
- Consumes: `findWikidataId` (existing), `fetchWikidataSitelinkTitle` (Task 1), `fetchWikipediaArticleByTitle` (Task 2).
- Produces:
  - `export async function resolveBrandWikipedia(brandName, { wikidataId } = {}, log): Promise<{ wikidataId:string|null, title:string|null, fullText:string, summary:string, verified:boolean, discardReason:string|null }>` - never throws; `discardReason` is one of `no-qid`, `no-sitelink`, `guard-mismatch`, `fetch-error`, or `null` when `verified`.
  - `createWikipediaService(log)` gains `resolveBrand: (brandName, opts) => resolveBrandWikipedia(brandName, opts, log)`.

- [ ] **Step 1: Write the failing tests**

The orchestrator composes three functions in the same module, so stub `globalThis.fetch` per sub-call in order: (1) `findWikidataId` -> `wbsearchentities`, (2) `fetchWikidataSitelinkTitle` -> `wbgetentities`, (3) `fetchWikipediaArticleByTitle` -> `query`. Use `fetchStub.onCall(n)`.

```javascript
import { resolveBrandWikipedia, createWikipediaService } from '../../../../src/agents/brand-profile/services/wikipedia.js';

describe('resolveBrandWikipedia', () => {
  const searchHit = (id) => ({ ok: true, json: async () => ({ search: [{ id, description: 'furniture company' }] }) });
  const sitelink = (title) => ({ ok: true, json: async () => ({ entities: { Q6690181: { sitelinks: { enwiki: { title } } } } }) });
  const article = (wb) => ({
    ok: true,
    json: async () => ({ query: { pages: { 1: { title: 'Lovesac', extract: 'Lovesac is furniture.\n\nMore.', pageprops: { wikibase_item: wb } } } } }),
  });

  it('resolves and verifies when the article wikibase_item matches the QID', async () => {
    fetchStub.onCall(1).resolves(sitelink('Lovesac'));
    fetchStub.onCall(2).resolves(article('Q6690181'));
    const res = await resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
    expect(res).to.include({ verified: true, wikidataId: 'Q6690181', title: 'Lovesac', discardReason: null });
    expect(res.fullText).to.include('furniture');
    // known QID passed -> findWikidataId (wbsearchentities) is NOT called
    const urls = fetchStub.getCalls().map((c) => c.args[0]);
    expect(urls.some((u) => u.includes('wbsearchentities'))).to.equal(false);
  });

  it('re-resolves the QID from brandName when none is passed', async () => {
    fetchStub.onCall(0).resolves(searchHit('Q6690181'));
    fetchStub.onCall(1).resolves(sitelink('Lovesac'));
    fetchStub.onCall(2).resolves(article('Q6690181'));
    const res = await resolveBrandWikipedia('Lovesac', {}, log);
    expect(res.verified).to.equal(true);
    expect(fetchStub.firstCall.args[0]).to.include('wbsearchentities');
  });

  it('discards on guard mismatch and warns with diagnostics', async () => {
    fetchStub.onCall(1).resolves(sitelink('Lovisa'));
    fetchStub.onCall(2).resolves(article('Q1141985'));
    const res = await resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
    expect(res).to.include({ verified: false, discardReason: 'guard-mismatch', fullText: '', summary: '' });
    expect(log.warn).to.have.been.called;
    const msg = log.warn.firstCall.args[0];
    expect(msg).to.include('Q6690181');
    expect(msg).to.include('Q1141985');
  });

  it('discards when the page has no wikibase_item (distinct from mismatch)', async () => {
    fetchStub.onCall(1).resolves(sitelink('Lovesac'));
    fetchStub.onCall(2).resolves(article(undefined));
    const res = await resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
    expect(res).to.include({ verified: false, discardReason: 'guard-mismatch' });
  });

  it('returns no-qid when the QID cannot be resolved', async () => {
    fetchStub.onCall(0).resolves({ ok: true, json: async () => ({ search: [] }) });
    const res = await resolveBrandWikipedia('Nope', {}, log);
    expect(res).to.include({ verified: false, discardReason: 'no-qid' });
  });

  it('returns no-sitelink when the entity has no enwiki article', async () => {
    fetchStub.onCall(1).resolves({ ok: true, json: async () => ({ entities: { Q6690181: { sitelinks: {} } } }) });
    const res = await resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
    expect(res).to.include({ verified: false, discardReason: 'no-sitelink', wikidataId: 'Q6690181' });
  });

  it('returns fetch-error when the article fetch fails', async () => {
    fetchStub.onCall(1).resolves(sitelink('Lovesac'));
    fetchStub.onCall(2).resolves({ ok: false, status: 500 });
    const res = await resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
    expect(res).to.include({ verified: false, discardReason: 'fetch-error' });
  });

  it('does exact-string QID comparison (no normalization)', async () => {
    fetchStub.onCall(1).resolves(sitelink('Lovesac'));
    fetchStub.onCall(2).resolves(article('q6690181')); // lowercase
    const res = await resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
    expect(res.verified).to.equal(false);
  });
});

describe('createWikipediaService.resolveBrand', () => {
  it('binds resolveBrand with the log', async () => {
    const svc = createWikipediaService(log);
    expect(svc).to.have.property('resolveBrand').that.is.a('function');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha test/agents/brand-profile/services/wikipedia.test.js -g "resolveBrandWikipedia|resolveBrand"`
Expected: FAIL - not a function.

- [ ] **Step 3: Implement `resolveBrandWikipedia` and update the service factory**

```javascript
/**
 * Resolve the QID-anchored Wikipedia article for a brand.
 * QID -> enwiki sitelink title -> exact article -> guard on wikibase_item.
 * Never throws; degrades to empty text with a discardReason.
 * @param {string} brandName
 * @param {{wikidataId?: string}} [opts] - a known QID skips the name lookup
 * @param {object} log
 * @returns {Promise<{wikidataId, title, fullText, summary, verified, discardReason}>}
 */
export async function resolveBrandWikipedia(brandName, { wikidataId } = {}, log) {
  const empty = (discardReason, qid = wikidataId || null, title = null) => ({
    wikidataId: qid, title, fullText: '', summary: '', verified: false, discardReason,
  });
  try {
    const qid = wikidataId || await findWikidataId(brandName, log);
    if (!qid) {
      return empty('no-qid');
    }
    const title = await fetchWikidataSitelinkTitle(qid, log);
    if (!title) {
      return empty('no-sitelink', qid);
    }
    const article = await fetchWikipediaArticleByTitle(title, 12000, log);
    if (!article) {
      return empty('fetch-error', qid, title);
    }
    if (article.wikidataId !== qid) {
      log.warn(`brand-profile: wikipedia guard mismatch for ${brandName}: expected ${qid}, article '${article.title}' had ${article.wikidataId} - discarding`);
      return empty('guard-mismatch', qid, article.title);
    }
    return {
      wikidataId: qid,
      title: article.title,
      fullText: article.fullText,
      summary: article.summary,
      verified: true,
      discardReason: null,
    };
  } catch (e) {
    log.error(`brand-profile: resolveBrandWikipedia failed for ${brandName}: ${e.message}`);
    return empty('fetch-error');
  }
}
```

Update `createWikipediaService` - add the binding (keep `findWikidataId`; the `fetchSummary`/`fetchFullText` bindings are removed in Task 6):

```javascript
export function createWikipediaService(log) {
  return {
    findWikidataId: (brandName) => findWikidataId(brandName, log),
    resolveBrand: (brandName, opts) => resolveBrandWikipedia(brandName, opts, log),
    // fetchSummary / fetchFullText intentionally removed in Task 6
  };
}
```

Note: the `fetchSummary`/`fetchFullText` bindings still exist at this point (removed in Task 6); adding `resolveBrand` alongside them now is fine and keeps this task self-contained.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha test/agents/brand-profile/services/wikipedia.test.js -g "resolveBrandWikipedia|resolveBrand"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/brand-profile/services/wikipedia.js test/agents/brand-profile/services/wikipedia.test.js
git commit -m "feat(brand-profile): add resolveBrandWikipedia orchestrator + guard, expose resolveBrand"
```

---

### Task 4: `extractProducts` consumes a QID-anchored context; add the breadcrumb

**Files:**
- Modify: `src/agents/brand-profile/services/product-extractor.js` (signature at ~479, Step 1 at ~496, Step 3 at ~514-535, import at line 26, factory binding at ~594)
- Test: `test/agents/brand-profile/services/product-extractor.test.js`

**Interfaces:**
- Consumes: `resolveBrandWikipedia` (Task 3).
- Produces: `export async function extractProducts(brandName, wikipediaContext, gpt, log)` where `wikipediaContext = { wikidataId?, wikipediaText? }`. Normalisation: `null`/`undefined` -> `{}`; a truthy non-object -> throws `Error`. Uses `wikipediaContext.wikidataId` for Step 1 when present. Step 3 uses `wikipediaContext.wikipediaText` when the key is present (even if empty); otherwise, when a QID is known, resolves via `resolveBrandWikipedia(brandName, { wikidataId })`. Writes `metadata.wikipedia_verified` and, when unverified, `metadata.wikipedia_discard_reason`. Factory binding `extractProducts: (brandName, wikipediaContext) => extractProducts(brandName, wikipediaContext, gpt, log)`.

- [ ] **Step 1: Rewrite the existing `extractProducts` tests to the object contract, and add mechanism/breadcrumb tests**

In `product-extractor.test.js`, every direct call `extractProducts('TestBrand', <string|null>, gpt, log)` becomes the object form. Two mechanical rules:
- `extractProducts('Brand', null, gpt, log)` -> `extractProducts('Brand', {}, gpt, log)`.
- `extractProducts('Brand', 'Some Wikipedia text', gpt, log)` -> `extractProducts('Brand', { wikipediaText: 'Some Wikipedia text' }, gpt, log)`.

Every rewritten test that exercised the Wikipedia fallback MUST keep asserting the extraction actually happened, e.g. `expect(gpt.fetchChatCompletion).to.have.been.called;` - do not let a silent no-op turn a test green.

Add these new tests:

```javascript
describe('extractProducts - QID-anchored context', () => {
  it('uses the provided wikipediaText and does NOT name-search Wikipedia', async () => {
    // SPARQL returns < 3 so the fallback path is taken
    fetchStub.resolves({ ok: true, json: async () => ({ results: { bindings: [] } }) });
    gpt.fetchChatCompletion = sandbox.stub().resolves({
      choices: [{ message: { content: JSON.stringify({ products: [{ name: 'Sactionals', category: 'Furniture' }], sub_brands: ['Sac'] }) } }],
    });
    const res = await extractProducts('Lovesac', { wikidataId: 'Q6690181', wikipediaText: 'Lovesac makes modular couches.' }, gpt, log);
    expect(gpt.fetchChatCompletion).to.have.been.called;
    const urls = fetchStub.getCalls().map((c) => c.args[0]);
    expect(urls.some((u) => u.includes('action=opensearch'))).to.equal(false);
    expect(res.metadata.brand_wikidata_id).to.equal('Q6690181');
    expect(res.metadata.wikipedia_verified).to.equal(true);
    expect(res.sub_brands).to.include('Sac');
  });

  it('resolves via resolveBrandWikipedia when no wikipediaText key is provided', async () => {
    // wbsearchentities is skipped (QID provided); sitelink then article
    fetchStub.onCall(0).resolves({ ok: true, json: async () => ({ results: { bindings: [] } }) }); // SPARQL
    fetchStub.onCall(1).resolves({ ok: true, json: async () => ({ entities: { Q6690181: { sitelinks: { enwiki: { title: 'Lovesac' } } } } }) });
    fetchStub.onCall(2).resolves({ ok: true, json: async () => ({ query: { pages: { 1: { title: 'Lovesac', extract: 'Furniture.', pageprops: { wikibase_item: 'Q6690181' } } } } }) });
    gpt.fetchChatCompletion = sandbox.stub().resolves({ choices: [{ message: { content: '{"products":[]}' } }] });
    const res = await extractProducts('Lovesac', { wikidataId: 'Q6690181' }, gpt, log);
    expect(res.metadata.wikipedia_verified).to.equal(true);
  });

  it('records wikipedia_discard_reason when the internal resolve is unverified', async () => {
    fetchStub.onCall(0).resolves({ ok: true, json: async () => ({ results: { bindings: [] } }) }); // SPARQL < 3
    fetchStub.onCall(1).resolves({ ok: true, json: async () => ({ entities: { Q6690181: { sitelinks: {} } } }) }); // no sitelink
    const res = await extractProducts('Lovesac', { wikidataId: 'Q6690181' }, gpt, log);
    expect(res.metadata.wikipedia_verified).to.equal(false);
    expect(res.metadata.wikipedia_discard_reason).to.equal('no-sitelink');
  });

  it('marks verified=false when provided wikipediaText is empty (upstream discard)', async () => {
    fetchStub.resolves({ ok: true, json: async () => ({ results: { bindings: [] } }) });
    const res = await extractProducts('Lovesac', { wikidataId: 'Q6690181', wikipediaText: '' }, gpt, log);
    expect(res.metadata.wikipedia_verified).to.equal(false);
  });

  it('skips the Wikipedia fallback entirely when SPARQL already returned enough products', async () => {
    const bindings = [1, 2, 3].map((n) => ({ itemLabel: { value: `P${n}` }, item: { value: `http://wd/Q${n}` } }));
    fetchStub.resolves({ ok: true, json: async () => ({ results: { bindings } }) });
    const res = await extractProducts('Lovesac', { wikidataId: 'Q6690181' }, gpt, log);
    const urls = fetchStub.getCalls().map((c) => c.args[0]);
    expect(urls.some((u) => u.includes('wbgetentities'))).to.equal(false);
    expect(res.products).to.have.length.of.at.least(3);
  });

  it('throws on a stray non-object context (stale caller)', async () => {
    await expect(extractProducts('Lovesac', 'raw text', gpt, log)).to.be.rejectedWith(/wikipediaContext/);
  });

  it('treats null/undefined context as no context (no crash)', async () => {
    fetchStub.resolves({ ok: true, json: async () => ({ results: { bindings: [] } }) });
    const res = await extractProducts('Lovesac', null, gpt, log);
    expect(res).to.have.property('products');
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail (and see which existing ones break)**

Run: `npx mocha test/agents/brand-profile/services/product-extractor.test.js`
Expected: the new context tests FAIL; some rewritten fallback tests FAIL until Step 3 lands. This confirms the signature-change blast radius is now covered rather than silently green.

- [ ] **Step 3: Implement the signature + Step 1 + Step 3 + breadcrumb**

Change the import at the top of `product-extractor.js`:

```javascript
import { findWikidataId, resolveBrandWikipedia } from './wikipedia.js';
```

Replace the `extractProducts` head + Step 1 + Step 3 fallback:

```javascript
export async function extractProducts(brandName, wikipediaContext, gpt, log) {
  log.info(`Extracting products for brand: ${brandName}`);

  let ctx;
  if (wikipediaContext == null) {
    ctx = {};
  } else if (typeof wikipediaContext !== 'object') {
    throw new Error('extractProducts: wikipediaContext must be an object { wikidataId, wikipediaText }');
  } else {
    ctx = wikipediaContext;
  }
  const ctxQid = ctx.wikidataId;
  const hasProvidedText = Object.prototype.hasOwnProperty.call(ctx, 'wikipediaText');

  const result = {
    products: [], services: [], sub_brands: [], discontinued: [],
    metadata: {
      source: 'none', brand_wikidata_id: null, extracted_at: new Date().toISOString(), count: 0,
    },
  };

  // Step 1: QID (reuse the caller's when provided)
  const wikidataId = ctxQid || await findWikidataId(brandName, log);
  if (wikidataId) {
    result.metadata.brand_wikidata_id = wikidataId;
    const wikidataProducts = await queryWikidataProducts(wikidataId, log);
    if (wikidataProducts.length > 0) {
      result.products = wikidataProducts;
      result.metadata.source = 'wikidata';
      result.metadata.count = wikidataProducts.length;
    }
  }

  // Step 3: QID-anchored Wikipedia fallback
  if (result.products.length < MIN_PRODUCTS_THRESHOLD) {
    let wikiText;
    if (hasProvidedText) {
      wikiText = ctx.wikipediaText || '';
      result.metadata.wikipedia_verified = Boolean(wikiText);
      if (!wikiText) {
        result.metadata.wikipedia_discard_reason = 'unresolved-upstream';
      }
    } else if (wikidataId) {
      const resolved = await resolveBrandWikipedia(brandName, { wikidataId }, log);
      wikiText = resolved.verified ? resolved.fullText : '';
      result.metadata.wikipedia_verified = resolved.verified;
      if (!resolved.verified) {
        result.metadata.wikipedia_discard_reason = resolved.discardReason;
      }
    } else {
      wikiText = '';
      result.metadata.wikipedia_verified = false;
      result.metadata.wikipedia_discard_reason = 'no-qid';
    }

    if (wikiText) {
      const wikiResult = await extractFromWikipedia(brandName, wikiText, gpt, log);
      if (wikiResult) {
        const merged = mergeResults(result, wikiResult);
        Object.assign(result, merged);
        result.metadata.source = result.metadata.source === 'wikidata' ? 'hybrid' : 'wikipedia_llm';
      }
    }
  }

  return normalizeResults(result);
}
```

Update the factory binding:

```javascript
    extractProducts: (brandName, wikipediaContext) => (
      extractProducts(brandName, wikipediaContext, gpt, log)
    ),
```

- [ ] **Step 4: Run the full product-extractor suite**

Run: `npx mocha test/agents/brand-profile/services/product-extractor.test.js`
Expected: PASS (all rewritten + new tests). If a rewritten test is green only because `fetchChatCompletion` was not called, fix the test to assert the call - that is the C2 trap.

- [ ] **Step 5: Commit**

```bash
git add src/agents/brand-profile/services/product-extractor.js test/agents/brand-profile/services/product-extractor.test.js
git commit -m "feat(brand-profile): extractProducts consumes QID-anchored context + breadcrumb"
```

---

### Task 5: `index.js` - single gated resolve shared across Phase 4 and Phase 6

**Files:**
- Modify: `src/agents/brand-profile/index.js` (Phase 4 at ~202-215, Phase 6 at ~231-238; add the resolve after `brandName` is set at ~155-166)
- Test: `test/agents/brand-profile/index.test.js` (the ~7 Wikipedia-service mocks)

**Interfaces:**
- Consumes: `wikipediaService.resolveBrand(brandName, opts)` (Task 3), `productService.extractProducts(brandName, { wikidataId, wikipediaText })` (Task 4).
- Produces: no new exports; behaviour change only.

- [ ] **Step 1: Update the index.test.js Wikipedia mocks and add orchestration tests**

Every Wikipedia-service mock currently shaped `{ fetchSummary, fetchFullText }` becomes `{ resolveBrand }`. Default helper example:

```javascript
const createMockServices = (over = {}) => ({
  // ...regional/competitor/persona/product mocks unchanged...
  wikipediaService: {
    resolveBrand: sandbox.stub().resolves({
      wikidataId: 'Q6690181', title: 'Lovesac',
      fullText: 'Lovesac makes furniture.', summary: 'Lovesac makes furniture.',
      verified: true, discardReason: null,
    }),
    ...over.wikipediaService,
  },
});
```

Add:

```javascript
describe('brand-profile run - QID anchoring', () => {
  it('resolves once and passes the anchored context to extractProducts', async () => {
    const services = createMockServices();
    // ...wire esmock so run() uses `services`...
    await run(context, env, log);
    expect(services.wikipediaService.resolveBrand).to.have.been.calledOnce;
    const productArgs = services.productService.extractProducts.firstCall.args;
    expect(productArgs[1]).to.include({ wikidataId: 'Q6690181' });
    expect(productArgs[1].wikipediaText).to.include('furniture');
  });

  it('does NOT resolve Wikipedia when both sitemapUrl and llmoCompetitors are provided', async () => {
    const services = createMockServices();
    const ctx = { ...context, params: { sitemapUrl: 'https://x/sitemap.xml', competitors: ['A', 'B'] } };
    await run(ctx, env, log);
    expect(services.wikipediaService.resolveBrand).to.not.have.been.called;
    expect(services.productService.extractFromSitemap).to.have.been.called;
  });

  it('resolves for the summary when llmoCompetitors is empty even if sitemapUrl is set', async () => {
    const services = createMockServices();
    const ctx = { ...context, params: { sitemapUrl: 'https://x/sitemap.xml' } };
    await run(ctx, env, log);
    expect(services.wikipediaService.resolveBrand).to.have.been.calledOnce;
    expect(services.productService.extractFromSitemap).to.have.been.called;
  });

  it('skips resolve for the Unknown Brand sentinel', async () => {
    const services = createMockServices();
    // base profile yields no brand_name and baseURL has no usable domain -> "Unknown Brand"
    await run(unknownBrandContext, env, log);
    expect(services.wikipediaService.resolveBrand).to.not.have.been.called;
  });
});
```

- [ ] **Step 2: Run to verify the updated/added tests fail**

Run: `npx mocha test/agents/brand-profile/index.test.js`
Expected: FAIL - `resolveBrand` used by the new code path but assertions not yet satisfied; old `fetchSummary`/`fetchFullText` no longer called.

- [ ] **Step 3: Implement the gated shared resolve and rewire Phases 4 and 6**

After `brandName`/`industry`/`targetAudience` are extracted and services initialised (around line 166), add:

```javascript
  // Resolve the QID-anchored Wikipedia article once, only when a phase needs it.
  const needsWikipedia = !hasText(sitemapUrl)
    || !(Array.isArray(llmoCompetitors) && llmoCompetitors.length > 0);
  const brandWiki = (brandName !== 'Unknown Brand' && needsWikipedia)
    ? await wikipediaService.resolveBrand(brandName)
    : {
      wikidataId: null, title: null, fullText: '', summary: '', verified: false, discardReason: 'skipped',
    };
```

Phase 4 (the `else` inferring branch) - replace the `fetchSummary` call:

```javascript
    log.info('brand-profile: inferring competitors');
    const competitorResult = await competitorService.inferCompetitors({
      brandName,
      industry,
      countryCode,
      wikipediaSummary: brandWiki.summary,
    });
```

Phase 6 (the non-sitemap `else` branch) - replace the `fetchFullText` + `extractProducts` calls:

```javascript
  } else {
    productsResult = await productService.extractProducts(brandName, {
      wikidataId: brandWiki.wikidataId,
      wikipediaText: brandWiki.fullText,
    });
  }
```

- [ ] **Step 4: Run the index suite**

Run: `npx mocha test/agents/brand-profile/index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/brand-profile/index.js test/agents/brand-profile/index.test.js
git commit -m "feat(brand-profile): single gated QID-anchored resolve shared across phases"
```

---

### Task 6: Delete the dead name-based Wikipedia functions

**Files:**
- Modify: `src/agents/brand-profile/services/wikipedia.js` (remove `fetchWikipediaSummary`, `fetchWikipediaFullText`, and their `fetchSummary`/`fetchFullText` bindings)
- Test: `test/agents/brand-profile/services/wikipedia.test.js` (delete their `describe` blocks)

**Interfaces:**
- Consumes: nothing.
- Produces: `wikipedia.js` exports are now `findWikidataId`, `fetchWikidataSitelinkTitle`, `fetchWikipediaArticleByTitle`, `resolveBrandWikipedia`, `createWikipediaService`.

- [ ] **Step 1: Prove there are no remaining references**

Run:
```bash
grep -rn "fetchWikipediaSummary\|fetchWikipediaFullText\|fetchFullText\|fetchSummary" src/ test/
```
Expected before edit: matches only in `wikipedia.js` (definitions + bindings) and their own test `describe` blocks. If any match appears in `index.js` or `product-extractor.js`, Tasks 4/5 are incomplete - stop and fix them first.

- [ ] **Step 2: Delete the functions, bindings, and their tests**

Remove the `fetchWikipediaSummary` and `fetchWikipediaFullText` function bodies from `wikipedia.js`, and delete the `describe('fetchWikipediaSummary', ...)` and `describe('fetchWikipediaFullText', ...)` blocks from the test file. `createWikipediaService` now reads:

```javascript
export function createWikipediaService(log) {
  return {
    findWikidataId: (brandName) => findWikidataId(brandName, log),
    resolveBrand: (brandName, opts) => resolveBrandWikipedia(brandName, opts, log),
  };
}
```

- [ ] **Step 3: Verify removal and green suite**

Run:
```bash
grep -rn "fetchWikipediaSummary\|fetchWikipediaFullText\|fetchFullText\|fetchSummary" src/ test/
npx mocha test/agents/brand-profile/services/wikipedia.test.js
```
Expected: grep returns nothing; wikipedia suite PASS.

- [ ] **Step 4: Run the full brand-profile suite and lint**

Run:
```bash
npx mocha "test/agents/brand-profile/**/*.test.js"
npm run lint
```
Expected: PASS, no unused-import or other lint errors (confirms the import change in Task 4 left nothing dangling).

- [ ] **Step 5: Commit**

```bash
git add src/agents/brand-profile/services/wikipedia.js test/agents/brand-profile/services/wikipedia.test.js
git commit -m "refactor(brand-profile): remove dead name-based Wikipedia functions"
```

---

### Task 7: Update `brand-profile-agent.md` Services Detail

**Files:**
- Modify: `docs/brand-profile/brand-profile-agent.md` (Services Detail section, ~lines 216-217 and ~240-242)

**Interfaces:** none (documentation).

- [ ] **Step 1: Update the Product Extractor entry**

Change the documented signature `extractProducts(brandName, wikipediaText)` to `extractProducts(brandName, { wikidataId, wikipediaText })` and add one line that the Wikipedia fallback is QID-anchored (resolved from the Wikidata sitelink, guarded on `wikibase_item`).

- [ ] **Step 2: Update the Wikipedia Service function list**

Replace the `fetchSummary`/`fetchFullText` entries with `resolveBrand(brandName, { wikidataId })` (QID-anchored resolve with guard) and note `findWikidataId` is retained. Add a one-line pointer to `wikidata-anchoring-fix.md`.

- [ ] **Step 3: Verify no other stale references**

Run:
```bash
grep -n "fetchSummary\|fetchFullText\|wikipediaText)" docs/brand-profile/brand-profile-agent.md
```
Expected: no stale matches remain.

- [ ] **Step 4: Commit**

```bash
git add docs/brand-profile/brand-profile-agent.md
git commit -m "docs(brand-profile): update Services Detail for QID-anchored resolution"
```

---

## Self-Review

**Spec coverage:**
- Anchor + guard (spec Approach) -> Tasks 1-3.
- `extractProducts` context contract + breadcrumb (spec Interfaces, Rollout) -> Task 4.
- Single gated resolve, Phase 4 + Phase 6 rewire, `Unknown Brand` skip (spec Interfaces) -> Task 5.
- Delete name-based functions + bindings (spec Interfaces, the approved decision) -> Task 6.
- Guard scope / error degradation / distinct discard reasons (spec Error handling) -> Tasks 3-4 (reasons) + the guard-mismatch `warn` (Task 3).
- Test blast radius across all three test files + mechanism-asserting regression (spec Testing) -> Tasks 4 (product-extractor + mechanism), 5 (index), 6 (wikipedia deletions).
- Doc update (spec Documentation) -> Task 7.
- Redirect handling (`redirects=1`) -> Task 2. Exact-string guard, no-`wikibase_item` case, fetch-error, no-sitelink, no-qid -> Task 3. Gating tests + sentinel -> Task 5. Enough-SPARQL-skips-fallback -> Task 4.

**Placeholder scan:** no TBD/TODO; every code and test step carries real code.

**Type consistency:** `resolveBrandWikipedia` returns `{ wikidataId, title, fullText, summary, verified, discardReason }` in Task 3 and is consumed with those exact keys in Tasks 4 (`resolved.verified`, `resolved.fullText`, `resolved.discardReason`) and 5 (`brandWiki.summary`, `brandWiki.wikidataId`, `brandWiki.fullText`). `extractProducts(brandName, { wikidataId, wikipediaText })` defined in Task 4 matches the call in Task 5. `resolveBrand(brandName, opts)` binding (Task 3) matches the Task 5 call `resolveBrand(brandName)` (opts optional).

## Notes for the executor

- One open behavioural detail is intentionally the implementer's to confirm against the live MediaWiki response: that `prop=extracts|pageprops` with `explaintext=true` returns both `extract` and `pageprops.wikibase_item` in a single `query` (Task 2). The tests stub this shape; if the live API needs `exsectionformat` or a `continue` round, adjust `fetchWikipediaArticleByTitle` only, keeping its return contract.
- The `unresolved-upstream` breadcrumb value (Task 4, provided-but-empty text path) is the one case where the precise reason lives in the `index.js` logs rather than the persisted field; that is acceptable because the backfill targets on `wikipedia_verified === false`.
