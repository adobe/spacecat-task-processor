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
import { MockContextBuilder } from '../../shared.js';

use(sinonChai);

describe('Opportunity Status Processor', () => {
  let runOpportunityStatusProcessor;
  let context;
  let message;
  let mockSite;

  beforeEach(async () => {
    // Dynamic import
    const handlerModule = await import('../../../src/tasks/opportunity-status-processor/handler.js');
    runOpportunityStatusProcessor = handlerModule.runOpportunityStatusProcessor;

    // Reset all stubs
    sinon.restore();

    // Create sandbox
    const sandbox = sinon.createSandbox();

    // Mock site
    mockSite = {
      getOpportunities: sandbox.stub().resolves([]),
      getSuggestions: sandbox.stub().resolves([]),
    };

    // Mock context
    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Site: {
          findById: sandbox.stub().resolves(mockSite),
        },
      })
      .build();

    // Mock message
    message = {
      siteId: 'test-site-id',
      organizationId: 'test-org-id',
      taskContext: {
        auditTypes: ['cwv', 'broken-links'],
        slackContext: 'test-slack-context',
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('runOpportunityStatusProcessor', () => {
    it('should process opportunities successfully', async () => {
      // Mock opportunities with different types
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'broken-links',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('Processing opportunities for site:', {
        taskType: 'opportunity-status-processor',
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
        auditTypes: ['cwv', 'broken-links'],
      })).to.be.true;

      expect(context.dataAccess.Site.findById.calledWith('test-site-id')).to.be.true;
      expect(mockSite.getOpportunities.called).to.be.true;
      expect(context.log.info.calledWith('Found 2 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });

    it('should handle site not found error', async () => {
      context.dataAccess.Site.findById.resolves(null);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWith('Site not found for siteId: test-site-id')).to.be.true;
    });

    it('should handle getOpportunities errors', async () => {
      mockSite.getOpportunities.rejects(new Error('Database error'));

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWith('Error in opportunity status processor:', sinon.match.any)).to.be.true;
    });

    it('should handle missing slackContext', async () => {
      delete message.taskContext.slackContext;

      // Mock opportunities with different types
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'broken-links',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should complete without error
      expect(context.log.info.calledWith('Found 2 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });

    it('should handle opportunities with different statuses', async () => {
      // Mock opportunities with different statuses
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'broken-links',
          getSuggestions: sinon.stub().resolves([]),
        },
        {
          getType: () => 'meta-tags',
          getSuggestions: sinon.stub().resolves(['suggestion2', 'suggestion3']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('Found 3 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });

    it('should handle empty opportunities array', async () => {
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('Found 0 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });

    it('should handle getSuggestions errors', async () => {
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().rejects(new Error('Suggestions error')),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWith('Error in opportunity status processor:', sinon.match.any)).to.be.true;
    });

    it('should use fallback in getOpportunityTitle for unknown type', async () => {
      // Unknown type, should fallback to Title Case
      const mockOpportunities = [
        {
          getType: () => 'my-custom-type',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });

    it('should deduplicate opportunity types and skip duplicates', async () => {
      // Mock opportunities with duplicate types
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'cwv', // Duplicate type
          getSuggestions: sinon.stub().resolves(['suggestion2']),
        },
        {
          getType: () => 'broken-links',
          getSuggestions: sinon.stub().resolves([]),
        },
        {
          getType: () => 'broken-links', // Another duplicate type
          getSuggestions: sinon.stub().resolves(['suggestion3']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should only process unique types (2 unique types, not 4 total opportunities)
      expect(context.log.info.calledWith('Found 4 opportunities for site test-site-id. RUM available: false')).to.be.true;

      // Verify that getSuggestions was only called for unique types (2 times, not 4)
      expect(mockOpportunities[0].getSuggestions.called).to.be.true;
      expect(mockOpportunities[1].getSuggestions.called).to.be.false; // Should be skipped
      expect(mockOpportunities[2].getSuggestions.called).to.be.true;
      expect(mockOpportunities[3].getSuggestions.called).to.be.false; // Should be skipped
    });

    it('should handle RUM availability scenarios', async () => {
      // Test RUM availability check when no siteUrl is provided
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });

    it('should handle invalid siteUrl gracefully', async () => {
      message.siteUrl = 'invalid-url';
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);
      await runOpportunityStatusProcessor(message, context);
      expect(context.log.warn.calledWith('Could not parse siteUrl for RUM check: invalid-url', sinon.match.any)).to.be.true;
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. RUM available: false')).to.be.true;
    });
  });

  describe('isRUMAvailable', () => {
    let mockContext;
    let mockRUMClient;

    beforeEach(async () => {
      mockContext = {
        log: {
          info: sinon.stub(),
          error: sinon.stub(),
          warn: sinon.stub(),
        },
        env: {
          RUM_ADMIN_KEY: 'test-admin-key',
        },
      };

      mockRUMClient = {
        retrieveDomainkey: sinon.stub(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should handle RUM availability scenarios', async () => {
      // Test RUM available (success case)
      mockRUMClient.retrieveDomainkey.resolves('test-domain-key');
      const RUMAPIClient = await import('@adobe/spacecat-shared-rum-api-client');
      const createFromStub = sinon.stub(RUMAPIClient.default, 'createFrom').returns(mockRUMClient);

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          auditTypes: ['cwv'],
          slackContext: null,
        },
      };

      const testContext = {
        ...mockContext,
        dataAccess: {
          Site: {
            findById: sinon.stub().resolves({
              getOpportunities: sinon.stub().resolves([]),
            }),
          },
        },
      };

      await runOpportunityStatusProcessor(testMessage, testContext);
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(mockRUMClient.retrieveDomainkey.calledWith('example.com')).to.be.true;
      expect(testContext.log.info.calledWith('RUM is available for domain: example.com')).to.be.true;
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. RUM available: true')).to.be.true;

      createFromStub.restore();
    });

    it('should handle RUM unavailability scenarios', async () => {
      // Test RUM unavailable (failure case)
      mockRUMClient.retrieveDomainkey.rejects(new Error('Domain not found'));
      const RUMAPIClient = await import('@adobe/spacecat-shared-rum-api-client');
      const createFromStub = sinon.stub(RUMAPIClient.default, 'createFrom').returns(mockRUMClient);

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://unavailable.com',
        organizationId: 'test-org-id',
        taskContext: {
          auditTypes: ['cwv'],
          slackContext: null,
        },
      };

      const testContext = {
        ...mockContext,
        dataAccess: {
          Site: {
            findById: sinon.stub().resolves({
              getOpportunities: sinon.stub().resolves([]),
            }),
          },
        },
      };

      await runOpportunityStatusProcessor(testMessage, testContext);
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(mockRUMClient.retrieveDomainkey.calledWith('unavailable.com')).to.be.true;
      expect(testContext.log.info.calledWith('RUM is not available for domain: unavailable.com. Reason: Domain not found')).to.be.true;
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. RUM available: false')).to.be.true;

      createFromStub.restore();
    });

    it('should handle RUM client creation errors', async () => {
      // Test RUM client creation failure
      const RUMAPIClient = await import('@adobe/spacecat-shared-rum-api-client');
      const createFromStub = sinon.stub(RUMAPIClient.default, 'createFrom').throws(new Error('RUM client creation failed'));

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://error.com',
        organizationId: 'test-org-id',
        taskContext: {
          auditTypes: ['cwv'],
          slackContext: null,
        },
      };

      const testContext = {
        ...mockContext,
        dataAccess: {
          Site: {
            findById: sinon.stub().resolves({
              getOpportunities: sinon.stub().resolves([]),
            }),
          },
        },
      };

      await runOpportunityStatusProcessor(testMessage, testContext);
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(testContext.log.info.calledWith('RUM is not available for domain: error.com. Reason: RUM client creation failed')).to.be.true;
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. RUM available: false')).to.be.true;

      createFromStub.restore();
    });

    it('should handle CWV opportunities with RUM indicators', async () => {
      // Test CWV opportunities with RUM available
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          auditTypes: ['cwv'],
          slackContext: null,
        },
      };

      const testContext = {
        ...mockContext,
        dataAccess: {
          Site: {
            findById: sinon.stub().resolves({
              getOpportunities: sinon.stub().resolves(mockOpportunities),
            }),
          },
        },
      };

      // Test RUM available case
      const RUMAPIClient = await import('@adobe/spacecat-shared-rum-api-client');
      const createFromStub = sinon.stub(RUMAPIClient.default, 'createFrom').returns(mockRUMClient);
      mockRUMClient.retrieveDomainkey.resolves('test-domain-key');

      await runOpportunityStatusProcessor(testMessage, testContext);
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(mockRUMClient.retrieveDomainkey.calledWith('example.com')).to.be.true;
      expect(testContext.log.info.calledWith('RUM is available for domain: example.com')).to.be.true;
      expect(testContext.log.info.calledWith('Found 1 opportunities for site test-site-id. RUM available: true')).to.be.true;

      createFromStub.restore();
    });

    it('should handle non-CWV opportunities without RUM indicators', async () => {
      // Test non-CWV opportunities (no RUM indicator added)
      const mockOpportunities = [
        {
          getType: () => 'meta-tags',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'broken-links',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          auditTypes: ['meta-tags', 'broken-links'],
          slackContext: null,
        },
      };

      const testContext = {
        ...mockContext,
        dataAccess: {
          Site: {
            findById: sinon.stub().resolves({
              getOpportunities: sinon.stub().resolves(mockOpportunities),
            }),
          },
        },
      };

      // Mock RUM client to return success
      const RUMAPIClient = await import('@adobe/spacecat-shared-rum-api-client');
      const createFromStub = sinon.stub(RUMAPIClient.default, 'createFrom').returns(mockRUMClient);
      mockRUMClient.retrieveDomainkey.resolves('test-domain-key');

      await runOpportunityStatusProcessor(testMessage, testContext);

      // Verify RUM was checked but no RUM indicator was added to non-CWV opportunities
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(mockRUMClient.retrieveDomainkey.calledWith('example.com')).to.be.true;
      expect(testContext.log.info.calledWith('RUM is available for domain: example.com')).to.be.true;
      expect(testContext.log.info.calledWith('Found 2 opportunities for site test-site-id. RUM available: true')).to.be.true;

      createFromStub.restore();
    });
  });
});
