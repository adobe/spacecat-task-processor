# Brand Profile Agent - Customization Guide

This guide explains how to modify and extend the brand-profile agent. It's designed for developers using Cursor or similar AI-assisted coding tools.

## Quick Reference

### Key Files to Modify

| Task | File(s) to Edit |
|------|-----------------|
| Change voice analysis behavior | `static/prompts/brand-profile/system.prompt` |
| Modify regional inference | `services/regional-context.js` + `regional-inference.prompt` |
| Adjust competitor detection | `services/competitor-inference.js` + `competitor-inference.prompt` |
| Customize persona generation | `services/persona-inference.js` + `persona-inference.prompt` |
| Change product extraction | `services/product-extractor.js` + `product-*.prompt` |
| Add new output fields | `index.js` (assembleEnhancedProfile section) |
| Change fallback values | Individual service files (look for `createFallback*` functions) |

## Common Modifications

### 1. Adding a New Country/Language Mapping

Edit `services/regional-context.js`:

```javascript
// Find COUNTRY_LANGUAGES constant (around line 23)
const COUNTRY_LANGUAGES = {
  US: ['en-US'],
  // Add your country:
  KR: ['ko-KR'],
  CN: ['zh-CN'],
  // ...
};

// Also update CURRENCY_MAP if needed (around line 49)
const CURRENCY_MAP = {
  US: 'USD',
  KR: 'KRW',
  CN: 'CNY',
  // ...
};
```

### 2. Modifying Competitor Count

Edit `static/prompts/brand-profile/competitor-inference.prompt`:

```
// Change this line:
Identify the TOP 5-8 direct competitors for {{brand_name}}

// To your desired range:
Identify the TOP 3-5 direct competitors for {{brand_name}}
```

### 3. Changing Persona Count

Edit `static/prompts/brand-profile/persona-inference.prompt`:

```
// Change this line:
Generate 3-5 customer personas

// To:
Generate 5-7 customer personas
```

### 4. Adding New Product URL Patterns

Edit `services/product-extractor.js`:

```javascript
// Find PRODUCT_SEGMENTS constant (around line 54)
const PRODUCT_SEGMENTS = [
  // Existing patterns...
  '/trucks/', '/suvs/', '/sedans/',

  // Add your patterns:
  '/insurance/', '/plans/', '/policies/',
  '/software/', '/enterprise/', '/cloud/',
];
```

### 5. Adding a New Enhancement Phase

To add a new inference service (e.g., pricing tier detection):

1. Create the service file:
```javascript
// services/pricing-inference.js
import { AzureOpenAIClient } from '@adobe/spacecat-shared-gpt-client';
import { readPromptFile, renderTemplate } from '../../base.js';

export async function inferPricing({ brandName, industry }, gpt, log) {
  const promptTemplate = readPromptFile('brand-profile/pricing-inference.prompt');
  const prompt = renderTemplate(promptTemplate, { brand_name: brandName, industry });

  const resp = await gpt.fetchChatCompletion(prompt, {
    responseFormat: 'json_object',
    temperature: 0.3,
  });

  return JSON.parse(resp?.choices?.[0]?.message?.content || '{}');
}

export function createPricingInferenceService(env, log) {
  const gpt = AzureOpenAIClient.createFrom({ env, log });
  return {
    inferPricing: (params) => inferPricing(params, gpt, log),
  };
}
```

2. Create the prompt file:
```
// static/prompts/brand-profile/pricing-inference.prompt
You are a market analyst...
Brand: {{brand_name}}
Industry: {{industry}}
...
```

3. Integrate in `index.js`:
```javascript
// Add import
import { createPricingInferenceService } from './services/pricing-inference.js';

// In run() function, initialize service
const pricingService = createPricingInferenceService(env, log);

// Add phase (e.g., after Phase 5)
log.info('brand-profile: inferring pricing tiers');
const pricingResult = await pricingService.inferPricing({
  brandName,
  industry,
});

// Add to enhanced profile assembly
const enhancedProfile = {
  ...baseProfile,
  // ... existing fields ...

  // Your new fields:
  pricing_tiers: pricingResult.tiers || [],
  pricing_source: pricingResult.source || 'inferred',
};
```

### 6. Disabling a Specific Enhancement

In `index.js`, comment out or conditionally skip phases:

```javascript
// To disable competitor inference:
// Phase 4: Infer competitors (if not provided from LLMO)
let competitors = [];
let competitorsSource = 'disabled';

// Comment out or remove:
// const competitorResult = await competitorService.inferCompetitors({...});
// competitors = competitorResult.competitors || [];
// competitorsSource = 'inferred';
```

### 7. Changing LLM Temperature

Each service uses temperature settings for LLM calls. Lower = more deterministic, higher = more creative.

In service files, find `fetchChatCompletion` calls:

```javascript
const resp = await gpt.fetchChatCompletion(prompt, {
  responseFormat: 'json_object',
  temperature: 0.3,  // Change this value (0.0 - 1.0)
});
```

Recommended values:
- `0.1` - Factual extraction (products, regions)
- `0.3` - Balanced (competitors, personas)
- `0.5+` - Creative (voice analysis)

### 8. Adding Retry Logic

The services use simple retry loops. To adjust:

```javascript
// Current pattern:
const maxRetries = 2;
for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
  try {
    // LLM call
  } catch (e) {
    if (attempt === maxRetries) {
      return fallback();
    }
  }
}
```

To add exponential backoff:

```javascript
const maxRetries = 3;
for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
  try {
    // LLM call
  } catch (e) {
    if (attempt === maxRetries) {
      return fallback();
    }
    // Wait before retry
    const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
```

## Testing Changes

### Unit Tests

Run specific service tests:
```bash
npm test -- --grep "regional-context"
npm test -- --grep "competitor-inference"
npm test -- --grep "persona-inference"
npm test -- --grep "product-extractor"
```

### Integration Test

Test the full agent locally:
```bash
# Set up environment variables
export AZURE_OPENAI_API_KEY=your-key
export AZURE_OPENAI_API_ENDPOINT=your-endpoint

# Run via npm script or direct invocation
npm run test:integration -- --grep "brand-profile"
```

### Manual Testing in AWS

1. Go to AWS Lambda console
2. Find the task-processor Lambda
3. Create test event:
```json
{
  "type": "agent-executor",
  "agentId": "brand-profile",
  "siteId": "test-site-id",
  "context": {
    "baseURL": "https://example.com",
    "params": {
      "enhance": true
    }
  }
}
```

## Schema Validation

The brand profile is validated by the schema in `spacecat-shared-data-access`:

```
spacecat-shared/packages/spacecat-shared-data-access/src/models/site/config.js
```

The `brandProfile` schema uses `.unknown(true)`, so new fields are allowed. However, if you need strict validation:

1. Add field to schema:
```javascript
brandProfile: Joi.object({
  // Existing fields...

  // Your new field:
  pricing_tiers: Joi.array().items(Joi.object({
    name: Joi.string(),
    price: Joi.number(),
  })).optional(),
}).unknown(true),
```

2. Publish new version of spacecat-shared-data-access
3. Update task-processor dependency

## Debugging Tips

### Enable Verbose Logging

The agent logs extensively. Check CloudWatch logs for:
- `brand-profile: starting analysis` - Agent start
- `brand-profile: running base voice analysis` - Phase 1
- `brand-profile: inferring region from URL` - Phase 2
- `brand-profile: inferring regional context` - Phase 3
- `brand-profile: inferring competitors` - Phase 4
- `brand-profile: inferring customer personas` - Phase 5
- `brand-profile: extracting product catalogue` - Phase 6
- `brand-profile: enhancement complete` - Summary with counts

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Empty competitors | Wikipedia lookup failed | Check brand name spelling, add Wikipedia override |
| Wrong country code | URL has no regional indicators | Use `.de`, `/de/`, or subdomain patterns |
| No products extracted | Brand not in Wikidata | Provide `sitemapUrl` parameter |
| LLM parse errors | Invalid JSON response | Check prompt formatting, adjust temperature |

### Testing Prompts Directly

Use the Azure OpenAI playground or a simple script:

```javascript
const prompt = readPromptFile('brand-profile/competitor-inference.prompt');
const rendered = renderTemplate(prompt, {
  brand_name: 'TestBrand',
  industry: 'Software',
  country_code: 'US',
  wikipedia_summary: 'TestBrand is a software company...',
});

console.log(rendered);
// Copy to Azure OpenAI playground to test
```

## PR Review Checklist

When submitting changes:

- [ ] All new services follow the factory pattern (`create*Service`)
- [ ] New prompts are externalized in `/static/prompts/brand-profile/`
- [ ] Fallback functions handle LLM failures gracefully
- [ ] Retry logic exists for LLM calls
- [ ] Unit tests cover new code paths
- [ ] No hardcoded brand names or URLs
- [ ] Logging added for observability
- [ ] JSDoc comments for public functions
