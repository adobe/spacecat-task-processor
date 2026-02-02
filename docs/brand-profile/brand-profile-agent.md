# Brand Profile Agent

The brand-profile agent generates comprehensive brand voice and market intelligence profiles for websites. It was significantly enhanced in PR #182 to include regional context, competitor inference, persona generation, and product extraction capabilities.

## Overview

The agent operates in two modes:
- **Base mode** (`enhance=false`): Runs only the core voice/brand analysis
- **Enhanced mode** (`enhance=true`, default): Runs the full 6-phase pipeline

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Brand Profile Agent                          │
│                      (index.js)                                 │
├─────────────────────────────────────────────────────────────────┤
│  Phase 1: Base Voice Analysis (system.prompt + user.prompt)     │
│  Phase 2: Region Inference (regional-context.js)                │
│  Phase 3: Regional Context (regional-context.js)                │
│  Phase 4: Competitor Inference (competitor-inference.js)        │
│  Phase 5: Persona Generation (persona-inference.js)             │
│  Phase 6: Product Extraction (product-extractor.js)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                            │
├─────────────────────────────────────────────────────────────────┤
│  • Azure OpenAI (all LLM calls)                                 │
│  • Wikipedia API (brand summaries, full text)                   │
│  • Wikidata SPARQL (product extraction)                         │
│  • Sitemap fetching (product URL extraction)                    │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/agents/brand-profile/
├── index.js                      # Main agent orchestrator
└── services/
    ├── regional-context.js       # Region inference & context
    ├── competitor-inference.js   # Competitor identification
    ├── persona-inference.js      # Customer persona generation
    ├── product-extractor.js      # Product catalogue extraction
    └── wikipedia.js              # Wikipedia/Wikidata client

static/prompts/brand-profile/
├── system.prompt                 # Base voice analysis system prompt
├── user.prompt                   # Base voice analysis user prompt
├── region-from-url.prompt        # URL → country code inference
├── regional-inference.prompt     # Country → regional context
├── competitor-inference.prompt   # Brand → competitors
├── persona-inference.prompt      # Brand → customer personas
├── product-sitemap.prompt        # Sitemap URLs → products
└── product-wikipedia.prompt      # Wikipedia text → products
```

## Invocation

### Via SQS Queue (async)

```json
{
  "type": "agent-executor",
  "agentId": "brand-profile",
  "siteId": "uuid-of-site",
  "context": {
    "baseURL": "https://example.com"
  },
  "slackContext": {
    "channelId": "C12345",
    "threadTs": "1234567890.123456"
  }
}
```

### Via AWS Lambda (direct)

```json
{
  "type": "agent-executor",
  "agentId": "brand-profile",
  "siteId": "uuid-of-site",
  "context": {
    "baseURL": "https://example.com",
    "params": {
      "enhance": true,
      "sitemapUrl": "https://example.com/sitemap.xml",
      "competitors": ["Competitor A", "Competitor B"]
    }
  }
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baseURL` | string | required | Website URL to analyze |
| `params.enhance` | boolean | `true` | Enable enhanced inference (phases 2-6) |
| `params.sitemapUrl` | string | null | Sitemap URL for more accurate product extraction |
| `params.competitors` | string[] | `[]` | Known competitors from LLMO config (skips inference) |

## Output Schema

The enhanced brand profile includes these top-level fields:

### From Base Analysis (Phase 1)
- `main_profile` - Voice/tone analysis with tone_attributes, language_patterns, etc.
- `discovery` - URL structure and content type analysis
- `clustering` - Voice cluster identification
- `competitive_context` - Industry positioning
- `sub_brands` - Detected sub-brand profiles
- `confidence_score` - Overall analysis confidence
- `pages_considered` - Number of pages analyzed
- `diversity_assessment` - Content diversity summary

### From Enhancement (Phases 2-6)
- `country_code` - Inferred 2-letter ISO country code
- `region_inference` - Detection method, confidence, reasoning
- `languages` - Array of language-locale codes (e.g., `["en-US", "es-US"]`)
- `primary_language` - Dominant language
- `currency` - Currency code (e.g., `"USD"`)
- `business_model` - `"B2B"`, `"B2C"`, or `"B2B & B2C"`
- `regulatory_context` - Industry regulations summary
- `key_terminology` - Language-keyed terminology objects
- `market_specifics` - Regional market characteristics
- `competitors` - Array of competitor objects with `name`, `why_competitor`, `source`
- `competitors_source` - `"llmo"` or `"inferred"`
- `personas` - Array of persona objects with `name`, `role`, `needs`, `unbranded_angle`
- `personas_source` - `"llm_inferred"` or `"fallback"`
- `products` - Object with `items`, `services`, `sub_brands`, `discontinued`
- `products_metadata` - Source info, Wikidata ID, extraction timestamp

### Metadata (added by persist)
- `version` - Auto-incremented version number
- `contentHash` - SHA-256 hash for change detection
- `updatedAt` - ISO timestamp

## Services Detail

### Regional Context Service

**File:** `services/regional-context.js`

**Functions:**
- `inferRegionFromUrl(url)` - Analyzes URL for country indicators (TLD, subdomain, path)
- `inferRegionalContext(params)` - Gets languages, terminology, regulations for a country/industry

**Fallback behavior:**
- If LLM fails, uses hardcoded mappings for common countries
- Default currency is EUR for unknown countries
- Default business model is B2C

### Competitor Inference Service

**File:** `services/competitor-inference.js`

**Functions:**
- `inferCompetitors(params)` - Identifies 5-8 competitors using brand context and Wikipedia summary

**Input:**
- `brandName` - Brand to find competitors for
- `industry` - Industry context
- `countryCode` - Target market
- `wikipediaSummary` - Optional company overview for better inference

**Output format:**
```json
{
  "competitors": [
    {
      "name": "Competitor Name",
      "why_competitor": "Reason for competition",
      "source": "llm_inferred",
      "aliases": [],
      "urls": []
    }
  ]
}
```

### Persona Inference Service

**File:** `services/persona-inference.js`

**Functions:**
- `inferPersonas(params)` - Generates 3-5 customer personas

**Output format:**
```json
{
  "personas": [
    {
      "name": "First-Time Buyer",
      "role": "Demographics and situation description",
      "needs": "What they're looking for",
      "unbranded_angle": "search queries without brand names"
    }
  ]
}
```

### Product Extractor Service

**File:** `services/product-extractor.js`

**Extraction priority:**
1. **Sitemap** (if provided) - Most accurate for current products
2. **Wikidata SPARQL** - Structured data, good for established brands
3. **Wikipedia + LLM** - Fallback for brands without Wikidata coverage

**Functions:**
- `extractFromSitemap(sitemapUrl, brandName)` - Parse sitemap URLs and infer products
- `extractProducts(brandName, wikipediaText)` - Use Wikidata/Wikipedia fallback

**Output format:**
```json
{
  "products": [{"name": "...", "category": "...", "status": "current"}],
  "services": [{"name": "...", "category": "...", "status": "current"}],
  "sub_brands": ["Brand A", "Brand B"],
  "discontinued": [{"name": "...", "status": "discontinued"}],
  "metadata": {
    "source": "sitemap|wikidata|wikipedia_llm|hybrid",
    "count": 42,
    "brand_wikidata_id": "Q12345",
    "extracted_at": "2026-01-30T12:00:00Z"
  }
}
```

### Wikipedia Service

**File:** `services/wikipedia.js`

**Functions:**
- `fetchSummary(searchQuery)` - Get Wikipedia intro + Wikidata ID
- `fetchFullText(searchQuery, maxChars)` - Get full article text
- `findWikidataId(brandName)` - Search Wikidata for entity ID

## Prompt Customization

All prompts are externalized in `/static/prompts/brand-profile/`. To modify behavior:

1. Edit the relevant `.prompt` file
2. Prompts use `{{variable}}` syntax for template substitution
3. Test changes by triggering the agent with `enhance=true`

### Prompt Variables

| Prompt | Variables |
|--------|-----------|
| `region-from-url.prompt` | `{{url}}` |
| `regional-inference.prompt` | `{{country_code}}`, `{{industry}}`, `{{brand_name}}`, `{{target_audience}}` |
| `competitor-inference.prompt` | `{{brand_name}}`, `{{industry}}`, `{{country_code}}`, `{{wikipedia_summary}}` |
| `persona-inference.prompt` | `{{brand_name}}`, `{{industry}}`, `{{target_audience}}`, `{{country_code}}`, `{{competitors}}` |
| `product-sitemap.prompt` | `{{brand_name}}`, `{{urls_text}}` |
| `product-wikipedia.prompt` | `{{brand_name}}`, `{{wikipedia_text}}` |

## Error Handling

Each service implements graceful fallbacks:

| Service | Fallback Behavior |
|---------|-------------------|
| Regional Context | Uses country→language/currency mappings |
| Competitor Inference | Returns empty array with error context |
| Persona Inference | Returns generic "General Consumer" persona |
| Product Extractor | Tries sitemap → Wikidata → Wikipedia → empty |

All LLM calls have retry logic (2 retries) for transient failures.

## Persistence

The `persist()` function:
1. Loads the site from DynamoDB
2. Updates brandProfile via `config.updateBrandProfile()`
3. Auto-increments version number
4. Computes content hash for change detection
5. Returns Slack notification blocks for workflow integration

## Testing

Run tests with:
```bash
npm test -- --grep "brand-profile"
```

Key test files:
- `test/agents/brand-profile/index.test.js`
- `test/agents/brand-profile/services/*.test.js`
