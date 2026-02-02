# Brand Profile Schema Changes (PR #182)

This document details the schema changes introduced in PR #182 for developers who consume the brand profile data.

## Summary

PR #182 adds enhanced brand profile capabilities with 14 new top-level fields. The `main_profile` structure remains unchanged, ensuring backward compatibility with existing consumers.

## New Fields Added

### Regional Context Fields

| Field | Type | Example | Description |
|-------|------|---------|-------------|
| `country_code` | string | `"US"` | 2-letter ISO country code |
| `region_inference` | object | See below | Detection metadata |
| `languages` | string[] | `["en-US", "es-US"]` | Supported language locales |
| `primary_language` | string | `"en-US"` | Dominant language |
| `currency` | string | `"USD"` | Local currency code |
| `business_model` | string | `"B2C"` | `"B2B"`, `"B2C"`, or `"B2B & B2C"` |
| `regulatory_context` | string | `"GDPR compliance..."` | Industry regulations summary |
| `key_terminology` | object | `{"en": [...]}` | Language-keyed term arrays |
| `market_specifics` | string | `"US consumers..."` | Regional market characteristics |

**`region_inference` object:**
```json
{
  "country_code": "US",
  "confidence": "high",
  "detection_method": "tld",
  "reasoning": "Domain uses .com TLD with US-focused content"
}
```

### Competitor Fields

| Field | Type | Example |
|-------|------|---------|
| `competitors` | array | See below |
| `competitors_source` | string | `"inferred"` or `"llmo"` |

**Competitor object:**
```json
{
  "name": "Competitor Name",
  "why_competitor": "Offers similar products in same market",
  "source": "llm_inferred",
  "aliases": [],
  "urls": []
}
```

### Persona Fields

| Field | Type | Example |
|-------|------|---------|
| `personas` | array | See below |
| `personas_source` | string | `"llm_inferred"` or `"fallback"` |

**Persona object:**
```json
{
  "name": "First-Time Buyer",
  "role": "Late 20s professional, recently promoted...",
  "needs": ["Reliable product", "Good value", "Easy purchase"],
  "unbranded_angle": ["best product for beginners", "top rated for first time buyers"]
}
```

### Product Fields

| Field | Type | Example |
|-------|------|---------|
| `products` | object | See below |
| `products_metadata` | object | See below |

**Products object:**
```json
{
  "items": [
    {"name": "Product A", "category": "Category", "status": "current", "variants": []}
  ],
  "services": [
    {"name": "Service A", "category": "Professional", "status": "current"}
  ],
  "sub_brands": ["SubBrand A", "SubBrand B"],
  "discontinued": [
    {"name": "Old Product", "status": "discontinued"}
  ]
}
```

**Products metadata object:**
```json
{
  "source": "wikidata",
  "brand_wikidata_id": "Q12345",
  "count": 42,
  "extracted_at": "2026-01-30T15:29:10.209Z"
}
```

## Unchanged Fields (Backward Compatible)

These fields from the base voice analysis remain unchanged:

- `main_profile` - Full voice/tone analysis
- `discovery` - URL structure analysis
- `clustering` - Voice cluster identification
- `competitive_context` - Industry positioning
- `sub_brands` - Sub-brand profiles (may be empty in enhanced mode)
- `confidence_score` - Analysis confidence
- `pages_considered` - Page count
- `diversity_assessment` - Content diversity

## Breaking Change: `sub_brands`

In the OLD schema, `sub_brands` contained detailed profile objects:
```json
{
  "sub_brands": [
    {
      "name": "StealthTech",
      "profile": { /* full voice profile */ },
      "consistency_score": 0.88
    }
  ]
}
```

In the NEW enhanced schema, `sub_brands` may be an empty array when enhancement is enabled, because product extraction uses a different structure:
```json
{
  "sub_brands": [],
  "products": {
    "sub_brands": ["SubBrand A", "SubBrand B"]
  }
}
```

**Impact:** Code that iterates over `sub_brands` expecting detailed profiles should handle empty arrays gracefully.

## Consumer Compatibility Matrix

| Consumer | Uses Fields | Impact |
|----------|-------------|--------|
| spacecat-audit-worker | `main_profile.tone_attributes`, `main_profile.editorial_guidelines`, `main_profile.language_patterns`, `main_profile.brand_personality` | **No impact** - all fields unchanged |
| spacecat-api-service | Passes through entire profile | **No impact** - additive fields |
| project-elmo-ui | Not directly consumed | **No impact** |
| experience-success-studio-ui | Not directly consumed | **No impact** |

## Version Tracking

The profile includes version metadata:

```json
{
  "version": 2,
  "contentHash": "sha256-hash-of-content",
  "updatedAt": "2026-01-30T15:29:12.569Z"
}
```

- `version` auto-increments on each update
- `contentHash` enables change detection (only increments version if content changed)
- `updatedAt` tracks last modification time

## TypeScript Interface

For TypeScript consumers, here's the full interface:

```typescript
interface BrandProfile {
  // Base analysis (unchanged)
  main_profile: MainProfile;
  discovery: Discovery;
  clustering: Clustering;
  competitive_context: CompetitiveContext;
  sub_brands: SubBrand[];
  confidence_score: number;
  pages_considered: number;
  diversity_assessment: string;

  // NEW: Regional context
  country_code?: string;
  region_inference?: {
    country_code: string;
    confidence: 'high' | 'medium' | 'low';
    detection_method: string;
    reasoning: string;
  };
  languages?: string[];
  primary_language?: string;
  currency?: string;
  business_model?: 'B2B' | 'B2C' | 'B2B & B2C';
  regulatory_context?: string;
  key_terminology?: Record<string, string[]>;
  market_specifics?: string;

  // NEW: Competitors
  competitors?: Competitor[];
  competitors_source?: 'llmo' | 'inferred';

  // NEW: Personas
  personas?: Persona[];
  personas_source?: 'llm_inferred' | 'fallback';

  // NEW: Products
  products?: {
    items: Product[];
    services: Product[];
    sub_brands: string[];
    discontinued: Product[];
  };
  products_metadata?: {
    source: string;
    brand_wikidata_id?: string;
    count: number;
    extracted_at: string;
  };

  // Metadata
  version: number;
  contentHash: string;
  updatedAt: string;
}

interface Competitor {
  name: string;
  why_competitor: string;
  source: string;
  aliases: string[];
  urls: string[];
}

interface Persona {
  name: string;
  role: string;
  needs: string | string[];
  unbranded_angle: string | string[];
}

interface Product {
  name: string;
  category?: string;
  status: 'current' | 'discontinued';
  variants?: string[];
}
```

## Migration Notes

### For New Consumers

- All new fields are optional - check for existence before accessing
- Use optional chaining: `profile?.competitors?.length || 0`
- Default to empty arrays for list fields

### For Existing Consumers

- No action required if only using `main_profile` fields
- If using `sub_brands`, ensure code handles empty arrays
- Consider adopting new fields for richer functionality

### Detecting Profile Version

```javascript
// Check if enhanced profile
const isEnhanced = profile.version >= 2
  || profile.competitors !== undefined
  || profile.personas !== undefined;

if (isEnhanced) {
  // Use new fields
  console.log(`Region: ${profile.country_code}`);
  console.log(`Competitors: ${profile.competitors?.length || 0}`);
} else {
  // Legacy profile
  console.log('Legacy profile without enhancements');
}
```
