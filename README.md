# SpaceCat Task Processor

> SpaceCat Task Processor for processing spacecat tasks.

## Status
[![codecov](https://img.shields.io/codecov/c/github/adobe-rnd/spacecat-task-processor.svg)](https://codecov.io/gh/adobe-rnd/spacecat-task-processor)
[![CircleCI](https://img.shields.io/circleci/project/github/adobe-rnd/spacecat-audit-worker.svg)](https://circleci.com/gh/adobe-rnd/spacecat-audit-worker)
[![GitHub license](https://img.shields.io/github/license/adobe-rnd/spacecat-audit-worker.svg)](https://github.com/adobe-rnd/spacecat-audit-worker/blob/master/LICENSE.txt)
[![GitHub issues](https://img.shields.io/github/issues/adobe-rnd/spacecat-audit-worker.svg)](https://github.com/adobe-rnd/spacecat-audit-worker/issues)
[![LGTM Code Quality Grade: JavaScript](https://img.shields.io/lgtm/grade/javascript/g/adobe-rnd/spacecat-audit-worker.svg?logo=lgtm&logoWidth=18)](https://lgtm.com/projects/g/adobe-rnd/spacecat-audit-worker)
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

Output message body format sent to `SPACECAT-TASK-PROCESSOR-JOBS` is:

```json
{
  "type": "string",
  "url": "string",
  "auditContext": "object",
  "auditResult": "object"
}
```

## How to Run Locally

### 1. Using `nodemon` and AWS Credentials

Everyone working on Spacecat should have access to the development environments via [KLAM](https://klam.corp.adobe.com/).  
If you don’t have access, please refer to the engineering onboarding guide or contact your Spacecat team representative.

After logging into KLAM, you’ll receive the following credentials required to access AWS resources such as DynamoDB and S3 for local development:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`

**IMPORTANT: DO NOT USE THE AWS TOKENS FROM KLAM PRODUCTION PROFILES. USE ONLY DEV TOKENS.**


### Steps to use `nodemon`

#### 1. Create an `.env` File

Create a `.env` file in the root directory with the following environment variables, which are required for all audits.  
Add any additional environment variables specific to the audit you're working on.

```
AWS_REGION=us-east-1
DYNAMO_TABLE_NAME_DATA=spacecat-services-data
AWS_ACCESS_KEY_ID=<acquired from KLAM>
AWS_SECRET_ACCESS_KEY=<acquired from KLAM>
AWS_SESSION_TOKEN=<acquired from KLAM>
# ... other required variables depending on the audit
```

#### 2. Run/Debug with `npm start`

Once your `.env` file is set up, start the local development server using:

```bash
npm start
```

To use breakpoints, make sure to use the debugging tools provided by your IDE (e.g., VSCode, WebStorm, etc.).

#### 3. Trigger a Task

With the server running, you can trigger a task using a `curl` POST request. The request body should include the task type and `siteId`:

```json
{
  "type": "<task handler name>",
  "siteId": "<siteId>"
}
```

- A list of task handler names can be found in the [index.js file](https://github.com/adobe/spacecat-task-processor/blob/main/src/index.js#L45).
- You can retrieve a `siteId` using:
    - The [Spacecat API](https://opensource.adobe.com/spacecat-api-service/#tag/site/operation/getSiteByBaseUrl)
    - The Slack command: `@spacecat-dev get site domain.com`

Example `curl` request to trigger the "demo-url" task:

```bash
curl -X POST http://localhost:3000 \
     -H "Content-Type: application/json" \
     -d '{ "type": "demo-url", "siteId": "9ab0575a-c238-4470-ae82-9d37fb2d0e78" }'
```

### 2. Using AWS SAM and Docker.

1. Ensure you have [Docker](https://docs.docker.com/desktop/setup/install/mac-install/), [AWS SAM](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and [jq](https://jqlang.org/) installed.
2. Login to AWS using [KLAM](https://klam.corp.adobe.com/) and login with your [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
    * KLAM dev project: `SpaceCat Development (AWS3338)`
3. To provide secrets to the audit, please run `./scripts/populate-env.sh` once. It will fetch all secrets from the AWS Secret Manager.
4. To run the audit locally, execute the following commands:
    ```bash
    source env.sh
    npm run local-build
    npm run local-run
    ```
5. Starting point of the execution is `src/index-local.js`. Output of the audit can be found in `output.txt`.
6. To hot reload any changes in the `/src` folder, you can use `npm run local-watch`. Note: This will require to run `npm run local-build` at least once beforehand.

If you need to add additional secrets, make sure to adjust the Lambda `template.yml` accordingly.

