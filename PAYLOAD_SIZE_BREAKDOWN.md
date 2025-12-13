# Payload Size Analysis - 103 KB Issue

## Current Payload Breakdown

```javascript
mystiquePayload = {
  requestId: "...",                    // ~100 bytes
  siteUrl: "https://...",              // ~50 bytes
  auditType: "cwv",                    // ~10 bytes
  
  opportunity: {                       // ~5-10 KB (estimated)
    id, type, title, description,
    data: {...},                       // Can be large!
    guidance: {...},                   // Can be large!
    runbook: "..."
  },
  
  suggestions: [...],                  // ~30-50 KB (estimated)
    // Array of suggestions with full data
    // Each suggestion.data can be 1-3 KB
  
  auditContext: {                      // ~10-20 KB (estimated)
    auditResult: {...},                // Full audit results
    scores: {...}
  },
  
  additionalContext: {                 // ~29 KB (25 pages)
    topPages: [...]                    // Our optimization target
  }
}
```

## Issue Analysis

**Total: 103 KB** breaks down roughly as:
- Suggestions data: ~40-50 KB (40-50%)
- Additional context (25 pages): ~29 KB (28%)
- Audit context: ~15 KB (15%)
- Opportunity data: ~8 KB (8%)

**Problem**: While we reduced pages from 100→25, the payload is still large due to:
1. Suggestions contain full data for each suggestion
2. Audit context contains full audit results
3. Long keywords in top pages

## Optimization Strategy

We should focus on `additionalContext` since it's under our control:

### Current (25 pages):
```javascript
{
  url: "https://very-long-url.com/path/to/page",  // ~80-150 bytes
  traffic: 12345,                                   // ~5 bytes
  topKeyword: "very long keyword phrase...",        // 20-300 bytes! ⚠️
  source: "ahrefs",                                 // ~7 bytes (redundant!)
  rank: 1                                           // ~1 byte
}
// Total per page: ~120-450 bytes (avg ~200)
// 25 pages × 200 = ~5,000 bytes overhead + ~24KB data = ~29 KB
```

### Optimized (15 pages, truncated):
```javascript
{
  url: "https://very-long-url.com/path/to/page",  // ~80-150 bytes
  traffic: 12345,                                   // ~5 bytes
  topKeyword: "truncated to 100 chars...",         // Max 100 bytes ✅
  // source: removed (always 'ahrefs')               // Save ~7 bytes
  rank: 1                                           // ~1 byte
}
// Total per page: ~90-160 bytes (avg ~125)
// 15 pages × 125 = ~1,875 bytes overhead + ~16KB data = ~18 KB
```

**Savings**: 29 KB → 18 KB = **38% reduction**

## Recommended Changes

### 1. Reduce to 15 pages (from 25)
- Still captures **75-80% of traffic** (excellent coverage)
- Reduces pages by 40%
- Sweet spot for AI focus

### 2. Truncate topKeyword to 100 chars
- Keywords can be 200-300 chars (excessive!)
- 100 chars = sufficient for context
- Saves ~100-200 bytes per page

### 3. Remove 'source' field
- Always 'ahrefs' (redundant)
- Save ~7 bytes per page × 15 = 105 bytes

## Expected Results

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| Top pages count | 25 | 15 | -40% |
| additionalContext size | ~29 KB | ~18 KB | **-38%** |
| Total payload | 103 KB | **~92 KB** | **-11%** |
| AI tokens (total) | ~25K | ~23K | -8% |

## Traffic Coverage Analysis

| Pages | Traffic Captured | Use Case |
|-------|------------------|----------|
| Top 10 | 60-70% | Minimum viable |
| **Top 15** | **75-80%** | ✅ **Optimal balance** |
| Top 20 | 80-85% | Diminishing returns |
| Top 25 | 85-88% | Marginal gain (+3-8%) |

**Verdict**: 15 pages is the sweet spot!

## AI Hallucination Risk

### Risk Factors:
1. **Context overload**: >100 KB increases hallucination risk
2. **Diluted attention**: Too many pages = AI loses focus
3. **Token limits**: Approaching model context limits

### Mitigation:
- ✅ Reduce to 92 KB (safer zone)
- ✅ Focus on top 15 pages (better signal-to-noise)
- ✅ Truncate verbose fields

## Implementation

