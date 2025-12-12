# Additional Context Size Analysis

## Current Situation
- **Payload Size**: 115,209 bytes (~112 KB)
- **Data**: 100 top pages for CWV enrichment
- **Size per page**: ~1,150 bytes

## What's Being Sent

```javascript
{
  "additionalContext": {
    "topPages": [
      {
        "url": "https://example.com/very/long/path",  // ~50-150 chars
        "traffic": 12345,                              // ~5 chars
        "topKeyword": "long keyword phrase here",      // ~20-200 chars
        "source": "ahrefs",                            // 7 chars
        "rank": 1                                      // 1-3 chars
      },
      // ... x 100 pages
    ]
  }
}
```

## Size Breakdown (per page)

| Field | Avg Size | Notes |
|-------|----------|-------|
| `url` | 80-150 bytes | Long URLs (paths, query params) |
| `traffic` | 5-8 bytes | Number |
| `topKeyword` | 20-200 bytes | **Can be very long** |
| `source` | 7 bytes | Always "ahrefs" |
| `rank` | 1-3 bytes | 1-100 |
| JSON overhead | ~30 bytes | Quotes, commas, braces |
| **Total** | ~150-400 bytes | |

**Actual**: ~1,150 bytes suggests long keywords or URLs

## Is 100 Pages Helpful?

### Traffic Distribution (80/20 Rule)
- Top 10 pages: ~60-70% of traffic
- Top 20 pages: ~75-85% of traffic
- Top 50 pages: ~90-95% of traffic
- Top 100 pages: ~95-98% of traffic

### AI Context Window
- 100 pages x 1,150 bytes = ~115 KB
- Converted to tokens: ~28,000 tokens (at 4 bytes/token)
- **That's significant for the AI model!**

### Use Case Analysis

#### CWV (Core Web Vitals)
- **Purpose**: Understand site traffic for impact analysis
- **Need**: Top 10-20 pages sufficient (capture most traffic)
- **Current**: 100 pages (overkill)
- **Recommendation**: **Reduce to 25 pages**

#### Meta-tags
- **Purpose**: Prioritize which pages to fix first (SEO impact)
- **Need**: Top 20-30 pages for priority ranking
- **Current**: 100 pages (too much)
- **Recommendation**: **Reduce to 30 pages**

#### Broken Backlinks
- **Purpose**: Link equity context
- **Need**: Top 10-20 pages to understand link distribution
- **Current**: 50 pages
- **Recommendation**: **Reduce to 20 pages**

#### Broken Internal Links
- **Purpose**: Site topology
- **Need**: Top 15-20 pages for main navigation
- **Current**: 50 pages
- **Recommendation**: **Reduce to 20 pages**

#### Accessibility
- **Purpose**: Traffic impact for prioritization
- **Need**: Top 15-20 pages
- **Current**: 50 pages
- **Recommendation**: **Reduce to 20 pages**

## Optimization Options

### Option 1: Reduce Limits (RECOMMENDED)
```javascript
const AUDIT_DEPENDENCIES = {
  cwv: {
    topPages: { source: 'ahrefs', geo: 'global', limit: 25 },  // Was 100
  },
  'meta-tags': {
    topPages: { source: 'ahrefs', geo: 'global', limit: 30 },  // Was 100
  },
  'broken-backlinks': {
    topPages: { source: 'ahrefs', geo: 'global', limit: 20 },  // Was 50
  },
  'broken-internal-links': {
    topPages: { source: 'ahrefs', geo: 'global', limit: 20 },  // Was 50
  },
  accessibility: {
    topPages: { source: 'ahrefs', geo: 'global', limit: 20 },  // Was 50
  },
};
```

**Impact**: Reduces payload from ~115 KB to ~29 KB (75% reduction)

### Option 2: Truncate Fields
```javascript
context.topPages = topPages.slice(0, limit).map((page, index) => ({
  url: page.getUrl(),
  traffic: page.getTraffic(),
  topKeyword: page.getTopKeyword()?.substring(0, 50) || '',  // Truncate to 50 chars
  rank: index + 1,
  // Remove 'source' (always 'ahrefs', can be assumed)
}));
```

**Impact**: Saves ~10-15 bytes per page

### Option 3: Send Summary Statistics
```javascript
context.topPagesStats = {
  totalPages: topPages.length,
  topTrafficPages: topPages.slice(0, 10).map(p => ({
    url: p.getUrl(),
    traffic: p.getTraffic(),
    rank: p.getRank(),
  })),
  trafficDistribution: {
    top10Traffic: topPages.slice(0, 10).reduce((sum, p) => sum + p.getTraffic(), 0),
    top20Traffic: topPages.slice(0, 20).reduce((sum, p) => sum + p.getTraffic(), 0),
    totalTraffic: topPages.reduce((sum, p) => sum + p.getTraffic(), 0),
  },
};
```

**Impact**: Very compact, but loses per-page detail

## Recommendation

### ✅ Implement Option 1 (Reduce Limits)

**Rationale:**
1. **80/20 Rule**: Top 20-30 pages capture 85%+ of traffic
2. **AI Token Efficiency**: Fewer pages = better focus, lower cost
3. **Sufficient Context**: 20-30 pages still provides rich context
4. **Faster Processing**: Less data = faster serialization/transmission

**New Limits:**
- CWV: 25 pages (from 100)
- Meta-tags: 30 pages (from 100)
- Others: 20 pages (from 50)

**Expected Payload Sizes:**
- CWV: ~29 KB (was 115 KB)
- Meta-tags: ~35 KB (was 115 KB)
- Others: ~23 KB (was 58 KB)

### 🎯 Additional Optimization (Optional)

**Truncate long keywords:**
```javascript
topKeyword: (page.getTopKeyword() || '').substring(0, 100),  // Max 100 chars
```

**Remove redundant field:**
```javascript
// Remove 'source' - it's always 'ahrefs' and can be assumed
```

## SQS Limits

| Limit | Value |
|-------|-------|
| Max message size | 256 KB |
| Current (100 pages) | ~115 KB (45% of limit) ✅ |
| Optimized (25 pages) | ~29 KB (11% of limit) ✅ |
| Headroom for other data | ~227 KB remaining |

**Verdict**: Even 100 pages fits within SQS limits, but optimization improves AI efficiency and cost.

## Testing Impact

### Before Optimization (100 pages)
```
Payload: 115 KB
AI tokens: ~28,000
Processing time: ~8-12 seconds
```

### After Optimization (25 pages)
```
Payload: 29 KB
AI tokens: ~7,000
Processing time: ~5-8 seconds (estimated)
```

## Action Items

1. ✅ **Reduce limits in `AUDIT_DEPENDENCIES`** (25-30 instead of 50-100)
2. ⚠️ **Optional**: Truncate `topKeyword` to 100 chars
3. ⚠️ **Optional**: Remove `source` field (redundant)
4. ✅ **Test**: Verify enrichment quality with reduced context
5. ✅ **Monitor**: Track AI performance and cost savings

