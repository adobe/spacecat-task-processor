# SpaceCat Task Processor

## Overview

SpaceCat Task Processor is a Node.js service that processes messages from the AWS SQS queue `SPACECAT-TASK-PROCESSOR-JOBS`. Based on the `type` field in each message, it dispatches the message to the appropriate handler for processing various site-related tasks.

## Features
- Receives and processes messages from SQS
- Supports multiple task types via modular handlers
- Handlers for audit status, demo URL preparation, and disabling imports/audits
- Extensible and easy to add new handlers

## Handlers
- **opportunity-status-processor**: Checks and reports status audits for a site
- **disable-import-audit-processor**: Disables specified imports and audits for a site
- **demo-url-processor**: Prepares and shares a demo URL for a site

## Setup
1. Clone the repository
2. Install dependencies:
   ```sh
   npm install
   ```
3. Configure AWS credentials and environment variables as needed

## Usage
- The service is designed to run as a serverless function or background worker.
- It listens for messages on the SQS queue and processes them automatically.

## Development
- To run tests:
  ```sh
  npm test
  ```
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
$ npm install @adobe/spacecat-task-processor
```

## Usage

See the [API documentation](docs/API.md).

## Development

### Build

```bash
$ npm install
```

### Test

```bash
$ npm test
```

### Lint

```bash
$ npm run lint
```

## Message Body Formats

Task processor consumes the `SPACECAT-TASK-PROCESSOR-JOBS` queue, performs the requested task and sends a notification to slack as needed.

Expected message body format in `SPACECAT-TASK-PROCESSOR-JOBS` is:

```json
{
  "type": "string",
  "siteId": "string"
}
```
