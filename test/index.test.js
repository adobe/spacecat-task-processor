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
import { Request } from '@adobe/fetch';
import esmock from 'esmock';
import { main, getSecretName } from '../src/index.js';

use(sinonChai);

const sandbox = sinon.createSandbox();

describe('Index Tests', () => {
  const request = new Request('https://space.cat');
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
    context = {
      dataAccess: {},
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub(),
        debug: sandbox.stub(),
      },
      runtime: {
        region: 'us-east-1',
      },
      invocation: {
        event: {
          Records: [{
            body: JSON.stringify(messageBodyJson),
          }],
        },
      },
    };
  });

  afterEach('clean', () => {
    sandbox.restore();
  });

  it('requests without a valid event payload are rejected', async () => {
    delete context.invocation;
    const resp = await main(request, context);

    expect(resp.status).to.equal(400);
    expect(resp.headers.get('x-error')).to.equal('Event does not contain any records');
  });

  it('returns 404 for unknown handler type', async () => {
    messageBodyJson.type = 'unknown-type';
    context.invocation.event.Records[0].body = JSON.stringify(messageBodyJson);
    const resp = await main(request, context);
    expect(resp.status).to.equal(404);
    // Verify the error message was logged
    expect(context.log.error.calledWith('no such task type: unknown-type')).to.be.true;
  });

  it('handles demo-url-processor with broken env', async () => {
    // Test that the handler can handle broken env gracefully
    messageBodyJson.type = 'demo-url-processor';
    messageBodyJson.siteId = 'test-site';
    context.invocation.event.Records[0].body = JSON.stringify(messageBodyJson);
    // Remove env to test error handling in the handler
    context.env = null;
    const resp = await main(request, context);
    expect(resp.status).to.equal(200); // Handler should handle the error gracefully
    // Verify the task handler was found
    expect(context.log.info.calledWith('Found task handler for type: demo-url-processor')).to.be.true;
  });

  it('happy path', async () => {
    const resp = await main(request, context);
    expect(resp.status).to.equal(200);
    // Verify the task handler was found
    expect(context.log.info.calledWith('Found task handler for type: dummy')).to.be.true;
    // Print all log.info calls for debugging
    // eslint-disable-next-line no-console
    console.log('log.info calls:', context.log.info.getCalls().map((call) => call.args[0]));
    // Verify the task completion message (using partial match since timing varies)
    expect(context.log.info.calledWithMatch(sinon.match('dummy task for site-id completed in'))).to.be.true;
  });

  it('should cover getSecretName function', () => {
    const secretName = getSecretName();
    expect(secretName).to.equal('/helix-deploy/spacecat-services/api-service/latest');
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

    const resp = await main(request, context);
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

    const resp = await mockedMain(request, context);
    expect(resp.status).to.equal(500); // Should return internal server error
    expect(context.log.error.calledWithMatch(sinon.match('demo-url-processor task for test-site failed after'))).to.be.true;
  });
});
