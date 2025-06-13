# SpaceCat Task Processor

> SpaceCat Task Processor for processing spacecat tasks.

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
