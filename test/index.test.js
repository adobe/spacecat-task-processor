/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import { main, getSecretName } from '../src/index.js';

use(sinonChai);

const sandbox = sinon.createSandbox();

describe('Index Tests', () => {
  let sqsEvent;
  let context;
  let messageBodyJson;

  beforeEach('setup', () => {
    process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs22.x';
    messageBodyJson = {
      type: 'dummy',
      siteId: 'site-id',
      taskContext: {
        key: 'value',
      },
    };
    sqsEvent = {
      Records: [{
        body: JSON.stringify(messageBodyJson),
      }],
    };

    context = {
      dataAccess: {},
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub(),
        debug: sandbox.stub(),
      },
      env: {
        imsHost: 'https://ims-na1.adobelogin.com',
        clientId: 'test-client-id',
        clientCode: 'test-client-code',
        clientSecret: 'test-client-secret',
        DEFAULT_TENANT_ID: 'default-tenant',
      },
      imsHost: 'https://ims-na1.adobelogin.com',
      clientId: 'test-client-id',
      clientCode: 'test-client-code',
      clientSecret: 'test-client-secret',
      imsClient: {
        getImsOrganizationDetails: sandbox.stub(),
      },
      runtime: {
        region: 'us-east-1',
      },
      invocation: {
        event: sqsEvent,
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('requests without a valid event payload are rejected', async () => {
    delete context.invocation;
    const resp = await main(sqsEvent, context);

    expect(resp.status).to.equal(400);
    expect(resp.headers.get('x-error')).to.equal('Event does not contain any records');
  });

  it('returns 404 for unknown handler type', async () => {
    messageBodyJson.type = 'unknown-type';
    context.invocation.event.Records[0].body = JSON.stringify(messageBodyJson);
    const resp = await main(sqsEvent, context);
    expect(resp.status).to.equal(404);
    // Verify the error message was logged
    expect(context.log.error.calledWith('no such task type: unknown-type')).to.be.true;
  });

  it('handles demo-url-processor with broken env', async () => {
    // Test that the handler can handle broken env gracefully
    messageBodyJson.type = 'demo-url-processor';
    messageBodyJson.siteId = 'test-site';
    messageBodyJson.organizationId = 'test-org';
    messageBodyJson.taskContext = {
      siteUrl: 'https://example.com',
      slackContext: 'test-slack-context',
    };
    context.invocation.event.Records[0].body = JSON.stringify(messageBodyJson);

    // Provide minimal data access and env
    context.dataAccess = {
      Organization: {
        findById: sandbox.stub().resolves({
          name: 'Test Organization',
          imsOrgId: 'TEST_ORG_ID@AdobeOrg',
        }),
      },
    };
    context.env = {
      IMSORG_TO_TENANT: JSON.stringify({
        'TEST_ORG_ID@AdobeOrg': 'test-org',
      }),
    };

    const resp = await main(sqsEvent, context);
    expect(resp.status).to.equal(200); // Handler should handle the error gracefully
    // Verify the task handler was found
    expect(context.log.info.calledWith('Found task handler for type: demo-url-processor')).to.be.true;
  });

  it('happy path', async () => {
    const resp = await main(sqsEvent, context);
    expect(resp.status).to.equal(200);
    // Verify the task handler was found
    expect(context.log.info.calledWith('Found task handler for type: dummy')).to.be.true;
    // Print all log.info calls for debugging
    // eslint-disable-next-line no-console
    // Verify the task completion message (using partial match since timing varies)
    expect(context.log.info.calledWithMatch(sinon.match('dummy task for site-id completed in'))).to.be.true;
  });

  it('should cover getSecretName function', () => {
    const secretName = getSecretName();
    expect(secretName).to.equal('/helix-deploy/spacecat-services/task-manager/latest');
  });

  it('should handle handler throwing an error', async () => {
    // Test a handler type that doesn't exist to trigger the catch block
    messageBodyJson.type = 'opportunity-status-processor';
    messageBodyJson.siteId = 'test-site';
    messageBodyJson.organizationId = 'test-org';
    context.invocation.event.Records[0].body = JSON.stringify(messageBodyJson);

    // Mock dataAccess to throw an error when Site.findByBaseURL is called
    context.dataAccess = {
      Site: {
        findByBaseURL: () => { throw new Error('Database connection failed'); },
      },
    };

    const resp = await main(sqsEvent, context);
    expect(resp.status).to.equal(200); // Handler catches the error internally
    // Verify the task handler was found
    expect(context.log.info.calledWith('Found task handler for type: opportunity-status-processor')).to.be.true;
  });

  it('should trigger catch block when handler throws', async () => {
    // Create a test that actually triggers the catch block by making a handler throw
    messageBodyJson.type = 'demo-url-processor';
    messageBodyJson.siteId = 'test-site';
    context.invocation.event.Records[0].body = JSON.stringify(messageBodyJson);

    // Use esmock to mock the handler to throw an error
    const { main: mockedMain } = await esmock('../src/index.js', {
      '../src/tasks/demo-url-processor/handler.js': {
        runDemoUrlProcessor: () => {
          throw new Error('Handler error for testing catch block');
        },
      },
    });

    const resp = await mockedMain(sqsEvent, context);
    expect(resp.status).to.equal(500); // Should return internal server error
    expect(context.log.error.calledWithMatch(sinon.match('demo-url-processor task for test-site failed after'))).to.be.true;
  });

  describe('direct invocation detection', () => {
    it('falls back to badRequest when no payload is provided', async () => {
      const resp = await main({ random: 'value' }, { ...context, invocation: undefined });
      expect(resp.status).to.equal(400);
    });

    it('uses payload from context invocation when present', async () => {
      const directContext = {
        ...context,
        invocation: {
          event: {
            type: 'dummy',
            siteId: 'direct-site',
          },
        },
      };
      const resp = await main({}, directContext);
      expect(resp.status).to.equal(200);
      expect(directContext.log.info.calledWith('Found task handler for type: dummy')).to.be.true;
    });
  });
});
