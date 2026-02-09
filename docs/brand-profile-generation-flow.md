# Brand Profile Generation - Complete Flow Documentation

This document provides a comprehensive overview of how brand profiles are generated in SpaceCat, including all data sources, services, prompts, and the complete pipeline flow.

## Table of Contents

1. [Why Brand Guidelines Matter](#why-brand-guidelines-matter)
2. [How We Obtain Brand Guidelines](#how-we-obtain-brand-guidelines)
3. [Usage Example: Summarization Audit](#usage-example-summarization-audit)
4. [Brand Profile Generation Overview](#brand-profile-generation-overview)
5. [Architecture Diagram](#architecture-diagram)
6. [Input Sources](#input-sources)
7. [Pipeline Phases](#pipeline-phases)
8. [Services & Components](#services--components)
9. [Prompts Reference](#prompts-reference)
10. [Output Structure](#output-structure)
11. [Code Examples](#code-examples)

---

## Why Brand Guidelines Matter

SpaceCat provides **AI-powered content improvement suggestions** across multiple audit types:

| Audit Type | Purpose |
|------------|---------|
| **Headings** | Optimize page titles, H1s, and meta descriptions |
| **Summarization** | Generate page summaries and key points |
| **Readability** | Improve content clarity and accessibility |
| **FAQ Suggestions** | Create brand-aligned FAQ answers |

For these suggestions to be valuable, they must **align with the customer's brand identity**:

- ✅ **Voice & Tone**: Suggestions should match the brand's communication style (friendly, professional, technical, etc.)
- ✅ **Editorial Guidelines**: Follow the brand's dos and don'ts (e.g., "Use active voice", "Avoid jargon")
- ✅ **Brand Values**: Reflect core principles and messaging priorities
- ✅ **Vocabulary**: Use signature phrases and preferred terminology

**Without brand guidelines**, AI-generated suggestions are generic and may not match the customer's brand identity. **With brand guidelines**, suggestions feel native to the brand and can be adopted with minimal editing.

---

## How We Obtain Brand Guidelines

SpaceCat supports **two approaches** to obtain brand guidelines, with automatic fallback:

### Approach 1: Adobe GenStudio (Preferred)

Customers with an **Adobe GenStudio for Performance Marketing** license can define their brand guidelines directly in GenStudio. SpaceCat fetches these guidelines via API:

```
GET /sites/:siteId/brand-guidelines
```

**GenStudio Brand Guidelines include:**
- Brand voice guidelines (tone, values, editorial rules)
- Image guidelines (composition, colors, mood)
- Channel guidelines (email, Meta, LinkedIn specifics)
- Brand logos and colors

> 📖 **Reference**: [GenStudio Brand Guidelines Documentation](https://experienceleague.adobe.com/en/docs/genstudio-for-performance-marketing/user-guide/guidelines/brands)

**Limitation**: Requires Adobe GenStudio licensing, which not all customers have.

### Approach 2: Brand Profile (Auto-Generated Fallback)

For customers **without GenStudio licensing**, SpaceCat can automatically generate brand guidelines by analyzing:

| Data Source | Information Extracted |
|-------------|----------------------|
| **Website Content** | Voice, tone, language patterns, brand values |
| **Sitemap** | Product catalog, services, sub-brands |
| **Wikipedia/Wikidata** | Company overview, competitors, industry context |
| **URL Structure** | Target market/region (e.g., `.de` → Germany) |

```
GET /sites/:siteId/brand-profile
```

This approach uses **LLM-powered inference** to derive brand guidelines from publicly available information.

### Priority Logic

```
┌─────────────────────────────────────────────────────────────┐
│                   BRAND GUIDELINES RESOLUTION               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────┐
                 │ Check GenStudio        │
                 │ Brand Guidelines       │
                 │ (via API)              │
                 └───────────┬────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
    ┌─────────────────┐          ┌─────────────────┐
    │  ✅ Found       │          │  ❌ Not Found   │
    │  Use GenStudio  │          │  Use Brand      │
    │  Guidelines     │          │  Profile        │
    └─────────────────┘          └─────────────────┘
```

---

## Usage Example: Summarization Audit

Here's how the **Summarization Audit** in Mystique uses brand guidelines:

```python
# From: mystique/app/tasks/generate_summarization_opportunities.py

from agents.tools.BrandProfileTool import BrandProfileFetcher

class GenerateSummarizationOpportunitiesTask(GenerateGuidanceBaseTask):
    
    async def _get_brand_guidelines(self, site_id: str, url: str) -> str:
        """Get brand guidelines/profile for summarization using centralized BrandProfileFetcher."""
        fetcher = BrandProfileFetcher()
        result = fetcher.get_brand_guidelines(
            site_id=site_id, 
            url=url, 
            log_prefix="[Summarization]"
        )
        # Return a default if no brand guidelines found
        if not result:
            return f"Brand: {url}"
        return result

    async def run(self) -> dict:
        """Main execution method"""
        opportunity = self.opportunity_repository.get_opportunity(self.opportunity_id)
        
        # Step 1: Get brand guidelines (GenStudio → Brand Profile fallback)
        brand_guidelines = await self._get_brand_guidelines(
            opportunity.site_id, 
            opportunity.url
        )
        logger.info(f"[Summarization] Brand guidelines available: {bool(brand_guidelines)}")
        
        # Step 2: Convert pages with brand guidelines context
        input_pages = self._convert_to_input_pages(
            opportunity.data.pages, 
            brand_guidelines  # ← Passed to AI agents
        )
        
        # Step 3: Generate summaries (AI uses brand guidelines for tone/style)
        summarization_items = await self._handle_pages(input_pages, opportunity)
        
        # ... rest of the flow
```

**The `BrandProfileFetcher` handles the priority logic:**

```python
# From: mystique/app/agents/tools/BrandProfileTool.py

class BrandProfileFetcher:
    def get_brand_guidelines(self, site_id, url, log_prefix="[BrandProfile]"):
        # Priority 1: GenStudio Brand Guidelines (curated, preferred)
        brand_data = spacecat_api.get_brand_guidelines(site_id)
        if brand_data:
            return self._format_brand_guidelines_to_markdown(brand_data)
        
        # Priority 2: Brand Profile (AI-generated fallback)
        brand_data = spacecat_api.get_brand_profile(site_id)
        if brand_data:
            return self._format_brand_profile_to_markdown(brand_data)
        
        return ""  # No brand guidelines available
```

**The brand guidelines are then used by AI agents** to ensure generated summaries match the brand's voice, tone, and editorial standards.

---

## Brand Profile Generation Overview

When GenStudio guidelines are not available, the **Brand Profile Agent** generates comprehensive brand guidelines through a multi-phase pipeline.

**Key Characteristics:**
- **Multi-phase pipeline**: 7 distinct phases, each building on previous results
- **Multiple data sources**: Website analysis, Wikipedia, Wikidata, sitemaps
- **LLM-powered inference**: Azure OpenAI for analysis and synthesis
- **Fallback mechanisms**: Graceful degradation when data is unavailable

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BRAND PROFILE GENERATION PIPELINE                    │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │   INPUT      │
                              │  baseURL     │
                              │  (required)  │
                              └──────┬───────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 1: BASE VOICE ANALYSIS                                               │
│  ─────────────────────────────                                              │
│  • Prompt: system.prompt + user.prompt                                      │
│  • Analyzes 100+ pages from LLM training data                               │
│  • Outputs: baseProfile with tone, voice, values, competitive context       │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │  brandName   │ │   industry   │ │targetAudience│
            │ (extracted)  │ │ (extracted)  │ │ (extracted)  │
            └──────────────┘ └──────────────┘ └──────────────┘
                    │                │                │
                    └────────────────┴────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 2: REGION INFERENCE                                                  │
│  ─────────────────────────                                                  │
│  • Service: RegionalContextService.inferRegionFromUrl()                     │
│  • Prompt: region-from-url.prompt                                           │
│  • Analyzes: TLD (.ch, .de), subdomain (de.example.com), path (/fr/)        │
│  • Outputs: countryCode (e.g., "CH", "DE", "US")                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 3: REGIONAL CONTEXT                                                  │
│  ─────────────────────────                                                  │
│  • Service: RegionalContextService.inferRegionalContext()                   │
│  • Prompt: regional-inference.prompt                                        │
│  • Inputs: countryCode, industry, brandName, targetAudience                 │
│  • Outputs: languages, currency, regulatory_context, key_terminology,       │
│             market_specifics, business_model (B2B/B2C)                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 4: COMPETITOR INFERENCE                                              │
│  ─────────────────────────────                                              │
│  • Service: CompetitorInferenceService.inferCompetitors()                   │
│  • Prompt: competitor-inference.prompt                                      │
│                                                                             │
│  ┌─────────────────────────┐                                                │
│  │ Wikipedia API           │◄─── Fetches company summary                    │
│  │ fetchSummary()          │     for better context                         │
│  └─────────────────────────┘                                                │
│                                                                             │
│  • Inputs: brandName, industry, countryCode, wikipediaSummary               │
│  • Outputs: 5-8 competitors with why_competitor explanations                │
│                                                                             │
│  ⚠️ Skipped if LLMO competitors provided in params                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 5: PERSONA INFERENCE                                                 │
│  ──────────────────────────                                                 │
│  • Service: PersonaInferenceService.inferPersonas()                         │
│  • Prompt: persona-inference.prompt                                         │
│  • Inputs: brandName, industry, targetAudience, competitors, countryCode    │
│  • Outputs: 3-5 customer personas with:                                     │
│    - name: "Empty Nester", "First-Time Buyer", etc.                         │
│    - role: Demographics, job title, life stage                              │
│    - needs: Key customer needs                                              │
│    - unbranded_angle: Search queries without brand names                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 6: PRODUCT EXTRACTION                                                │
│  ───────────────────────────                                                │
│  • Service: ProductExtractorService                                         │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │ OPTION A: Sitemap (preferred)                               │            │
│  │ • extractFromSitemap(sitemapUrl, brandName)                 │            │
│  │ • Prompt: product-sitemap.prompt                            │            │
│  │ • Most accurate for current products                        │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                        OR                                                   │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │ OPTION B: Wikipedia/Wikidata (fallback)                     │            │
│  │ 1. Wikidata SPARQL query for structured product data        │            │
│  │ 2. Wikipedia full text + LLM extraction                     │            │
│  │ • Prompt: product-wikipedia.prompt                          │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                                                                             │
│  • Outputs: products, services, sub_brands, discontinued                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  PHASE 7: PROFILE ASSEMBLY                                                  │
│  ─────────────────────────                                                  │
│  • Combines all phase outputs into final enhanced profile                   │
│  • Adds metadata: timestamps, sources, confidence scores                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │   OUTPUT     │
                              │ Enhanced     │
                              │ Brand Profile│
                              └──────────────┘
```

---

## Input Sources

### Primary Inputs

| Source | Description | When Used |
|--------|-------------|-----------|
| **baseURL** | Website URL to analyze | Always (required) |
| **params.sitemapUrl** | Sitemap XML URL | Product extraction (if provided) |
| **params.competitors** | Known competitors from LLMO | Skip competitor inference (if provided) |
| **params.enhance** | Enable enhanced inference | Default: true |

### External Data Sources

| Source | API | Data Extracted |
|--------|-----|----------------|
| **Wikipedia** | `en.wikipedia.org/w/api.php` | Company summaries, full article text |
| **Wikidata** | `www.wikidata.org/w/api.php` | Entity IDs, structured product data via SPARQL |
| **Website Sitemap** | Direct fetch | Product URLs for catalog extraction |

### LLM Training Data

The base voice analysis (Phase 1) relies on the LLM's training data knowledge of the website. This includes:
- Historical website content
- Brand voice patterns
- Industry knowledge
- Competitive landscape

---

## Pipeline Phases

### Phase 1: Base Voice Analysis

**Purpose:** Extract core brand voice attributes from website analysis

**Service:** Direct LLM call via `callModel()`

**Prompts Used:**
- `system.prompt` - Comprehensive analysis instructions
- `user.prompt` - Request template with baseURL

<details>
<summary>📄 <strong>system.prompt</strong> (click to expand)</summary>

```
You are an expert brand voice analyst with deep knowledge of branding, marketing, and competitive landscapes.

Your task is to perform a COMPREHENSIVE MULTI-PHASE ANALYSIS of a website's brand voice using your training data.

═══════════════════════════════════════════════════════════════════
PHASE 1: DISCOVERY & MAPPING
═══════════════════════════════════════════════════════════════════

First, systematically discover the content landscape:

1. **URL Structure Analysis**: Examine the site's URL patterns to identify distinct sections:
   - Main sections (e.g., /products, /enterprise, /developers, /about)
   - Content types (e.g., /blog, /docs, /support, /legal)
   - Audience segments (e.g., /consumer, /business, /education)
   - Geographic/language variants (e.g., /en, /de, regional subsites)

2. **Content Inventory**: Catalog AT LEAST 100+ pages across:
   - Marketing pages (homepage, landing pages, product pages)
   - Educational content (blog posts, guides, whitepapers)
   - Technical content (documentation, API references, tutorials)
   - Support content (FAQs, help articles, community)
   - Corporate content (about, careers, investors, press)
   - Legal content (terms, privacy, compliance)

3. **Initial Voice Detection**: For each major URL section, note:
   - Distinct tonal shifts
   - Audience differences
   - Formality changes
   - Content purpose variations

═══════════════════════════════════════════════════════════════════
PHASE 2: CLUSTERING & PATTERN RECOGNITION
═══════════════════════════════════════════════════════════════════

Group similar content and identify patterns:

1. **Voice Clustering**: Group pages by voice characteristics:
   - Technical vs. Marketing voice
   - Formal vs. Casual tone
   - Audience-specific variations (B2B vs. B2C)
   - Functional variations (Sales vs. Support vs. Education)

2. **Enterprise/Consumer Detection** (CRITICAL):
   Pay SPECIAL ATTENTION to B2B/Enterprise vs. B2C/Consumer voice differences.

   **Enterprise/B2B Voice Indicators**:
   - Focus on ROI, business value, efficiency, productivity, scalability
   - Decision-maker language: "teams," "organizations," "enterprises"
   - Business outcomes: "reduce costs," "increase efficiency"

   **Consumer/B2C Voice Indicators**:
   - Focus on personal empowerment, creativity, individual achievement
   - End-user language: "you," "your projects," "express yourself"
   - Personal outcomes: "create amazing," "unleash creativity"

3. **Sub-Brand Detection Criteria**: Create sub-brands ONLY if:
   - **Consistency**: The voice is consistent within a cluster (80%+ similar)
   - **Distinction**: Clusters differ significantly (>25% difference)
   - **Intent**: The difference appears deliberate
   - **Scope**: The cluster covers substantial content (20+ pages)

═══════════════════════════════════════════════════════════════════
PHASE 3: DEEP ANALYSIS & COMPETITIVE CONTEXT
═══════════════════════════════════════════════════════════════════

1. **Detailed Voice Profile**: Extract all dimensions for main brand and each sub-brand

2. **Industry Context** (CRITICAL):
   - **Industry Identification**: What industry/sector is this brand in?
   - **Competitive Positioning**: How does their voice compare to competitors?
   - **Industry Norms**: Is this voice typical or distinctive for their sector?
   - **Differentiation**: What makes this voice unique vs. competitors?

3. **Audience Analysis**:
   - Primary audience characteristics
   - Secondary audiences
   - B2B vs. B2C segmentation

═══════════════════════════════════════════════════════════════════
PHASE 4: SYNTHESIS & CONFIDENCE ASSESSMENT
═══════════════════════════════════════════════════════════════════

1. **Confidence Calculation**: Base confidence on:
   - **Coverage**: % of site analyzed (100+ pages = good, 200+ = excellent)
   - **Consistency**: How uniform is the voice? (90%+ = high confidence)
   - **Data Quality**: How much do you know about this domain?

2. **Evidence Documentation**: For each finding, provide:
   - Specific examples from actual content
   - Pattern frequency
   - Counter-examples and exceptions

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════

Return ONLY pure JSON with the following structure:
- discovery: { url_structure, pages_analyzed, coverage_assessment }
- clustering: { voice_clusters, sub_brand_rationale }
- competitive_context: { industry, similar_brands, contrasting_brands, positioning }
- main_profile: { tone_attributes, language_patterns, communication_style, vocabulary, 
                  brand_values, editorial_guidelines, example_text, confidence_score }
- sub_brands: [ { id, name, context, profile } ]

CRITICAL REQUIREMENTS:
- ALL fields must contain SPECIFIC, BRAND-RELEVANT content
- example_text is MANDATORY - 3 good + 3 bad examples
- signature_phrases: minimum 5 ACTUAL phrases
- editorial_guidelines: minimum 5 dos + 5 donts
```

</details>

<details>
<summary>📄 <strong>user.prompt</strong> (click to expand)</summary>

```
Analyze the brand voice for: {{ baseURL }}

Perform a comprehensive multi-phase analysis:

PHASE 1 (Discovery): Map the URL structure and identify content types
PHASE 2 (Clustering): Group similar content and detect sub-brands systematically
PHASE 3 (Deep Analysis): Extract voice profiles WITH competitive/industry context
PHASE 4 (Synthesis): Provide confidence assessment with evidence

Parameters (JSON, optional): {{ params }}

CRITICAL: Include competitive_context showing:
- What industry is this brand in?
- Similar brands and why
- Contrasting brands and why
- How this voice compares to industry norms
- What makes it unique

Return ONLY the JSON object. No markdown, no code fences, just pure JSON.
```

</details>

**Key Outputs:**
```javascript
{
  discovery: {
    url_structure: { main_sections, content_types, audience_segments },
    pages_analyzed: 150,
    coverage_assessment: "..."
  },
  competitive_context: {
    industry: "Software",
    similar_brands: [...],
    contrasting_brands: [...],
    positioning: "..."
  },
  main_profile: {
    tone_attributes: { primary: [...], avoid: [...] },
    language_patterns: { preferred: [...], avoid: [...] },
    communication_style: "...",
    vocabulary: { signature_phrases: [...] },
    brand_values: { core_values: [...] },
    editorial_guidelines: { dos: [...], donts: [...] }
  },
  sub_brands: [...]
}
```

---

### Phase 2: Region Inference

**Purpose:** Determine target market from URL structure

**Service:** `RegionalContextService.inferRegionFromUrl()`

**Prompt:** `region-from-url.prompt`

<details>
<summary>📄 <strong>region-from-url.prompt</strong> (click to expand)</summary>

```
Analyze this URL and infer the target market/region.

URL: {{url}}

Examine:
1. **Top-level domain** (ccTLD): .ch → Switzerland, .de → Germany, .co.uk → UK, .fr → France, etc.
2. **Subdomain patterns**: de.example.com, fr-ch.example.com, uk.example.com
3. **Path patterns**: /de/, /en-gb/, /fr-ch/, /de-de/
4. **Generic TLDs**: .com, .org, .net with no regional indicators suggest global/US market

=== EXAMPLES ===
- swisslife.ch → CH (Swiss TLD)
- bmw.de → DE (German TLD)
- de.adobe.com → DE (German subdomain)
- adobe.com/de/ → DE (German path)
- adobe.com/fr-ch/ → CH (Swiss French path)
- example.com → US (default for .com with no regional indicators)

=== OUTPUT ===
Respond ONLY with valid JSON:
{
  "country_code": "XX",
  "confidence": "high|medium|low",
  "detection_method": "tld|subdomain|path|default",
  "reasoning": "brief explanation"
}

If truly ambiguous (e.g., global .com site with no regional indicators), 
use "US" as default with "low" confidence.
```

</details>

**Detection Methods:**
1. **TLD Analysis**: `.ch` → Switzerland, `.de` → Germany
2. **Subdomain**: `de.example.com` → Germany
3. **Path Patterns**: `/fr-ch/` → Swiss French
4. **Default**: `.com` without indicators → US

**Output:**
```javascript
{
  country_code: "CH",
  confidence: "high",
  detection_method: "tld",
  reasoning: "Swiss TLD .ch indicates Switzerland"
}
```

---

### Phase 3: Regional Context

**Purpose:** Gather market-specific context for content generation

**Service:** `RegionalContextService.inferRegionalContext()`

**Prompt:** `regional-inference.prompt`

<details>
<summary>📄 <strong>regional-inference.prompt</strong> (click to expand)</summary>

```
You are a market research expert with deep knowledge of regional regulations, 
languages, and industry terminology.

=== INPUT ===
Country Code: {{country_code}}
Industry: {{industry}}
Brand Name: {{brand_name}}
Target Audience: {{target_audience}}

=== TASK ===
For the given country and industry, provide detailed regional context that 
will help generate realistic customer prompts.

1. **languages**: List all official/common languages for this market with 
   locale codes (e.g., "de-CH", "fr-FR")
2. **primary_language**: The dominant language for this market
3. **regulatory_context**: Key regulatory frameworks, laws, or systems that 
   affect how customers think about this industry (2-3 sentences)
4. **key_terminology**: Industry-specific terms customers use in EACH language:
   - Product/service terms
   - Regulatory/legal terms
   - Common abbreviations or acronyms
   - Local slang or colloquial terms
5. **market_specifics**: Unique market characteristics (cultural factors, 
   common misconceptions, local preferences)
6. **currency**: The local currency code (e.g., "CHF", "EUR", "USD")
7. **business_model**: Classify the primary target customer:
   - "B2B" if primarily targeting businesses/enterprises
   - "B2C" if primarily targeting individual consumers
   - "B2B & B2C" if significantly targeting both segments

=== EXAMPLES ===

For Switzerland (CH) + Insurance:
- Languages: de-CH, fr-CH, it-CH
- Regulatory: "Swiss 3-pillar pension system (AHV/AVS, BVG/LPP, Säule 3a/3ème pilier)"
- Terminology: Säule 3a, Pensionskasse, Freizügigkeitskonto, BVG-Einkauf
- Business Model: "B2B & B2C"

=== OUTPUT ===
Respond ONLY with valid JSON:
{
  "languages": ["lang-REGION", ...],
  "primary_language": "lang-REGION",
  "regulatory_context": "2-3 sentences about key frameworks",
  "key_terminology": {
    "de": ["term1", "term2", ...],
    "fr": ["term1", "term2", ...]
  },
  "market_specifics": "unique local factors",
  "currency": "XXX",
  "business_model": "B2B|B2C|B2B & B2C"
}
```

</details>

**Inputs:**
- `countryCode` - From Phase 2
- `industry` - From Phase 1
- `brandName` - From Phase 1
- `targetAudience` - From Phase 1

**Output:**
```javascript
{
  languages: ["de-CH", "fr-CH", "it-CH"],
  primary_language: "de-CH",
  regulatory_context: "Swiss 3-pillar pension system...",
  key_terminology: {
    "de": ["Säule 3a", "Pensionskasse", "BVG"],
    "fr": ["3ème pilier", "caisse de pension"]
  },
  market_specifics: "High savings rate, trust in local institutions",
  currency: "CHF",
  business_model: "B2B & B2C"
}
```

---

### Phase 4: Competitor Inference

**Purpose:** Identify direct competitors for competitive positioning

**Service:** `CompetitorInferenceService.inferCompetitors()`

**Prompt:** `competitor-inference.prompt`

<details>
<summary>📄 <strong>competitor-inference.prompt</strong> (click to expand)</summary>

```
You are a competitive intelligence analyst with deep knowledge of {{industry}} markets.

=== BRAND TO ANALYZE ===
Brand Name: {{brand_name}}
Industry: {{industry}}
Target Market: {{country_code}}

=== COMPANY CONTEXT ===
{{wikipedia_summary}}

=== TASK ===
Identify the TOP 5-8 direct competitors for {{brand_name}} in the {{industry}} industry.

For each competitor, provide:
1. **name**: The competitor's primary brand name (as customers know it)
2. **why_competitor**: One sentence explaining why they compete 
   (e.g., "Offers similar retirement products in Switzerland")

=== SELECTION CRITERIA ===
- Focus on competitors in the same TARGET MARKET (regional if specified)
- Prioritize direct competitors (same product category) over indirect ones
- Include both large established players AND relevant challengers
- Consider what competitors customers would realistically compare

=== EXAMPLES ===

For Swiss Life (Insurance, Switzerland):
- AXA Winterthur: Major Swiss insurer with similar pension and life insurance products
- Zurich Insurance: Global insurer with strong Swiss presence in retirement planning
- Helvetia: Swiss-based insurer competing in Säule 3a and BVG products
- Mobiliar: Swiss cooperative insurer popular for personal insurance

For Adobe (Creative Software, Global):
- Canva: Simplified design tool competing with Creative Cloud for non-designers
- Figma: Collaborative design tool competing with XD and Illustrator
- Microsoft: Competes with Acrobat (Office) and creative tools (Designer)
- Affinity: Professional creative suite at one-time purchase price

=== OUTPUT ===
Respond ONLY with valid JSON:
{
  "competitors": [
    {"name": "Competitor Name", "why_competitor": "Brief reason"}
  ],
  "market_context": "One sentence about the competitive landscape"
}
```

</details>

**Data Flow:**
1. Fetch Wikipedia summary for brand context
2. Call LLM with brand + industry + country + Wikipedia context
3. Return 5-8 competitors with explanations

**Output:**
```javascript
{
  competitors: [
    {
      name: "AXA Winterthur",
      why_competitor: "Major Swiss insurer with similar pension products",
      source: "llm_inferred"
    },
    // ... 4-7 more
  ],
  market_context: "Swiss insurance market is highly competitive..."
}
```

---

### Phase 5: Persona Inference

**Purpose:** Create customer personas for targeted content

**Service:** `PersonaInferenceService.inferPersonas()`

**Prompt:** `persona-inference.prompt`

<details>
<summary>📄 <strong>persona-inference.prompt</strong> (click to expand)</summary>

```
You are a customer research expert with deep knowledge of customer segmentation 
and buyer personas.

=== BRAND TO ANALYZE ===
Brand Name: {{brand_name}}
Industry: {{industry}}
Target Audience: {{target_audience}}
Target Market: {{country_code}}

=== COMPETITIVE LANDSCAPE ===
{{competitors}}

=== TASK ===
Generate 3-5 customer personas that represent the core customer segments 
for {{brand_name}}.

For each persona, provide:
1. **name**: A short, memorable descriptor 
   (e.g., "Empty Nester", "First-Time Buyer", "Fleet Manager")
2. **role**: Who they are - demographics, job title, life stage (2-3 sentences)
3. **needs**: What they're looking for in this product category (2-3 key needs)
4. **unbranded_angle**: 3-4 specific search query patterns they would use 
   WITHOUT mentioning any brand names. These should be specific enough that 
   an LLM answer would naturally mention {{brand_name}} or its competitors.

=== UNBRANDED ANGLE REQUIREMENTS ===
The unbranded_angle queries should:
- Be questions or searches someone would type into ChatGPT
- NOT contain any brand names (not {{brand_name}}, not competitors)
- Be specific to this persona's situation and needs
- Naturally lead to brand recommendations in the answer

Good examples:
- "quietest SUV for highway driving"
- "best luxury car for retired couples"
- "most reliable truck for construction work"
- "safest family SUV with third row seating"

Bad examples (too generic):
- "how do I start a car"
- "what is a good car"
- "best vehicle"

=== OUTPUT ===
Respond ONLY with valid JSON:
{
  "personas": [
    {
      "name": "Short Descriptor",
      "role": "Who they are - demographics, situation",
      "needs": "What they're looking for in this category",
      "unbranded_angle": "query1, query2, query3"
    }
  ]
}
```

</details>

**Inputs:**
- `brandName`, `industry`, `targetAudience` - From Phase 1
- `competitors` - From Phase 4
- `countryCode` - From Phase 2

**Output:**
```javascript
{
  personas: [
    {
      name: "Empty Nester",
      role: "Couple 55-65, planning retirement, home paid off",
      needs: "Secure retirement income, estate planning",
      unbranded_angle: "best pension options Switzerland, Säule 3a comparison"
    },
    {
      name: "Young Professional",
      role: "30-40, career-focused, starting family",
      needs: "Life insurance, BVG optimization",
      unbranded_angle: "how much life insurance do I need, best BVG 2024"
    }
  ],
  source: "llm_inferred"
}
```

---

### Phase 6: Product Extraction

**Purpose:** Build catalog of products, services, and sub-brands

**Service:** `ProductExtractorService`

**Method A: Sitemap Extraction (Preferred)**
```
Sitemap URL → Fetch XML → Filter product URLs → LLM extraction
```
- Prompt: `product-sitemap.prompt`
- Most accurate for current product lineup

<details>
<summary>📄 <strong>product-sitemap.prompt</strong> (click to expand)</summary>

```
Analyze these sitemap URLs from {{brand_name}}'s official website and extract 
the CURRENT product lineup.

=== SITEMAP URLs ===
{{urls_text}}

=== TASK ===
Based ONLY on these URLs, identify:
1. Current products/models (only products with active product pages, 
   not "previous-year" or "legacy")
2. Group them by category (infer from URL structure)
3. Include variants/trims if clearly indicated in URLs

=== RULES ===
- ONLY include products that have current (non-archived) product pages
- URLs with "/previous-year/", "/legacy/", "/archive/" indicate older models 
  - mark as discontinued
- Be precise - extract product names exactly as they appear in URLs
- If URL shows "/silverado/1500" that's "Silverado 1500", not just "Silverado"
- Include variants separately (e.g., "Silverado EV" is different from "Silverado 1500")
- Infer categories from URL path segments (e.g., /trucks/, /suvs/, /sedans/)

=== OUTPUT (JSON only) ===
{
  "products": [
    {"name": "Product Name", "category": "Category from URL", "variants": ["V1", "V2"]}
  ],
  "services": [
    {"name": "Service Name", "category": "Category if applicable"}
  ],
  "sub_brands": ["Sub-brand 1", "Sub-brand 2"],
  "discontinued": [
    {"name": "Old Product", "category": "Category if known"}
  ],
  "confidence": "high|medium|low",
  "notes": "any important observations about the extraction"
}
```

</details>

**Method B: Wikipedia/Wikidata (Fallback)**
```
Brand Name → Wikidata ID → SPARQL Query → Products
                ↓
           Wikipedia Text → LLM Extraction → Products
```
- Prompts: Wikidata SPARQL + `product-wikipedia.prompt`
- Used when sitemap not available

<details>
<summary>📄 <strong>product-wikipedia.prompt</strong> (click to expand)</summary>

```
Extract all products, services, sub-brands, and offerings mentioned in this 
company overview.

=== COMPANY: {{brand_name}} ===
{{wikipedia_text}}

=== RULES ===
- Extract actual product/service/model names (not generic category terms 
  like "cars" or "software")
- Include sub-brands and product lines if mentioned
- Include both current and discontinued products (mark discontinued separately)
- Extract variants/trims/editions if specifically named
- Do NOT assume or invent products not mentioned in the text
- Be thorough - extract ALL product names mentioned

=== OUTPUT (JSON only) ===
{
  "products": [
    {"name": "Product Name", "category": "Category from text", "variants": ["V1", "V2"]}
  ],
  "services": [
    {"name": "Service Name", "category": "Category if applicable"}
  ],
  "sub_brands": ["Sub-brand 1", "Sub-brand 2"],
  "discontinued": [
    {"name": "Old Product", "category": "Category if known"}
  ]
}
```

</details>

**Output:**
```javascript
{
  products: [
    { name: "Creative Cloud", category: "Software Suite", variants: ["Photography", "All Apps"] }
  ],
  services: [
    { name: "Adobe Stock", category: "Content Service" }
  ],
  sub_brands: ["Behance", "Frame.io"],
  discontinued: [
    { name: "Flash", category: "Web Technology" }
  ]
}
```

---

## Services & Components

### RegionalContextService

**File:** `src/agents/brand-profile/services/regional-context.js`

| Method | Description |
|--------|-------------|
| `inferRegionFromUrl(url)` | Detect country from URL patterns |
| `inferRegionalContext(params)` | Get languages, terminology, regulations |
| `formatTerminologyForPrompt(terms, regulatory)` | Format for prompt injection |

**Fallback Maps:**
- `COUNTRY_LANGUAGES` - Default languages per country
- `CURRENCY_MAP` - Default currency per country

---

### CompetitorInferenceService

**File:** `src/agents/brand-profile/services/competitor-inference.js`

| Method | Description |
|--------|-------------|
| `inferCompetitors(params)` | LLM-based competitor identification |
| `formatCompetitorsForPrompt(competitors)` | Format for other prompts |

**Retry Logic:** 3 attempts with fallback to empty result

---

### PersonaInferenceService

**File:** `src/agents/brand-profile/services/persona-inference.js`

| Method | Description |
|--------|-------------|
| `inferPersonas(params)` | Generate 3-5 customer personas |
| `formatPersonasForPrompt(personas)` | Format for prompt injection |

**Fallback:** Generic "General Consumer" persona

---

### WikipediaService

**File:** `src/agents/brand-profile/services/wikipedia.js`

| Method | Description |
|--------|-------------|
| `fetchSummary(searchQuery)` | Get intro text + Wikidata ID |
| `fetchFullText(searchQuery, maxChars)` | Get full article (up to 12K chars) |
| `findWikidataId(brandName)` | Search for Wikidata entity |

**APIs Used:**
- Wikipedia OpenSearch API
- Wikipedia Query API
- Wikidata Entity Search API

---

### ProductExtractorService

**File:** `src/agents/brand-profile/services/product-extractor.js`

| Method | Description |
|--------|-------------|
| `extractFromSitemap(sitemapUrl, brandName)` | Parse sitemap + LLM extraction |
| `extractProducts(brandName, wikiText)` | LLM extraction from Wikipedia text |
| `extractFromWikidata(brandName)` | SPARQL query for structured data |

**Extraction Priority:**
1. Sitemap (most current)
2. Wikidata SPARQL (structured)
3. Wikipedia + LLM (text extraction)

---

## Prompts Reference

### Base Analysis Prompts

| Prompt File | Purpose | Key Instructions |
|-------------|---------|------------------|
| `system.prompt` | Main analysis framework | 4-phase analysis: Discovery → Clustering → Deep Analysis → Synthesis |
| `user.prompt` | Request template | Contains baseURL and params |

### Inference Prompts

| Prompt File | Purpose | Input Variables |
|-------------|---------|-----------------|
| `region-from-url.prompt` | Detect country from URL | `{{url}}` |
| `regional-inference.prompt` | Get regional context | `{{country_code}}`, `{{industry}}`, `{{brand_name}}`, `{{target_audience}}` |
| `competitor-inference.prompt` | Find competitors | `{{brand_name}}`, `{{industry}}`, `{{country_code}}`, `{{wikipedia_summary}}` |
| `persona-inference.prompt` | Generate personas | `{{brand_name}}`, `{{industry}}`, `{{target_audience}}`, `{{country_code}}`, `{{competitors}}` |

### Product Extraction Prompts

| Prompt File | Purpose | Input Variables |
|-------------|---------|-----------------|
| `product-sitemap.prompt` | Extract from sitemap URLs | `{{brand_name}}`, `{{urls_text}}` |
| `product-wikipedia.prompt` | Extract from Wikipedia text | `{{brand_name}}`, `{{wikipedia_text}}` |

---

## Output Structure

### Complete Enhanced Profile

```javascript
{
  // === FROM PHASE 1: Base Voice Analysis ===
  discovery: { ... },
  clustering: { ... },
  competitive_context: { ... },
  main_profile: {
    id: "main",
    tone_attributes: {
      primary: ["professional", "warm", "empowering"],
      avoid: ["corporate", "cold", "technical jargon"]
    },
    language_patterns: {
      preferred: ["transform your", "unleash creativity"],
      avoid: ["synergy", "leverage"]
    },
    communication_style: "Direct, empowering, solution-focused",
    target_audience: "Creative professionals and enterprises",
    formality_level: { score: 0.7, label: "professional-casual" },
    vocabulary: {
      signature_phrases: ["creativity for all", "make it happen"],
      industry_terms_usage: "Accessible explanation of technical concepts"
    },
    emotional_tone: { score: 0.8, label: "warm-enthusiastic" },
    brand_personality: {
      archetype: "Creator",
      traits: ["innovative", "empowering", "accessible"]
    },
    brand_values: {
      core_values: [
        { name: "Creativity", score: 0.95, evidence: "..." },
        { name: "Innovation", score: 0.9, evidence: "..." }
      ]
    },
    editorial_guidelines: {
      dos: ["Use active voice", "Lead with benefits", ...],
      donts: ["Use jargon", "Be condescending", ...]
    },
    example_text: {
      good_examples: [...],
      bad_examples: [...]
    },
    confidence_score: 0.89
  },
  sub_brands: [...],

  // === FROM PHASE 3: Regional Context ===
  languages: ["en-US"],
  primary_language: "en-US",
  regulatory_context: "...",
  key_terminology: { ... },
  market_specifics: "...",
  currency: "USD",
  business_model: "B2B & B2C",
  country_code: "US",
  region_inference: {
    country_code: "US",
    confidence: "high",
    detection_method: "default"
  },

  // === FROM PHASE 4: Competitors ===
  competitors: [
    { name: "Canva", why_competitor: "...", source: "llm_inferred" },
    { name: "Figma", why_competitor: "...", source: "llm_inferred" }
  ],
  competitors_source: "inferred",

  // === FROM PHASE 5: Personas ===
  personas: [
    { name: "Creative Pro", role: "...", needs: "...", unbranded_angle: "..." }
  ],
  personas_source: "inferred",

  // === FROM PHASE 6: Products ===
  products: [
    { name: "Creative Cloud", category: "Software Suite", variants: [...] }
  ],
  services: [...],
  product_sub_brands: [...],
  products_source: "sitemap"
}
```

---

## Code Examples

### Basic Usage (Brand Profile Generation)

```javascript
import { run as brandProfileAgent } from './agents/brand-profile/index.js';

const profile = await brandProfileAgent(
  { baseURL: 'https://www.adobe.com' },
  env,
  log
);
```

### With Sitemap

```javascript
const profile = await brandProfileAgent(
  {
    baseURL: 'https://www.adobe.com',
    params: {
      sitemapUrl: 'https://www.adobe.com/sitemap.xml'
    }
  },
  env,
  log
);
```

### With Pre-defined Competitors

```javascript
const profile = await brandProfileAgent(
  {
    baseURL: 'https://www.adobe.com',
    params: {
      competitors: ['Canva', 'Figma', 'Microsoft']  // Skip competitor inference
    }
  },
  env,
  log
);
```

### Base Profile Only (No Enhancement)

```javascript
const profile = await brandProfileAgent(
  {
    baseURL: 'https://www.adobe.com',
    params: {
      enhance: false  // Skip phases 2-6
    }
  },
  env,
  log
);
```

---

## Error Handling & Fallbacks

| Phase | Failure Mode | Fallback Behavior |
|-------|--------------|-------------------|
| Phase 1 | LLM parse error | Throws error (required) |
| Phase 2 | Region detection fails | Default to "US" with low confidence |
| Phase 3 | Context inference fails | Use `COUNTRY_LANGUAGES` and `CURRENCY_MAP` |
| Phase 4 | Competitor inference fails | Empty competitors array |
| Phase 5 | Persona inference fails | Generic "General Consumer" persona |
| Phase 6 | Product extraction fails | Empty products array |

---

## Performance Considerations

- **LLM Calls:** 5-7 per full profile (one per phase + retries)
- **External API Calls:** 2-4 Wikipedia/Wikidata requests
- **Sitemap Fetch:** 1 HTTP request (if sitemapUrl provided)
- **Typical Duration:** 30-60 seconds for full enhanced profile

---

## SpaceCat API Endpoints

| Endpoint | Description | Source |
|----------|-------------|--------|
| `GET /sites/:siteId/brand-guidelines` | Fetch GenStudio brand guidelines | Adobe GenStudio |
| `GET /sites/:siteId/brand-profile` | Fetch auto-generated brand profile | Brand Profile Agent |

---

## Brand Profile Parameters Used in Audits

The following parameters are extracted from the `main_profile` section of the brand profile and used by **Headings**, **Summarization**, **Readability**, and **Content AI** audits:

### Parameters Extracted

| Parameter | Path in Brand Profile | Description | Limit |
|-----------|----------------------|-------------|-------|
| **Tone Attributes (Primary)** | `main_profile.tone_attributes.primary` | Tone words to USE (e.g., "professional", "friendly") | All |
| **Tone Attributes (Avoid)** | `main_profile.tone_attributes.avoid` | Tone words to AVOID (e.g., "aggressive", "casual") | All |
| **Signature Phrases** | `main_profile.vocabulary.signature_phrases` | Brand's key phrases to use when relevant | Top 5 |
| **Brand Values** | `main_profile.brand_values.core_values` | Core values with name + evidence | Top 5 |
| **Language Patterns (Preferred)** | `main_profile.language_patterns.preferred` | Preferred language patterns/phrases | Top 5 |
| **Language Patterns (Avoid)** | `main_profile.language_patterns.avoid` | Language patterns to avoid | Top 5 |
| **Communication Style** | `main_profile.communication_style` | Overall communication approach description | Full |
| **Editorial Guidelines (Dos)** | `main_profile.editorial_guidelines.dos` | Writing rules to follow | Top 5 |
| **Editorial Guidelines (Don'ts)** | `main_profile.editorial_guidelines.donts` | Writing rules to avoid | Top 5 |

### Example Brand Profile Data

```json
{
  "brandProfile": {
    "main_profile": {
      "tone_attributes": {
        "primary": ["professional", "warm", "empowering", "innovative"],
        "avoid": ["aggressive", "corporate jargon", "condescending"]
      },
      "vocabulary": {
        "signature_phrases": [
          "creativity for all",
          "make it happen",
          "transform your ideas",
          "unleash your potential",
          "create without limits"
        ]
      },
      "brand_values": {
        "core_values": [
          { "name": "Creativity", "evidence": "Empowers users to bring ideas to life" },
          { "name": "Innovation", "evidence": "Pioneers new solutions in digital media" },
          { "name": "Accessibility", "evidence": "Tools for creators at every skill level" }
        ]
      },
      "language_patterns": {
        "preferred": [
          "Use active voice",
          "Lead with benefits",
          "Address the reader directly",
          "Use concrete examples"
        ],
        "avoid": [
          "Passive constructions",
          "Technical jargon without explanation",
          "Overly long sentences"
        ]
      },
      "communication_style": "Direct, empowering, and solution-focused. Balances professionalism with approachability.",
      "editorial_guidelines": {
        "dos": [
          "Keep sentences under 25 words",
          "Use headings to break up content",
          "Include clear calls to action",
          "Start with the most important information"
        ],
        "donts": [
          "Use clichés or buzzwords",
          "Make unsubstantiated claims",
          "Assume technical knowledge",
          "Use ALL CAPS for emphasis"
        ]
      }
    }
  }
}
```

### Formatted Output for AI Prompts

The extracted parameters are formatted into markdown for AI prompt injection:

```markdown
## Brand Guidelines (from Brand Profile)

### TONE ATTRIBUTES
  ✓ MUST USE: professional, warm, empowering, innovative
  ✗ MUST AVOID: aggressive, corporate jargon, condescending

### SIGNATURE PHRASES
  ✓ USE these phrases when relevant:
    • "creativity for all"
    • "make it happen"
    • "transform your ideas"
    • "unleash your potential"
    • "create without limits"

### BRAND VALUES
    • Creativity: Empowers users to bring ideas to life
    • Innovation: Pioneers new solutions in digital media
    • Accessibility: Tools for creators at every skill level

### LANGUAGE PATTERNS
  ✓ Preferred:
    • Use active voice
    • Lead with benefits
    • Address the reader directly
    • Use concrete examples
  ✗ Avoid:
    • Passive constructions
    • Technical jargon without explanation
    • Overly long sentences

### COMMUNICATION STYLE
  Direct, empowering, and solution-focused. Balances professionalism with approachability.

### EDITORIAL GUIDELINES
  ✓ DO:
    • Keep sentences under 25 words
    • Use headings to break up content
    • Include clear calls to action
    • Start with the most important information
  ✗ DON'T:
    • Use clichés or buzzwords
    • Make unsubstantiated claims
    • Assume technical knowledge
    • Use ALL CAPS for emphasis
```

### How Each Audit Uses These Parameters

| Audit | How Brand Guidelines Are Applied |
|-------|----------------------------------|
| **Headings** | Title/H1/description suggestions follow tone attributes and editorial guidelines |
| **Summarization** | Page summaries use signature phrases and match communication style |
| **Readability** | Content rewrites maintain brand voice while improving clarity |
| **Content AI** | System prompt includes guidelines for generative search responses |

### Implementation Files

| Codebase | File | Purpose |
|----------|------|---------|
| **Mystique** (Python) | `app/agents/tools/BrandProfileTool.py` | `BrandProfileFetcher` class - fetches and formats brand guidelines |
| **SpaceCat Audit Worker** (JS) | `src/utils/brand-profile.js` | `extractBrandGuidelinesFromProfile()` + `formatBrandGuidelinesToMarkdown()` |

---

## Related Documentation

- [Brand Profile Customization](./brand-profile-customization.md)
- [Brand Profile Agent Overview](./brand-profile-agent.md)
- [GenStudio Brand Guidelines](https://experienceleague.adobe.com/en/docs/genstudio-for-performance-marketing/user-guide/guidelines/brands)

