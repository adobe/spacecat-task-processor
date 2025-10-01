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
let runDisableImportAuditProcessor;

describe('Disable Import Audit Processor', () => {
  let context;
  let message;
  let mockSite;
  let mockSiteConfig;
  let mockConfiguration;

  beforeEach(async () => {
    // Dynamic import
    const handlerModule = await import('../../../src/tasks/disable-import-audit-processor/handler.js');
    runDisableImportAuditProcessor = handlerModule.runDisableImportAuditProcessor;

    // Reset all stubs
    sinon.restore();

    // Create sandbox
    const sandbox = sinon.createSandbox();

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
    it('should process disable import and audit successfully', async () => {
      await runDisableImportAuditProcessor(message, context);

      expect(context.log.info.calledWith('Processing disable import and audit request:', {
        taskType: 'disable-import-audit-processor',
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
        importTypes: ['ahrefs', 'screaming-frog'],
        auditTypes: ['cwv', 'broken-links'],
        scheduledRun: false,
      })).to.be.true;

      expect(context.dataAccess.Site.findByBaseURL.calledWith('https://example.com')).to.be.true;
      expect(mockSite.getConfig.called).to.be.true;

      // Check import types were disabled
      expect(mockSiteConfig.disableImport.calledWith('ahrefs')).to.be.true;
      expect(mockSiteConfig.disableImport.calledWith('screaming-frog')).to.be.true;

      // Check audit types were disabled
      expect(context.dataAccess.Configuration.findLatest.called).to.be.true;
      expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', mockSite)).to.be.true;
      expect(mockConfiguration.disableHandlerForSite.calledWith('broken-links', mockSite)).to.be.true;

      // Check saves were called
      expect(mockSite.save.called).to.be.true;
      expect(mockConfiguration.save.called).to.be.true;
      expect(context.log.info.calledWith('For site: https://example.com: Disabled imports and audits')).to.be.true;
    });

    it('should handle site not found error', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);

      await runDisableImportAuditProcessor(message, context);

      expect(context.log.error.calledWith('Error in disable import and audit processor:', sinon.match.any)).to.be.true;
      expect(mockSite.save.called).to.be.false;
      expect(mockConfiguration.save.called).to.be.false;
    });

    it('should handle database save errors', async () => {
      mockSite.save.rejects(new Error('Database save error'));

      await runDisableImportAuditProcessor(message, context);

      expect(context.log.error.calledWith('Error in disable import and audit processor:', sinon.match.any)).to.be.true;
    });

    it('should handle missing slackContext', async () => {
      delete message.taskContext.slackContext;

      await runDisableImportAuditProcessor(message, context);

      // Should complete without error
      expect(context.log.info.calledWith('For site: https://example.com: Disabled imports and audits')).to.be.true;
    });

    it('should skip disable operations when scheduledRun is true', async () => {
      message.taskContext.scheduledRun = true;

      const result = await runDisableImportAuditProcessor(message, context);

      // Should log scheduled run detection
      expect(context.log.info.calledWith('Processing disable import and audit request:', {
        taskType: 'disable-import-audit-processor',
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
        importTypes: ['ahrefs', 'screaming-frog'],
        auditTypes: ['cwv', 'broken-links'],
        scheduledRun: true,
      })).to.be.true;

      expect(context.log.info.calledWith('Scheduled run detected - skipping disable of imports and audits')).to.be.true;

      // Should not perform any disable operations
      expect(context.dataAccess.Site.findByBaseURL.called).to.be.false;
      expect(mockSiteConfig.disableImport.called).to.be.false;
      expect(mockConfiguration.disableHandlerForSite.called).to.be.false;
      expect(mockSite.save.called).to.be.false;
      expect(mockConfiguration.save.called).to.be.false;

      // Should return success message indicating no operations performed
      expect(result).to.be.an('object');
      expect(result.message).to.equal('Scheduled run - no disable of imports and audits performed');
    });
  });
});
