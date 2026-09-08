# Brand-profile: QID-anchored Wikipedia resolution

- Status: proposed
- Date: 2026-09-08
- Repo: spacecat-task-processor (`src/agents/brand-profile`)
- Upstream report: adobe-rnd/llmo-data-retrieval-service#3200

## Problem

The `brand-profile` agent contaminates a brand's `products` and `sub_brands`
(and, via the same mechanism, its inferred `competitors`) with data from a
different company that merely shares a similar name.

The entity resolution itself is correct: `findWikidataId(brandName)` resolves
the right Wikidata QID (e.g. Lovesac -> `Q6690181`, the furniture brand). The
contamination happens in the **Wikipedia fallback**, which does a fresh
name-based search instead of anchoring on the QID already resolved:

- `src/agents/brand-profile/services/wikipedia.js`
  - `fetchWikipediaFullText(searchQuery, ...)` runs an `opensearch` for the
    query and blindly takes `titles[0]` (the first hit). No QID check.
  - `fetchWikipediaSummary(searchQuery, ...)` does the same and reads
    `pageprops.wikibase_item` but never verifies it against a known QID.
- `src/agents/brand-profile/services/product-extractor.js`
  - `extractProducts()` resolves the QID (Step 1) and queries Wikidata SPARQL
    anchored on that QID (Step 2, correct). When SPARQL returns fewer than
    `MIN_PRODUCTS_THRESHOLD` (3) products, Step 3 falls back to a name-based
    Wikipedia fetch (`fetchWikipediaFullText(\`${brandName} company\`, ...)`,
    line ~520) and an LLM extraction over whatever article that returned.
- `src/agents/brand-profile/index.js`
  - Phase 6 (line ~236) pre-fetches Wikipedia text by `` `${brandName} company` ``
    and passes it into `extractProducts`.
  - Phase 4 (line ~204) fetches a Wikipedia summary by `` `${brandName} company` ``
    and feeds it to competitor inference.

For Lovesac, the name search surfaces **Lovisa** (an Australian fast-fashion
jewellery retailer), so `products.items[*].category` becomes "Fast fashion
jewellery" and `sub_brands` becomes `["Lovisa","Diva","Jewells","Six","I Am"]`.

### Blast radius

Downstream LLMO generation pipelines read brand-profile products. Synthetic
Personas uses `products.items[*].category` as its number-one category source,
so the wrong category wins over the correct industry. Per the upstream report,
a scan of 1,742 LLMO brands found 515 with populated products and ~115 clearly
contaminated with a wrong same-named company (about half of everything sourced
via the Wikipedia fallback step).

## Goals

- Products, sub-brands, and the competitor-inference summary are drawn only
  from the Wikipedia article that corresponds to the brand's resolved Wikidata
  QID, never from a same-named entity.
- When the correct article cannot be established, the pipeline yields **no**
  Wikipedia-derived data for that field rather than wrong data, and records a
  breadcrumb saying why (so the downstream backfill can target affected
  profiles).

## Non-goals

- Remediation of already-contaminated brand profiles and the downstream
  suggestions already generated from them. That is a separate operational
  backfill owned on the consumer/LLMO side, and depends on this fix landing
  first. This PR adds a persisted breadcrumb (below) to make that backfill
  targetable, but does not perform it.
- The accuracy of `findWikidataId`'s own name -> QID resolution. The upstream
  report attributes the ~115/515 contamination to the Wikipedia fallback, not
  to QID resolution, so this fix trusts the resolved QID. A wrong QID is a
  distinct, lower-prevalence problem, and the `wikibase_item` guard below does
  **not** defend against it (see Error handling).
- The sitemap-based product path (`extractFromSitemap`), which does not use
  Wikipedia and is unaffected.

## Approach: anchor + guard

Resolve the brand's Wikidata QID **once**, resolve its English Wikipedia
article from the **QID's sitelink** (not a name search), fetch that exact
article, verify the fetched page's `wikibase_item` equals the QID (guard), and
share that single anchored article with both the competitor phase and the
product phase.

```
findWikidataId(brandName)            -> Q6690181            (unchanged, trusted)
fetchWikidataSitelinkTitle(Q6690181) -> "Lovesac"           (NEW: enwiki sitelink)
fetchWikipediaArticleByTitle("Lovesac")
                                     -> { fullText, summary, wikidataId }
guard: article.wikidataId === Q6690181 ? keep : discard      (NEW)
```

The Wikidata SPARQL products query (Step 2 of `extractProducts`) is already
anchored on the QID and is kept as-is; it remains the primary source. The
Wikipedia article only augments/falls back, and now only from the correct
entity.

### Interfaces

`src/agents/brand-profile/services/wikipedia.js`:

- **Add** `fetchWikidataSitelinkTitle(wikidataId, log)` -> `Promise<string|null>`.
  Calls the Wikidata `wbgetentities` action with `props=sitelinks` and
  `sitefilter=enwiki`; returns `entities[<qid>].sitelinks.enwiki.title`, or
  `null` when the entity has no English Wikipedia sitelink.
- **Add** `fetchWikipediaArticleByTitle(title, maxChars, log)`
  -> `Promise<{ title, fullText, summary, wikidataId }|null>`.
  Fetches an exact title (no `opensearch`) with `redirects=1` and
  `prop=extracts|pageprops`, `explaintext=true` (no `exintro`), so one query
  returns the full plain-text extract **and** `pageprops.wikibase_item`.
  `summary` is derived locally as the first paragraph of `fullText` (split on
  the first blank line); `fullText` is truncated to `maxChars`. Positional
  signature `(title, maxChars, log)` matches the file's existing
  `(query, maxChars, log)` convention.
  - Behaviour note: today's competitor summary comes from an `exintro` extract;
    deriving `summary` from the first paragraph of the full extract is a minor
    behavioural change (usually the same lead paragraph), accepted to avoid a
    second round-trip. Pinned by a test.
- **Add** `resolveBrandWikipedia(brandName, { wikidataId } = {}, log)`
  -> `Promise<{ wikidataId, title, fullText, summary, verified, discardReason }>`.
  Orchestrates QID -> sitelink title -> article -> guard. Uses the passed
  `wikidataId` when provided (skips re-running `findWikidataId`); otherwise
  resolves it from `brandName`. Wrapped so it **never throws**: on any failed
  sub-call, missing sitelink, or guard mismatch it returns empty
  `fullText`/`summary`, `verified: false`, and a `discardReason` (one of
  `no-qid`, `no-sitelink`, `guard-mismatch`, `fetch-error`).
- **Remove** the name-based `fetchWikipediaFullText` and `fetchWikipediaSummary`
  functions, their `fetchFullText`/`fetchSummary` bindings on
  `createWikipediaService`, and their unit tests. Verified: their only
  production consumers are the three call sites this PR fixes, so after the
  change they are dead code that still encodes the first-hit-name-search bug.
  Leaving them (even deprecated) lets a future caller re-introduce the exact
  contamination in one call, so they are deleted outright rather than retained.
- **Expose** `resolveBrandWikipedia` on `createWikipediaService` as
  `resolveBrand: (brandName, opts) => resolveBrandWikipedia(brandName, opts, log)`,
  so `index.js` reaches it through the same log-bound service object it uses for
  every other Wikipedia call. This is the only Wikipedia entry point the
  pipeline retains.

`src/agents/brand-profile/services/product-extractor.js`:

- `extractProducts(brandName, wikipediaContext, gpt, log)` where
  `wikipediaContext = { wikidataId, wikipediaText }` is pre-resolved and
  QID-anchored. Normalisation: a `null`/`undefined` arg is treated as `{}` (no
  context); a truthy non-object arg (e.g. a stale string caller) **throws** a
  clear error rather than silently degrading, so no caller can pass article
  text the old way and have it ignored.
  - Step 1 uses `wikipediaContext.wikidataId` when provided (falls back to
    `findWikidataId(brandName)` only when absent).
  - Step 2 (Wikidata SPARQL) unchanged.
  - Step 3 fallback uses `wikipediaContext.wikipediaText`; when absent but a QID
    is known it resolves via `resolveBrandWikipedia(brandName, { wikidataId })`.
    When no anchored article is available, the Wikipedia fallback is skipped
    entirely (no LLM call, no products).
  - Records the anchoring outcome on the existing free-form metadata object:
    `metadata.wikipedia_verified` (boolean) and, when not verified,
    `metadata.wikipedia_discard_reason` (the `discardReason` above). This is
    within the current unstructured `products_metadata` shape (no schema
    change) and is what lets the downstream backfill target affected profiles.
- `createProductExtractorService(...).extractProducts` binding updated to the
  new signature.

`src/agents/brand-profile/index.js`:

- After `brandName` is extracted, resolve the anchored article **once** and
  hold it - but only when a consumer will actually use it. Skip the resolve
  when both downstream phases will bypass Wikipedia, i.e. resolve only when
  `!hasText(sitemapUrl) || (Array.isArray(llmoCompetitors) && llmoCompetitors.length === 0)`.
  Also skip when `brandName` is the `'Unknown Brand'` sentinel
  (`extractBrandName` fallback), which would otherwise resolve a garbage QID.
- Phase 4 (competitors): when it infers competitors (no `llmoCompetitors`),
  pass the anchored `summary` to `inferCompetitors` instead of
  `wikipediaService.fetchSummary(\`${brandName} company\`)`.
- Phase 6 (products, non-sitemap branch): call
  `extractProducts(brandName, { wikidataId, wikipediaText: fullText })` with the
  anchored values instead of pre-fetching by name.

## Data flow

Before (contaminated):

```
Phase 4  fetchSummary("Lovesac company")  -> Lovisa intro   -> competitors
Phase 6  fetchFullText("Lovesac company") -> Lovisa article -> extractProducts
         extractProducts: SPARQL(Q6690181) < 3 -> extract from Lovisa article
         -> products=jewellery, sub_brands=[Lovisa,Diva,...]
```

After (anchored):

```
once     resolveBrandWikipedia("Lovesac")     (only if a phase needs it)
         -> findWikidataId -> Q6690181
         -> sitelink -> "Lovesac" -> article(Lovesac), guard ok
Phase 4  competitors <- Lovesac summary
Phase 6  extractProducts(brandName, { wikidataId: Q6690181, wikipediaText: Lovesac })
         SPARQL(Q6690181) primary; fallback extracts from Lovesac article only
```

Common-path call count (inferred competitors, no sitemap) drops from ~6
Wikipedia/Wikidata HTTP calls today to ~4 (3 in the shared resolve, 1 SPARQL).

## Error handling

Every Wikidata/Wikipedia call already returns `null`/`[]` on failure and logs;
`resolveBrandWikipedia` wraps its orchestration so it never throws. Outcomes:

- No QID resolved -> `discardReason: no-qid` -> Wikipedia fallback skipped;
  products come from Wikidata SPARQL only (possibly empty); competitor summary
  empty.
- QID resolved but no English Wikipedia sitelink -> `no-sitelink` -> same.
- Guard mismatch (`article.wikidataId !== wikidataId`, including the page having
  no `wikibase_item` at all - e.g. a redirect that landed on a different
  entity, or a moved/vandalised title) -> `guard-mismatch`, discard, log a
  `warn` including brandName, expected QID, resolved title, and the actual
  `wikibase_item` (e.g. `Lovesac: expected Q6690181, article 'Lovisa' had
  Q1141985 - discarding`).
- Any sub-call throwing/rejecting -> `fetch-error` -> discard.
- The agent never throws on these paths; it degrades to less data, not wrong
  data, and records the reason via the metadata breadcrumb.

**Guard scope (stated explicitly).** The `wikibase_item` guard validates the
QID -> article resolution only. Because the article is fetched from the QID's
own sitelink, the guard essentially always passes; its real value is catching a
stale/moved sitelink or a redirect to a different entity. It gives **no**
protection against `findWikidataId` resolving the wrong same-named QID in the
first place - that case passes the guard and is out of scope (see Non-goals).
`redirects=1` on the by-title fetch recovers valid data from moved pages while
the guard still rejects a redirect that lands on a different entity.

## Testing (TDD)

Unit tests using the existing harness (mocha + c8, chai + sinon + sinon-chai,
`esmock` for module boundaries, and a `sinon` stub on `globalThis.fetch`), as
in `wikipedia.test.js` / `product-extractor.test.js` / `index.test.js`.

**Test blast radius (the "existing suite stays green" claim does NOT hold - all
three brand-profile test files change):**

- `wikipedia.test.js`: delete the `fetchWikipediaFullText`/`fetchWikipediaSummary`
  cases (functions removed); add cases for `fetchWikidataSitelinkTitle`,
  `fetchWikipediaArticleByTitle`, and `resolveBrandWikipedia`.
- `product-extractor.test.js`: the ~10-16 direct `extractProducts(brand, <string|null>, ...)`
  calls must be reshaped to the `{ wikidataId, wikipediaText }` object. A `null`
  second arg currently used by several tests must become `{}`/omitted; a bare
  string arg must become `{ wikipediaText }`. Each rewritten test must keep
  asserting the extraction actually happened (e.g. `gpt.fetchChatCompletion`
  was called with the injected text), not merely that it returned - the silent
  no-op under the new signature is exactly how these would go green for the
  wrong reason.
- `index.test.js`: the ~7 Wikipedia-service mocks (default `createMockServices`
  plus the inline blocks) currently expose only `{ fetchSummary, fetchFullText }`
  and must gain `resolveBrand` (and drop the removed methods), or every
  `enhance=true` orchestrator test throws.

**Red-first cases:**

1. Regression (the bug), asserting the **mechanism**, not just output:
   `findWikidataId` -> `Q6690181`; SPARQL returns fewer than 3 products.
   Assert (a) `fetch` is never called with `action=opensearch` (no
   `${brandName} company` search) at either call site, (b) `extractProducts`
   receives `wikipediaContext.wikidataId === 'Q6690181'` and SPARQL is issued
   for that QID, and (c) resolved products/sub_brands contain no Lovisa and no
   "jewellery" category.
2. Guard mismatch: the sitelink title resolves to a page whose `wikibase_item`
   differs from the QID -> discarded, `discardReason: guard-mismatch`, warn
   logged with the diagnostic fields.
3. Guard, no `wikibase_item` at all (page has none) -> discarded (distinct
   branch from case 2, same outcome).
4. No enwiki sitelink: QID present, `fetchWikidataSitelinkTitle` -> `null` ->
   no Wikipedia fallback, `no-sitelink`, SPARQL-only products, no crash.
5. Fetch failure: `wbgetentities` or the title query is non-ok/rejects ->
   `verified:false`, `fetch-error`, never throws.
6. Competitor path: anchored summary passed to `inferCompetitors`; on
   mismatch/no-article the summary is empty. When `llmoCompetitors` are
   provided, no Wikipedia call is made at all.
7. Gating: (a) `sitemapUrl` + `llmoCompetitors` both provided -> `resolveBrand`
   NOT called; (b) `sitemapUrl`, no `llmoCompetitors` -> `resolveBrand` called
   for the summary, `extractFromSitemap` used for products.
8. `'Unknown Brand'` sentinel -> resolve skipped.
9. `wikipediaContext` normalisation: `null`/omitted -> treated as no context
   (no crash); a bare string arg -> throws a clear error.
10. Happy fallback: guard passes, article fetched, LLM returns zero products ->
    empty/SPARQL-only result with correct `source` label.
11. Enough SPARQL products (>=3) -> Wikipedia fallback not invoked at all
    (assert no sitelink/article fetch).
12. Guard comparison is exact-string QID (no case/whitespace normalisation).

## Documentation

`docs/brand-profile/brand-profile-agent.md` documents the interfaces this
change supersedes (the `extractProducts(brandName, wikipediaText)` signature and
the Wikipedia Service function list). Its Services Detail section is updated in
**this** PR - the DOCUMENTATION-GUIDE assigns that doc to this repo, so keeping
it accurate is part of the change, not a follow-up.

## Rollout

- Code-only change in `spacecat-task-processor`; no persisted-shape schema
  change (the `wikipedia_verified` / `wikipedia_discard_reason` breadcrumb lives
  in the already free-form `products_metadata` object), no cross-service
  contract change.
- New profiles generated after deploy are anchored. Existing contaminated
  profiles are corrected by the separate backfill (non-goal above), which
  re-runs the agent per affected site and can use the breadcrumb to target the
  ~115 affected profiles rather than re-scanning all brands.

## References

- Upstream issue: adobe-rnd/llmo-data-retrieval-service#3200
- Buggy code: `src/agents/brand-profile/services/{wikipedia,product-extractor}.js`,
  `src/agents/brand-profile/index.js`
- Sibling docs: `docs/brand-profile/brand-profile-agent.md`,
  `docs/brand-profile/brand-profile-schema-changes.md`
