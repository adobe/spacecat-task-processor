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

import { expect } from 'chai';
import sinon from 'sinon';
import { MockContextBuilder } from '../../shared.js';

// Dynamic import for ES modules
let runDemoUrlProcessor;

describe('Demo URL Processor', () => {
  let context;
  let message;

  beforeEach(async () => {
    // Dynamic import
    const handlerModule = await import('../../../src/tasks/demo-url-processor/handler.js');
    runDemoUrlProcessor = handlerModule.runDemoUrlProcessor;

    // Reset all stubs
    sinon.restore();

    // Create sandbox
    const sandbox = sinon.createSandbox();

    // Mock context
    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .build();

    // Mock message
    message = {
      siteId: 'test-site-id',
      organizationId: 'test-org-id',
      taskContext: {
        siteUrl: 'https://example.com',
        slackContext: 'test-slack-context',
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('runDemoUrlProcessor', () => {
    it('should process demo URL successfully', async () => {
      await runDemoUrlProcessor(message, context);
      expect(context.log.info.calledWith('Processing demo url for site:', {
        taskType: 'demo-url-processor',
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
      })).to.be.true;
      const expectedDemoUrl = 'https://example.com?organizationId=test-org-id#/@aemrefdemoshared/sites-optimizer/sites/test-site-id/home';
      expect(context.log.info.calledWith(`Setup complete! Access your demo environment here: ${expectedDemoUrl}`)).to.be.true;
    });

    it('should handle missing slackContext in taskContext', async () => {
      delete message.taskContext.slackContext;
      await runDemoUrlProcessor(message, context);
      const expectedDemoUrl = 'https://example.com?organizationId=test-org-id#/@aemrefdemoshared/sites-optimizer/sites/test-site-id/home';
      expect(context.log.info.calledWith(`Setup complete! Access your demo environment here: ${expectedDemoUrl}`)).to.be.true;
    });
  });
});
