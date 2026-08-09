# SpaceCat Task Processor

## Overview

SpaceCat Task Processor is a Node.js service that processes messages from the AWS SQS queue `SPACECAT-TASK-PROCESSOR-JOBS`. Based on the `type` field in each message, it dispatches the message to the appropriate handler for processing various site-related tasks.

## Features

- Receives and processes messages from SQS
- Supports multiple task types via modular handlers
- Built-in handlers for audit status, demo URL preparation, generic agent execution, and Slack notifications
- Extensible and easy to add new handlers

## Handlers

- **opportunity-status-processor**: Checks and reports status audits for a site
- **demo-url-processor**: Prepares and shares a demo URL for a site
- **agent-executor**: Runs registered AI/LLM agents (e.g., the brand-profile agent) asynchronously after onboarding flows
- **slack-notify**: Sends Slack notifications (text or block messages) from workflows

## Setup

1. Clone the repository
2. Install dependencies:

   ```sh
   npm install
   ```

3. Configure AWS credentials and environment variables as needed

## Usage

- The service is designed to run as a serverless function or background worker.
- It can be invoked in two ways:
  - **SQS mode:** listens to the `SPACECAT-TASK-PROCESSOR-JOBS` queue and processes messages automatically (default path for existing workflows).
  - **Direct mode:** the Lambda entrypoint auto-detects single-message payloads (e.g., from AWS Step Functions) and executes the corresponding handler synchronously. This is used by the new agent workflows to obtain immediate results before triggering follow-up actions.

## Development

- To run tests:

  ```sh
  npm test
  ```

- To run the optional brand-profile integration test (requires Azure OpenAI env variables):

  ```sh
  npm run test:brand-profile-it
  ```

### Agent Executor Environment

The `agent-executor` (and the provided brand-profile agent) rely on the Azure OpenAI credentials consumed by `@adobe/spacecat-shared-gpt-client`. Ensure the following variables are configured in the Lambda/runner environment (and locally when running the IT test):

| Variable | Purpose |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_KEY` | API key for the Azure OpenAI resource |
| `AZURE_API_VERSION` | API version used for the chat completions |
| `AZURE_COMPLETION_DEPLOYMENT` | Deployment/model name (e.g., `gpt-4o`) |

When invoking the integration test, you can also set `BRAND_PROFILE_TEST_BASE_URL` to control which site is analyzed and `BRAND_PROFILE_IT_FULL=1` to print the complete agent response (otherwise the preview is truncated for readability).

#### Brand-profile entity validation (LLMO-6580)

The brand-profile product and competitor-summary paths bind every Wikipedia/Wikidata lookup to an entity that is validated against the customer's site by a strong P856 (official-website host) match, so a foreign entity's catalogue can never be attached to a customer.

- **Brand-name resolution** (`services/brand-resolver.js`) turns the base profile and site URL into a display name plus the site's registrable domain. It never *derives* a brand name from a bare 2-3 letter acronym or a `dev`/`www`/`store`/`support` subdomain label as high confidence (an explicit `brand_name` supplied by the base profile is trusted as given). The registrable domain is the signal the entity validation compares against.
- **Entity binding** (`services/wikipedia.js`): `findValidatedWikidataEntity` searches Wikidata by name but keeps a candidate **only** if its official-website host (claim P856) shares the site's registrable domain — this is the sole accepted signal; there is no by-name / label / alias fallback, and a bare public-suffix registrable domain (e.g. `co.uk`) never matches. Fallback article text is fetched by the validated entity's **exact** English Wikipedia sitelink title (`fetchWikipediaExtractByTitle`), never by a decoupled `opensearch "<name> company"` query. If no candidate's P856 host matches, the pipeline produces **no** Wikipedia/Wikidata products.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAND_PROFILE_ENABLE_WIKI_PRODUCTS` | `false` | Kill-switch for the entire Wikipedia/Wikidata product + competitor-summary path. When `false`, `extractProducts` returns an empty result (`products_metadata.source = "disabled"`) and no validated summary is fetched; sitemap-based product extraction and the rest of the profile still run. Ship `false` for net-new runs until the P0-a scrub and P2 backfill complete, then flip to `true`. Read from Vault per-service config (`dx_mysticat/{env}/task-processor`). |

`products_metadata.source` terminal values: `sitemap`, `wikidata`, `hybrid`, `wikipedia_llm`, `disabled`, `none_no_validated_entity` (no P856-validated entity), and the pre-existing `none`/`sitemap_*` states. Additive provenance fields: `source_entity_label`, `source_wikipedia_title`, and `validation` (`p856`).

**Persist guard:** `persist()` never overwrites a stored brand profile whose `products_metadata.source == "manual-curated"` — the curated `products`/`products_metadata` are preserved while all other fields update. This protects the hand-curated blocks during the P2 regeneration sweep.

- To lint code:

  ```sh
  npm run lint
  ```

## Extending

To add a new handler:

1. Create a new folder in `src/` for your handler.
2. Export your handler function.
3. Add it to the handler mapping in `src/index.js`.

---
For more details, see the documentation in `src/README.md`.

## Status

[![codecov](https://img.shields.io/codecov/c/github/adobe-rnd/spacecat-task-processor.svg)](https://codecov.io/gh/adobe-rnd/spacecat-task-processor)
[![CircleCI](https://img.shields.io/circleci/project/github/adobe-rnd/spacecat-audit-worker.svg)](https://circleci.com/gh/adobe-rnd/spacecat-task-processor)
[![GitHub license](https://img.shields.io/github/license/adobe-rnd/spacecat-task-processor.svg)](https://github.com/adobe-rnd/spacecat-task-processor/blob/master/LICENSE.txt)
[![GitHub issues](https://img.shields.io/github/issues/adobe-rnd/spacecat-task-processor.svg)](https://github.com/adobe-rnd/spacecat-task-processor/issues)
[![LGTM Code Quality Grade: JavaScript](https://img.shields.io/lgtm/grade/javascript/g/adobe-rnd/spacecat-task-processor.svg?logo=lgtm&logoWidth=18)](https://lgtm.com/projects/g/adobe-rnd/spacecat-task-processor)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

## Installation

```bash
npm install @adobe/spacecat-task-processor
```

## Usage

See the [API documentation](docs/API.md).

## Development

### Build

```bash
npm install
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
```

## Message Body Formats

Task processor consumes the `SPACECAT-TASK-PROCESSOR-JOBS` queue, performs the requested task and sends a notification to Slack as needed.

### SQS (legacy) envelope

```json
{
  "type": "string",
  "siteId": "string"
}
```

### Agent workflow (direct invoke) payload

When the AWS Step Functions Agent Workflow invokes the Lambda directly, it sends the same top-level envelope but without SQS metadata. The payload **must** include `type: "agent-executor"` plus the following fields:

```json
{
  "type": "agent-executor",
  "agentId": "brand-profile",
  "siteId": "123e4567-e89b-12d3-a456-426614174000",
  "context": {
    "baseURL": "https://example.com",
    "params": {
      "crawlDepth": 2
    }
  },
  "slackContext": {
    "channelId": "C123456",
    "threadTs": "1731111111.000200"
  },
  "idempotencyKey": "brand-profile-123e4567-e89b-12d3-a456-426614174000-1731111111000"
}
```

Field descriptions:

- `agentId` *(required)* – must match a registered agent (e.g., `brand-profile`).
- `siteId` *(required)* – kept at the envelope level for logging/metrics. Agents can still read it from the message passed into `agent.persist`.
- `context` *(required)* – forwarded to `agent.run`. At minimum it must include `baseURL`; additional agent-specific params live here.
- `slackContext` *(optional)* – when present, the workflow sends pre-/post-execution Slack notifications using `channelId` and `threadTs`. Provide an empty object `{}` if no Slack context is available.
- `idempotencyKey` *(required by workflow)* – generated by the caller to deduplicate executions. The task processor treats it as opaque metadata but logs it for traceability.

Any additional properties are passed through to the agent and appear in the executor response body so the workflow can inspect them.
