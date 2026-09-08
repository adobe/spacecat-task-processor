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
    Wikipedia fetch and an LLM extraction over whatever article that returned.
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
  Wikipedia-derived data for that field rather than wrong data.

## Non-goals

- Remediation of already-contaminated brand profiles and the downstream
  suggestions already generated from them. That is a separate operational
  backfill owned on the consumer/LLMO side, and depends on this fix landing
  first.
- The accuracy of `findWikidataId`'s own name -> QID resolution. The upstream
  report confirms the QID is resolved correctly; this fix trusts it. A wrong
  QID is a distinct, lower-prevalence problem.
- The sitemap-based product path (`extractFromSitemap`), which does not use
  Wikipedia and is unaffected.

## Approach: anchor + guard

Resolve the brand's Wikidata QID **once, up front**, resolve its English
Wikipedia article from the **QID's sitelink** (not a name search), fetch that
exact article, verify the fetched page's `wikibase_item` equals the QID
(guard), and share that single anchored article with both the competitor phase
and the product phase.

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

`src/agents/brand-profile/services/wikipedia.js` (additions):

- `fetchWikidataSitelinkTitle(wikidataId, log)` -> `Promise<string|null>`
  Calls the Wikidata `wbgetentities` action with `props=sitelinks` and
  `sitefilter=enwiki`; returns the English Wikipedia page title for the QID,
  or `null` when the entity has no English Wikipedia sitelink.
- `fetchWikipediaArticleByTitle(title, { maxChars = 12000 }, log)`
  -> `Promise<{ title, fullText, summary, wikidataId }|null>`
  Fetches an exact title (no `opensearch`), returning the plain-text extract,
  the intro summary, and `pageprops.wikibase_item`.
- `resolveBrandWikipedia(brandName, log)`
  -> `Promise<{ wikidataId, title, fullText, summary, verified }>`
  Orchestrates QID -> sitelink title -> article -> guard. On any failure,
  missing sitelink, or guard mismatch it returns an object with empty
  `fullText`/`summary` and `verified: false` (never throws).

The existing name-based `fetchWikipediaFullText` and `fetchWikipediaSummary`
are retained (other behaviour and tests depend on them) but are no longer used
by the two fixed call sites and are marked deprecated in favour of the
QID-anchored path.

`src/agents/brand-profile/services/product-extractor.js`:

- `extractProducts(brandName, wikipediaContext, gpt, log)` where
  `wikipediaContext = { wikidataId, wikipediaText }` is pre-resolved and
  QID-anchored. Step 1 uses `wikipediaContext.wikidataId` when provided (falls
  back to `findWikidataId(brandName)` only when absent, for defensive/other
  callers). Step 3 uses `wikipediaContext.wikipediaText`; when absent but a QID
  is known it resolves via `resolveBrandWikipedia`. When no anchored article is
  available, the Wikipedia fallback is skipped (no LLM call, no products).
- `createProductExtractorService(...).extractProducts` binding updated to the
  new signature.

`src/agents/brand-profile/index.js`:

- After `brandName` is extracted, call `resolveBrandWikipedia(brandName)` once
  and hold the result.
- Phase 4 (competitors): pass the anchored `summary` to `inferCompetitors`
  instead of `fetchSummary(\`${brandName} company\`)`.
- Phase 6 (products, non-sitemap branch): call
  `extractProducts(brandName, { wikidataId, wikipediaText })` with the anchored
  values instead of pre-fetching by name.

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
once     resolveBrandWikipedia("Lovesac")
         -> findWikidataId -> Q6690181
         -> sitelink -> "Lovesac" -> article(Lovesac), guard ok
Phase 4  competitors <- Lovesac summary
Phase 6  extractProducts(brandName, { wikidataId: Q6690181, wikipediaText: Lovesac })
         SPARQL(Q6690181) primary; fallback extracts from Lovesac article only
```

## Error handling

Every Wikidata/Wikipedia call already returns `null`/`[]` on failure and logs;
that is preserved. Specifically:

- No QID resolved -> no anchored article -> Wikipedia fallback skipped;
  products come from Wikidata SPARQL only (possibly empty); competitor summary
  empty.
- QID resolved but no English Wikipedia sitelink -> same as above (safe).
- Guard mismatch (`article.wikidataId !== wikidataId`, e.g. a redirect or a
  moved/vandalised title) -> discard, log a warning, treat as no article.
- The agent never throws on these paths; it degrades to less data, not wrong
  data.

## Testing (TDD)

Unit tests using the existing harness (mocha + c8, chai + sinon + sinon-chai,
`esmock` for module boundaries, and a `sinon` stub on `globalThis.fetch`), as
in `wikipedia.test.js` / `product-extractor.test.js`. Red-first:

1. Lovesac regression (the bug): `findWikidataId` -> `Q6690181`; SPARQL returns
   fewer than 3 products; a name `opensearch` *would* return the Lovisa
   article. Assert the resolved products/sub_brands contain no Lovisa and no
   "jewellery" category, and are sourced from the Lovesac article (or empty).
2. Guard: the sitelink title resolves to a page whose `wikibase_item` differs
   from the QID -> article discarded, no Wikipedia products.
3. No enwiki sitelink: QID present, `fetchWikidataSitelinkTitle` -> `null` ->
   no Wikipedia fallback, no crash, SPARQL-only products.
4. Competitor path: anchored summary is passed to `inferCompetitors`; on
   mismatch/no-article the summary is empty.
5. Happy path: enough SPARQL products -> Wikipedia fallback not invoked
   (unchanged behaviour).
6. Existing suite stays green; tests asserting the old name-based fetch at the
   fixed call sites are updated to the anchored path.

## Rollout

- Code-only change in `spacecat-task-processor`; no schema change, no change to
  the persisted brand-profile shape, no cross-service contract change.
- New profiles generated after deploy are anchored. Existing contaminated
  profiles are corrected by the separate backfill (non-goal above), which
  re-runs the agent per affected site.

## References

- Upstream issue: adobe-rnd/llmo-data-retrieval-service#3200
- Buggy code: `src/agents/brand-profile/services/{wikipedia,product-extractor}.js`,
  `src/agents/brand-profile/index.js`
