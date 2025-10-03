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
import { MockContextBuilder } from '../../shared.js';

use(sinonChai);

// Dynamic import for ES modules
let runDisableImportAuditProcessor;
let mockSay;

describe('Disable Import Audit Processor', () => {
  let context;
  let message;
  let mockSite;
  let mockSiteConfig;
  let mockConfiguration;

  beforeEach(async () => {
    // Reset all stubs
    sinon.restore();

    // Create sandbox
    const sandbox = sinon.createSandbox();

    // Mock the say function
    mockSay = sandbox.stub().resolves();

    // Dynamic import with mocked dependencies
    const handlerModule = await esmock('../../../src/tasks/disable-import-audit-processor/handler.js', {
      '../../../src/utils/slack-utils.js': {
        say: mockSay,
      },
    });
    runDisableImportAuditProcessor = handlerModule.runDisableImportAuditProcessor;

    // Mock site and configuration
    mockSiteConfig = {
      disableImport: sandbox.stub(),
    };

    mockSite = {
      getConfig: sandbox.stub().returns(mockSiteConfig),
      save: sandbox.stub().resolves(),
    };

    mockConfiguration = {
      disableHandlerForSite: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    // Mock context
    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .build();

    // Override data access with our mocks
    context.dataAccess.Site.findByBaseURL = sandbox.stub().resolves(mockSite);
    context.dataAccess.Configuration.findLatest = sandbox.stub().resolves(mockConfiguration);

    // Mock message
    message = {
      siteId: 'test-site-id',
      siteUrl: 'https://example.com',
      organizationId: 'test-org-id',
      taskContext: {
        importTypes: ['ahrefs', 'screaming-frog'],
        auditTypes: ['cwv', 'broken-links'],
        slackContext: 'test-slack-context',
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('runDisableImportAuditProcessor', () => {
    describe('successful processing', () => {
      it('should process disable import and audit successfully', async () => {
        const result = await runDisableImportAuditProcessor(message, context);

        // Verify initial logging
        expect(context.log.info).to.have.been.calledWith('Processing disable import and audit request:', {
          taskType: 'disable-import-audit-processor',
          siteId: 'test-site-id',
          organizationId: 'test-org-id',
          importTypes: ['ahrefs', 'screaming-frog'],
          auditTypes: ['cwv', 'broken-links'],
          scheduledRun: false,
        });

        // Verify site lookup
        expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://example.com');
        expect(mockSite.getConfig).to.have.been.calledOnce;

        // Verify import types were disabled
        expect(mockSiteConfig.disableImport).to.have.been.calledWith('ahrefs');
        expect(mockSiteConfig.disableImport).to.have.been.calledWith('screaming-frog');
        expect(mockSiteConfig.disableImport).to.have.callCount(2);

        // Verify audit types were disabled
        expect(context.dataAccess.Configuration.findLatest).to.have.been.calledOnce;
        expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('cwv', mockSite);
        expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('broken-links', mockSite);
        expect(mockConfiguration.disableHandlerForSite).to.have.callCount(2);

        // Verify saves were called
        expect(mockSite.save).to.have.been.calledOnce;
        expect(mockConfiguration.save).to.have.been.calledOnce;

        // Verify completion logging
        expect(context.log.info).to.have.been.calledWith('For site: https://example.com: Disabled imports and audits');

        // Verify Slack messages
        expect(mockSay).to.have.been.calledTwice;
        expect(mockSay.firstCall).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':broom: *For site: https://example.com: Disabled imports*: ahrefs, screaming-frog *and audits*: cwv, broken-links',
        );
        expect(mockSay.secondCall).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':information_source: The list of enabled imports and audits may differ from the disabled ones because items that are already enabled are not automatically disabled. When schedule run flag is true then no imports and audits are disabled.',
        );

        // Verify successful completion
        expect(result).to.exist;
      });

      it('should handle empty import and audit arrays', async () => {
        message.taskContext.importTypes = [];
        message.taskContext.auditTypes = [];

        const result = await runDisableImportAuditProcessor(message, context);

        // Verify no disable calls were made
        expect(mockSiteConfig.disableImport).to.not.have.been.called;
        expect(mockConfiguration.disableHandlerForSite).to.not.have.been.called;

        // Verify saves were still called
        expect(mockSite.save).to.have.been.calledOnce;
        expect(mockConfiguration.save).to.have.been.calledOnce;

        // Verify Slack messages with "None" text
        expect(mockSay.firstCall).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':broom: *For site: https://example.com: Disabled imports*: None *and audits*: None',
        );

        expect(result).to.exist;
      });

      it('should handle missing taskContext properties', async () => {
        message.taskContext = {
          slackContext: 'test-slack-context',
        };

        const result = await runDisableImportAuditProcessor(message, context);

        // Verify no disable calls were made
        expect(mockSiteConfig.disableImport).to.not.have.been.called;
        expect(mockConfiguration.disableHandlerForSite).to.not.have.been.called;

        // Verify Slack messages with "None" text
        expect(mockSay.firstCall).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':broom: *For site: https://example.com: Disabled imports*: None *and audits*: None',
        );

        expect(result).to.exist;
      });

      it('should handle missing slackContext gracefully', async () => {
        delete message.taskContext.slackContext;

        const result = await runDisableImportAuditProcessor(message, context);

        // Should complete without error
        expect(context.log.info).to.have.been.calledWith('For site: https://example.com: Disabled imports and audits');
        expect(mockSay).to.have.been.calledTwice;
        expect(result).to.exist;
      });
    });

    describe('scheduled run handling', () => {
      it('should skip disable operations when scheduledRun is true', async () => {
        message.taskContext.scheduledRun = true;

        const result = await runDisableImportAuditProcessor(message, context);

        // Should log scheduled run detection
        expect(context.log.info).to.have.been.calledWith('Processing disable import and audit request:', {
          taskType: 'disable-import-audit-processor',
          siteId: 'test-site-id',
          organizationId: 'test-org-id',
          importTypes: ['ahrefs', 'screaming-frog'],
          auditTypes: ['cwv', 'broken-links'],
          scheduledRun: true,
        });

        expect(context.log.info).to.have.been.calledWith('Scheduled run detected - skipping disable of imports and audits');

        // Should not perform any disable operations
        expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
        expect(mockSiteConfig.disableImport).to.not.have.been.called;
        expect(mockConfiguration.disableHandlerForSite).to.not.have.been.called;
        expect(mockSite.save).to.not.have.been.called;
        expect(mockConfiguration.save).to.not.have.been.called;

        // Should send Slack notification about scheduled run
        expect(mockSay).to.have.been.calledOnceWith(
          context.env,
          context.log,
          'test-slack-context',
          ':information_source: Scheduled run detected for site https://example.com - skipping disable of imports and audits',
        );

        // Should return success message indicating no operations performed
        expect(result).to.deep.equal({
          message: 'Scheduled run - no disable of imports and audits performed',
        });
      });

      it('should handle scheduled run with empty arrays', async () => {
        message.taskContext.scheduledRun = true;
        message.taskContext.importTypes = [];
        message.taskContext.auditTypes = [];

        const result = await runDisableImportAuditProcessor(message, context);

        expect(mockSay).to.have.been.calledOnceWith(
          context.env,
          context.log,
          'test-slack-context',
          ':information_source: Scheduled run detected for site https://example.com - skipping disable of imports and audits',
        );

        expect(result).to.deep.equal({
          message: 'Scheduled run - no disable of imports and audits performed',
        });
      });
    });

    describe('error handling', () => {
      it('should handle site not found error', async () => {
        context.dataAccess.Site.findByBaseURL.resolves(null);

        const result = await runDisableImportAuditProcessor(message, context);

        expect(context.log.error).to.have.been.calledWith('Error in disable import and audit processor:', sinon.match.instanceOf(Error));
        expect(mockSite.save).to.not.have.been.called;
        expect(mockConfiguration.save).to.not.have.been.called;

        // Should send error Slack message
        expect(mockSay).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':x: Error disabling imports and audits: Site not found for siteId: test-site-id',
        );

        expect(result).to.exist;
      });

      it('should handle site save errors', async () => {
        const saveError = new Error('Database save error');
        mockSite.save.rejects(saveError);

        const result = await runDisableImportAuditProcessor(message, context);

        expect(context.log.error).to.have.been.calledWith('Error in disable import and audit processor:', saveError);
        expect(mockSay).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':x: Error disabling imports and audits: Database save error',
        );

        expect(result).to.exist;
      });

      it('should handle configuration save errors', async () => {
        const saveError = new Error('Configuration save failed');
        mockConfiguration.save.rejects(saveError);

        const result = await runDisableImportAuditProcessor(message, context);

        expect(context.log.error).to.have.been.calledWith('Error in disable import and audit processor:', saveError);
        expect(mockSay).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':x: Error disabling imports and audits: Configuration save failed',
        );

        expect(result).to.exist;
      });

      it('should handle site lookup errors', async () => {
        const lookupError = new Error('Database connection failed');
        context.dataAccess.Site.findByBaseURL.rejects(lookupError);

        const result = await runDisableImportAuditProcessor(message, context);

        expect(context.log.error).to.have.been.calledWith('Error in disable import and audit processor:', lookupError);
        expect(mockSay).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':x: Error disabling imports and audits: Database connection failed',
        );

        expect(result).to.exist;
      });

      it('should handle configuration lookup errors', async () => {
        const configError = new Error('Configuration not found');
        context.dataAccess.Configuration.findLatest.rejects(configError);

        const result = await runDisableImportAuditProcessor(message, context);

        expect(context.log.error).to.have.been.calledWith('Error in disable import and audit processor:', configError);
        expect(mockSay).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':x: Error disabling imports and audits: Configuration not found',
        );

        expect(result).to.exist;
      });

      it('should handle Slack notification errors gracefully', async () => {
        const slackError = new Error('Slack API error');
        mockSay.onFirstCall().rejects(slackError);
        mockSay.onSecondCall().resolves(); // Second call should succeed

        const result = await runDisableImportAuditProcessor(message, context);

        // Should still complete successfully despite Slack error
        expect(mockSite.save).to.have.been.calledOnce;
        expect(mockConfiguration.save).to.have.been.calledOnce;
        expect(result).to.exist;
      });
    });

    describe('input validation', () => {
      it('should handle null taskContext', async () => {
        message.taskContext = null;

        try {
          await runDisableImportAuditProcessor(message, context);
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect(error).to.be.instanceOf(TypeError);
          expect(error.message).to.include('Cannot read properties of null');
        }
      });

      it('should handle undefined taskContext', async () => {
        delete message.taskContext;

        try {
          await runDisableImportAuditProcessor(message, context);
          expect.fail('Should have thrown an error');
        } catch (error) {
          expect(error).to.be.instanceOf(TypeError);
          expect(error.message).to.include('Cannot read properties of undefined');
        }
      });

      it('should handle missing siteUrl', async () => {
        delete message.siteUrl;

        const result = await runDisableImportAuditProcessor(message, context);

        expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledWith(undefined);
        expect(result).to.exist;
      });

      it('should handle single import and audit types', async () => {
        message.taskContext.importTypes = ['single-import'];
        message.taskContext.auditTypes = ['single-audit'];

        const result = await runDisableImportAuditProcessor(message, context);

        expect(mockSiteConfig.disableImport).to.have.been.calledOnceWith('single-import');
        expect(mockConfiguration.disableHandlerForSite).to.have.been.calledOnceWith('single-audit', mockSite);

        expect(mockSay.firstCall).to.have.been.calledWith(
          context.env,
          context.log,
          'test-slack-context',
          ':broom: *For site: https://example.com: Disabled imports*: single-import *and audits*: single-audit',
        );

        expect(result).to.exist;
      });
    });
  });
});
