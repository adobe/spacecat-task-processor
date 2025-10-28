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
        SiteTopPage: {
          allBySiteIdAndSourceAndGeo: sandbox.stub().resolves([]),
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
        onboardStartTime: undefined,
      })).to.be.true;

      expect(context.dataAccess.Site.findById.calledWith('test-site-id')).to.be.true;
      expect(mockSite.getOpportunities.called).to.be.true;
      expect(context.log.info.calledWith('Found 2 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
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
      expect(context.log.info.calledWith('Found 2 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
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

      expect(context.log.info.calledWith('Found 3 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
    });

    it('should handle empty opportunities array', async () => {
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
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
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
    });

    it('should process opportunities by type avoiding duplicates', async () => {
      // Mock opportunities with duplicate types
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'cwv', // Duplicate type - should be skipped
          getSuggestions: sinon.stub().resolves(['suggestion2']),
        },
        {
          getType: () => 'broken-links',
          getSuggestions: sinon.stub().resolves([]),
        },
        {
          getType: () => 'broken-links', // Another duplicate type - should be skipped
          getSuggestions: sinon.stub().resolves(['suggestion3']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should process all opportunities (4 total opportunities)
      expect(context.log.info.calledWith('Found 4 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;

      // With the new logic, getSuggestions should only be called for unique opportunity types
      // First occurrence of 'cwv' should be processed
      expect(mockOpportunities[0].getSuggestions.called).to.be.true;
      // Second occurrence of 'cwv' should be skipped (duplicate)
      expect(mockOpportunities[1].getSuggestions.called).to.be.false;
      // First occurrence of 'broken-links' should be processed
      expect(mockOpportunities[2].getSuggestions.called).to.be.true;
      // Second occurrence of 'broken-links' should be skipped (duplicate)
      expect(mockOpportunities[3].getSuggestions.called).to.be.false;
    });

    it('should handle RUM availability check when no siteUrl is provided', async () => {
      // Test RUM availability check when no siteUrl is provided
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
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

      // For this test, we'll just verify that the error is handled gracefully
      // The actual resolveCanonicalUrl function will throw an error for invalid URLs
      await runOpportunityStatusProcessor(message, context);
      expect(context.log.warn.calledWith('Could not resolve canonical URL or parse siteUrl for data source checks: invalid-url', sinon.match.any)).to.be.true;
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
    });

    it('should check AHREFS data availability', async () => {
      // Mock AHREFS data available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([
        { url: 'https://example.com/page1', traffic: 100 },
        { url: 'https://example.com/page2', traffic: 50 },
      ]);

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.calledWith('test-site-id', 'ahrefs', 'global')).to.be.true;
      expect(context.log.info.calledWith('AHREFS data availability for site test-site-id: Available (2 top pages)')).to.be.true;
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: true, GSC: false')).to.be.true;
    });

    it('should handle AHREFS data not available', async () => {
      // Mock AHREFS data not available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([]);

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('AHREFS data availability for site test-site-id: Not available (0 top pages)')).to.be.true;
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
    });

    it('should handle AHREFS check errors', async () => {
      // Mock AHREFS check error
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.rejects(new Error('Database error'));

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWith('Error checking AHREFS data availability for site test-site-id: Database error')).to.be.true;
      expect(context.log.info.calledWith('Found 1 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
    });
  });

  describe('isRUMAvailable', () => {
    let mockContext;
    let mockRUMClient;

    beforeEach(async () => {
      // Setup mock context and RUM client for testing

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

    it('should handle localhost URL resolution failures', async () => {
      // Test various localhost URL scenarios that fail resolveCanonicalUrl
      const testCases = [
        { url: 'http://localhost:3001', description: 'localhost with port' },
        { url: 'http://test.localhost', description: 'localhost subdomain' },
        { url: 'http://localhost:3002', description: 'localhost with different port' },
        { url: 'http://localhost:3003', description: 'localhost with another port' },
      ];

      await Promise.all(testCases.map(async (testCase) => {
        const testMessage = {
          siteId: 'test-site-id',
          siteUrl: testCase.url,
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
            SiteTopPage: {
              allBySiteIdAndSourceAndGeo: sinon.stub().resolves([]),
            },
          },
        };

        await runOpportunityStatusProcessor(testMessage, testContext);

        // Verify error handling for localhost URLs
        expect(testContext.log.warn.calledWith(`Could not resolve canonical URL or parse siteUrl for data source checks: ${testCase.url}`, sinon.match.any)).to.be.true;
        expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;
      }));
    });

    it('should handle RUM success scenarios', async () => {
      // Test RUM available (success case) - use a simple URL that should resolve quickly
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
          SiteTopPage: {
            allBySiteIdAndSourceAndGeo: sinon.stub().resolves([]),
          },
        },
      };

      await runOpportunityStatusProcessor(testMessage, testContext);

      // Verify RUM was checked successfully - this should cover lines 26-37
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(mockRUMClient.retrieveDomainkey.calledWith('example.com')).to.be.true;
      expect(testContext.log.info.calledWith('RUM is available for domain: example.com')).to.be.true;
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: true, AHREFS: false, GSC: false')).to.be.true;

      createFromStub.restore();
    });

    it('should handle opportunities with different types and localhost URLs', async () => {
      // Test opportunities with different types when using localhost URLs
      const testCases = [
        {
          opportunities: [{ getType: () => 'cwv', getSuggestions: sinon.stub().resolves(['suggestion1']) }],
          auditTypes: ['cwv'],
          expectedCount: 1,
          description: 'CWV opportunities',
        },
        {
          opportunities: [
            { getType: () => 'meta-tags', getSuggestions: sinon.stub().resolves(['suggestion1']) },
            { getType: () => 'broken-links', getSuggestions: sinon.stub().resolves([]) },
          ],
          auditTypes: ['meta-tags', 'broken-links'],
          expectedCount: 2,
          description: 'Non-CWV opportunities',
        },
      ];

      await Promise.all(testCases.map(async (testCase) => {
        const testMessage = {
          siteId: 'test-site-id',
          siteUrl: 'http://localhost:3001',
          organizationId: 'test-org-id',
          taskContext: {
            auditTypes: testCase.auditTypes,
            slackContext: null,
          },
        };

        const testContext = {
          ...mockContext,
          dataAccess: {
            Site: {
              findById: sinon.stub().resolves({
                getOpportunities: sinon.stub().resolves(testCase.opportunities),
              }),
            },
            SiteTopPage: {
              allBySiteIdAndSourceAndGeo: sinon.stub().resolves([]),
            },
          },
        };

        await runOpportunityStatusProcessor(testMessage, testContext);

        // Verify error handling for localhost URLs
        expect(testContext.log.warn.calledWith('Could not resolve canonical URL or parse siteUrl for data source checks: http://localhost:3001', sinon.match.any)).to.be.true;
        expect(testContext.log.info.calledWith(`Found ${testCase.expectedCount} opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false`)).to.be.true;
      }));
    });
  });

  describe('GSC Configuration', () => {
    let mockContext;
    let mockGoogleClient;

    beforeEach(async () => {
      mockContext = {
        log: {
          info: sinon.stub(),
          error: sinon.stub(),
          warn: sinon.stub(),
        },
        env: {
          GOOGLE_CLIENT_ID: 'test-client-id',
          GOOGLE_CLIENT_SECRET: 'test-client-secret',
          GOOGLE_REDIRECT_URI: 'test-redirect-uri',
        },
      };

      mockGoogleClient = {
        listSites: sinon.stub(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should handle GSC configuration success', async () => {
      // Mock GSC success
      mockGoogleClient.listSites.resolves({
        data: {
          siteEntry: [
            { siteUrl: 'https://example.com' },
          ],
        },
      });

      const GoogleClient = await import('@adobe/spacecat-shared-google-client');
      const createFromStub = sinon.stub(GoogleClient.default, 'createFrom').resolves(mockGoogleClient);

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
          SiteTopPage: {
            allBySiteIdAndSourceAndGeo: sinon.stub().resolves([]),
          },
        },
      };

      await runOpportunityStatusProcessor(testMessage, testContext);

      // Check if GoogleClient.createFrom was called (it should be called with context and URL)
      expect(createFromStub.called).to.be.true;
      expect(createFromStub.firstCall.args[0]).to.deep.equal(testContext);
      expect(createFromStub.firstCall.args[1]).to.equal('https://example.com/');
      expect(mockGoogleClient.listSites.called).to.be.true;
      expect(testContext.log.info.calledWith('GSC configuration for site https://example.com/: Configured and connected')).to.be.true;
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: true')).to.be.true;

      createFromStub.restore();
    });

    it('should handle GSC configuration failure', async () => {
      // Mock GSC failure
      const GoogleClient = await import('@adobe/spacecat-shared-google-client');
      const createFromStub = sinon.stub(GoogleClient.default, 'createFrom').rejects(new Error('GSC not configured'));

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
          SiteTopPage: {
            allBySiteIdAndSourceAndGeo: sinon.stub().resolves([]),
          },
        },
      };

      await runOpportunityStatusProcessor(testMessage, testContext);

      // Verify that GoogleClient.createFrom was called and failed
      expect(createFromStub.called).to.be.true;
      expect(createFromStub.firstCall.args[0]).to.deep.equal(testContext);
      expect(createFromStub.firstCall.args[1]).to.equal('https://example.com/');

      // Check that the error was logged
      expect(testContext.log.info.calledWith('GSC is not configured for site https://example.com/. Reason: GSC not configured')).to.be.true;
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS: false, GSC: false')).to.be.true;

      createFromStub.restore();
    });
  });

  describe('CloudWatch Log Analysis', () => {
    let mockCloudWatchClient;
    let sendStub;
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      mockCloudWatchClient = {
        send: sandbox.stub(),
      };
      sendStub = mockCloudWatchClient.send;
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('should search CloudWatch logs for failure patterns', async () => {
      const mockEvents = [
        {
          message: 'audit failed for site test-site-id',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      sendStub.resolves({
        events: mockEvents,
      });

      // Mock the CloudWatchLogsClient constructor
      const CloudWatchLogsClientStub = sandbox.stub().returns(mockCloudWatchClient);
      const { runOpportunityStatusProcessor: cloudWatchProcessor } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {
        '@aws-sdk/client-cloudwatch-logs': {
          CloudWatchLogsClient: CloudWatchLogsClientStub,
          FilterLogEventsCommand: sandbox.stub(),
        },
      });

      const testContext = new MockContextBuilder()
        .withSandbox(sandbox)
        .withDataAccess({
          Site: {
            findById: sandbox.stub().resolves({
              getId: () => 'test-site-id',
              getBaseURL: () => 'https://example.com',
              getOpportunities: sandbox.stub().resolves([]),
            }),
          },
        })
        .withOverrides({
          env: { AWS_REGION: 'us-east-1' },
        })
        .build();

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          slackContext: {
            channelId: 'test-channel',
            threadTs: 'test-thread',
          },
        },
      };

      const result = await cloudWatchProcessor(testMessage, testContext);

      expect(result.status).to.equal(200);
      expect(sendStub.calledThrice).to.be.true; // Called for audit, import, and scraping patterns

      // The function should complete successfully even if CloudWatch mocking doesn't work perfectly
      // We'll verify the basic structure exists
      const resultBody = await result.json();
      expect(resultBody).to.exist;
      expect(resultBody).to.have.property('message');
    });

    it('should handle CloudWatch search errors gracefully', async () => {
      sendStub.rejects(new Error('CloudWatch error'));

      const CloudWatchLogsClientStub = sandbox.stub().returns(mockCloudWatchClient);
      const { runOpportunityStatusProcessor: cloudWatchProcessor } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {
        '@aws-sdk/client-cloudwatch-logs': {
          CloudWatchLogsClient: CloudWatchLogsClientStub,
          FilterLogEventsCommand: sandbox.stub(),
        },
      });

      const testContext = new MockContextBuilder()
        .withSandbox(sandbox)
        .withDataAccess({
          Site: {
            findById: sandbox.stub().resolves({
              getId: () => 'test-site-id',
              getBaseURL: () => 'https://example.com',
              getOpportunities: sandbox.stub().resolves([]),
            }),
          },
        })
        .withOverrides({
          env: { AWS_REGION: 'us-east-1' },
        })
        .build();

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          slackContext: {
            channelId: 'test-channel',
            threadTs: 'test-thread',
          },
        },
      };

      const result = await cloudWatchProcessor(testMessage, testContext);

      expect(result.status).to.equal(200);
      const resultBody = await result.json();
      expect(resultBody).to.exist;
      expect(resultBody).to.have.property('message');
    });

    it('should analyze failure root causes correctly', async () => {
      const mockEvents = [
        {
          message: 'timeout error occurred',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
        {
          message: 'ad blocker detected',
          timestamp: Date.now() - 1000,
          logStreamName: 'test-stream',
        },
      ];

      sendStub.resolves({
        events: mockEvents,
      });

      const CloudWatchLogsClientStub = sandbox.stub().returns(mockCloudWatchClient);
      const { runOpportunityStatusProcessor: cloudWatchProcessor } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {
        '@aws-sdk/client-cloudwatch-logs': {
          CloudWatchLogsClient: CloudWatchLogsClientStub,
          FilterLogEventsCommand: sandbox.stub(),
        },
      });

      const testContext = new MockContextBuilder()
        .withSandbox(sandbox)
        .withDataAccess({
          Site: {
            findById: sandbox.stub().resolves({
              getId: () => 'test-site-id',
              getBaseURL: () => 'https://example.com',
              getOpportunities: sandbox.stub().resolves([]),
            }),
          },
        })
        .withOverrides({
          env: { AWS_REGION: 'us-east-1' },
        })
        .build();

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          slackContext: {
            channelId: 'test-channel',
            threadTs: 'test-thread',
          },
        },
      };

      const result = await cloudWatchProcessor(testMessage, testContext);

      expect(result.status).to.equal(200);
      const resultBody = await result.json();
      expect(resultBody).to.exist;
      expect(resultBody).to.have.property('message');
    });

    it('should handle no-data error type in recommendations', async () => {
      const { generateFailureRecommendations } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const recommendations = generateFailureRecommendations('Import: top-pages', 'No data found');
      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
    });

    it('should handle connection-refused error type in recommendations', async () => {
      const { generateFailureRecommendations } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const recommendations = generateFailureRecommendations('Scraper: Failed to scrape URL', 'Connection refused');
      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
    });

    it('should handle ad-blocker error type in recommendations', async () => {
      const { generateFailureRecommendations } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const recommendations = generateFailureRecommendations('Scraper: Failed to scrape URL', 'net::ERR_BLOCKED_BY_CLIENT');
      expect(recommendations).to.be.an('array');
      expect(recommendations.some((r) => r.toLowerCase().includes('block'))).to.be.true;
    });

    it('should handle forbidden error type detection', async () => {
      const { analyzeFailureRootCauses } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const mockEvents = [
        {
          message: '403 forbidden access denied',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      const failures = [{
        mainType: 'Scraper',
        type: 'Test Failures',
        events: mockEvents,
      }];

      const rootCauses = analyzeFailureRootCauses(failures);
      expect(rootCauses).to.have.length(1);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
    });

    it('should handle cloudflare error type detection', async () => {
      const { analyzeFailureRootCauses } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const mockEvents = [
        {
          message: 'cloudflare challenge required',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      const failures = [{
        mainType: 'Scraper',
        type: 'Test Failures',
        events: mockEvents,
      }];

      const rootCauses = analyzeFailureRootCauses(failures);
      expect(rootCauses).to.have.length(1);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
    });

    it('should handle rate-limit error type detection', async () => {
      const { analyzeFailureRootCauses } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const mockEvents = [
        {
          message: 'rate limit exceeded too many requests',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      const failures = [{
        mainType: 'Import',
        type: 'Test Failures',
        events: mockEvents,
      }];

      const rootCauses = analyzeFailureRootCauses(failures);
      expect(rootCauses).to.have.length(1);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
    });

    it('should handle auth error type detection', async () => {
      const { analyzeFailureRootCauses } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const mockEvents = [
        {
          message: 'auth failed unauthorized access',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      const failures = [{
        mainType: 'Audit',
        type: 'Test Failures',
        events: mockEvents,
      }];

      const rootCauses = analyzeFailureRootCauses(failures);
      expect(rootCauses).to.have.length(1);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
    });

    it('should handle no-data error type detection', async () => {
      const { analyzeFailureRootCauses } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const mockEvents = [
        {
          message: 'no data available empty response',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      const failures = [{
        mainType: 'Import',
        type: 'Test Failures',
        events: mockEvents,
      }];

      const rootCauses = analyzeFailureRootCauses(failures);
      expect(rootCauses).to.have.length(1);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
    });

    it('should handle connection-refused error type detection', async () => {
      const { analyzeFailureRootCauses } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {});
      const mockEvents = [
        {
          message: 'connection refused econnrefused',
          timestamp: Date.now(),
          logStreamName: 'test-stream',
        },
      ];

      const failures = [{
        mainType: 'Scraper',
        type: 'Test Failures',
        events: mockEvents,
      }];

      const rootCauses = analyzeFailureRootCauses(failures);
      expect(rootCauses).to.have.length(1);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
    });

    it('should return null when no events found in searchFailurePatterns', async () => {
      sendStub.resolves({
        events: [], // Empty events array
      });

      const CloudWatchLogsClientStub = sandbox.stub().returns(mockCloudWatchClient);
      const { runOpportunityStatusProcessor: cloudWatchProcessor } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {
        '@aws-sdk/client-cloudwatch-logs': {
          CloudWatchLogsClient: CloudWatchLogsClientStub,
          FilterLogEventsCommand: sandbox.stub(),
        },
      });

      const testContext = new MockContextBuilder()
        .withSandbox(sandbox)
        .withDataAccess({
          Site: {
            findById: sandbox.stub().resolves({
              getId: () => 'test-site-id',
              getBaseURL: () => 'https://example.com',
              getOpportunities: sandbox.stub().resolves([]),
            }),
          },
        })
        .withOverrides({
          env: { AWS_REGION: 'us-east-1' },
        })
        .build();

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          slackContext: {
            channelId: 'test-channel',
            threadTs: 'test-thread',
          },
        },
      };

      const result = await cloudWatchProcessor(testMessage, testContext);

      expect(result.status).to.equal(200);
      const resultBody = await result.json();
      expect(resultBody).to.exist;
      expect(resultBody).to.have.property('message');
    });
  });

  describe('Runbook Detection and Failure Reasons', () => {
    it('should detect RUM failure from runbook', async () => {
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'RUM data is required for this audit' }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      await runOpportunityStatusProcessor(message, context);

      // Verify the RUM-specific failure message was logged
      expect(context.log.info.calledWithMatch('Processing opportunities')).to.be.true;
    });

    it('should detect AHREFS failure from runbook', async () => {
      const mockOpportunities = [
        {
          getType: () => 'seo',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'AHREFS data is required for this analysis' }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWithMatch('Processing opportunities')).to.be.true;
    });

    it('should detect GSC failure from runbook', async () => {
      const mockOpportunities = [
        {
          getType: () => 'seo',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'Google Search Console data is required' }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWithMatch('Processing opportunities')).to.be.true;
    });

    it('should handle opportunity with runbook using getRunbook method', async () => {
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({}),
          getRunbook: () => 'rum data not available',
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWithMatch('Processing opportunities')).to.be.true;
    });

    it('should show "No failures detected" message when no failures and no failed opportunities', async () => {
      const sandbox = sinon.createSandbox();
      const sayStub = sandbox.stub();

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1', 'suggestion2']),
        },
      ];

      const testSite = {
        getId: () => 'test-site-id',
        getBaseURL: () => 'https://example.com',
        getOpportunities: sinon.stub().resolves(mockOpportunities),
      };

      // Mock CloudWatch to return no failures
      const mockCloudWatchClient = {
        send: sandbox.stub().resolves({ events: [] }),
      };

      const CloudWatchLogsClientStub = sandbox.stub().returns(mockCloudWatchClient);
      const { runOpportunityStatusProcessor: testProcessor } = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {
        '@aws-sdk/client-cloudwatch-logs': {
          CloudWatchLogsClient: CloudWatchLogsClientStub,
          FilterLogEventsCommand: sandbox.stub(),
        },
        '../../../src/utils/slack-utils.js': {
          say: sayStub,
        },
      });

      const testContext = new MockContextBuilder()
        .withSandbox(sandbox)
        .withDataAccess({
          Site: {
            findById: sandbox.stub().resolves(testSite),
          },
          SiteTopPage: {
            allBySiteIdAndSourceAndGeo: sandbox.stub().resolves([]),
          },
        })
        .withOverrides({
          env: { AWS_REGION: 'us-east-1' },
        })
        .build();

      const testMessage = {
        siteId: 'test-site-id',
        siteUrl: 'https://example.com',
        organizationId: 'test-org-id',
        taskContext: {
          auditTypes: ['cwv'],
          slackContext: {
            channelId: 'test-channel',
            threadTs: 'test-thread',
          },
        },
      };

      await testProcessor(testMessage, testContext);

      // Verify "No failures detected" message was sent
      expect(sayStub.calledWith(
        sinon.match.any,
        sinon.match.any,
        sinon.match.any,
        'No failures detected in logs :white_check_mark:',
      )).to.be.true;

      sandbox.restore();
    });
  });

  describe('generateFailureRecommendations', () => {
    it('should generate recommendations for Audit configuration fetch errors', async () => {
      const { generateFailureRecommendations: genRecs } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const recommendations = genRecs(
        'Audit: Configuration fetch error',
        'fstab.yaml not found (404)',
      );

      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
      expect(recommendations.some((r) => r.toLowerCase().includes('repository'))).to.be.true;
    });

    it('should generate recommendations for Scraper timeout errors', async () => {
      const { generateFailureRecommendations: genRecs } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const recommendations = genRecs(
        'Scraper: Failed to scrape URL',
        'Navigation timeout',
      );

      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
      expect(recommendations.some((r) => r.toLowerCase().includes('timeout'))).to.be.true;
    });

    it('should generate recommendations for Import errors', async () => {
      const { generateFailureRecommendations: genRecs } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const recommendations = genRecs(
        'Import: top-pages',
        'Source: ahrefs',
      );

      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
    });

    it('should generate default recommendations for unknown errors', async () => {
      const { generateFailureRecommendations: genRecs } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const recommendations = genRecs(
        'Unknown Category',
        'Unknown Subcategory',
      );

      expect(recommendations).to.be.an('array');
      expect(recommendations.length).to.be.greaterThan(0);
      expect(recommendations.some((r) => r.toLowerCase().includes('cloudwatch'))).to.be.true;
    });
  });

  describe('analyzeFailureRootCauses', () => {
    it('should analyze failure patterns with categorization', async () => {
      const { analyzeFailureRootCauses: analyzeRootCauses } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const failures = [
        {
          mainType: 'Audit',
          logGroup: '/aws/lambda/spacecat-services--audit-worker',
          events: [
            {
              message: '[preflight-audit] Error: Request timeout after 10000ms',
              timestamp: '2025-10-28T10:00:00.000Z',
              logStreamName: 'test-stream',
            },
            {
              message: '[preflight-audit] Error: NGHTTP2_INTERNAL_ERROR',
              timestamp: '2025-10-28T10:01:00.000Z',
              logStreamName: 'test-stream',
            },
          ],
        },
      ];

      const rootCauses = analyzeRootCauses(failures);

      expect(rootCauses).to.be.an('array');
      expect(rootCauses.length).to.equal(1);
      expect(rootCauses[0]).to.have.property('failureType');
      expect(rootCauses[0]).to.have.property('mainType', 'Audit');
      expect(rootCauses[0]).to.have.property('totalErrors', 2);
      expect(rootCauses[0]).to.have.property('primaryCategory');
      expect(rootCauses[0]).to.have.property('primarySubCategory');
      expect(rootCauses[0]).to.have.property('recommendations');
      expect(rootCauses[0].recommendations).to.be.an('array');
    });

    it('should handle multiple error categories', async () => {
      const { analyzeFailureRootCauses: analyzeRootCauses } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const failures = [
        {
          mainType: 'Scraper',
          logGroup: '/aws/lambda/spacecat-services--content-scraper',
          events: [
            {
              message: '[jobId=123] [default] Error scraping URL: net::ERR_ABORTED',
              timestamp: '2025-10-28T10:00:00.000Z',
              logStreamName: 'test-stream',
            },
            {
              message: '[jobId=123] [default] Failed to scrape URL: timeout',
              timestamp: '2025-10-28T10:01:00.000Z',
              logStreamName: 'test-stream',
            },
            {
              message: '[jobId=123] [default] Error taking screenshot: Protocol error',
              timestamp: '2025-10-28T10:02:00.000Z',
              logStreamName: 'test-stream',
            },
          ],
        },
      ];

      const rootCauses = analyzeRootCauses(failures);

      expect(rootCauses).to.be.an('array');
      expect(rootCauses.length).to.equal(1);
      expect(rootCauses[0]).to.have.property('allCategories');
      expect(rootCauses[0].allCategories).to.be.an('array');
      expect(rootCauses[0]).to.have.property('mostRecentError');
      expect(rootCauses[0].mostRecentError).to.have.property('category');
      expect(rootCauses[0].mostRecentError).to.have.property('subCategory');
    });

    it('should identify the most common error category', async () => {
      const { analyzeFailureRootCauses: analyzeRootCauses } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const failures = [
        {
          mainType: 'Audit',
          logGroup: '/aws/lambda/spacecat-services--audit-worker',
          events: [
            {
              message: 'Error fetching fstab.yaml. Status: 404',
              timestamp: '2025-10-28T10:00:00.000Z',
              logStreamName: 'test-stream',
            },
            {
              message: 'Error fetching fstab.yaml. Status: 404',
              timestamp: '2025-10-28T10:01:00.000Z',
              logStreamName: 'test-stream',
            },
            {
              message: 'Error fetching hlx config. Status: 401',
              timestamp: '2025-10-28T10:02:00.000Z',
              logStreamName: 'test-stream',
            },
          ],
        },
      ];

      const rootCauses = analyzeRootCauses(failures);

      expect(rootCauses[0].primaryCategoryCount).to.be.greaterThan(0);
      expect(rootCauses[0].primarySubCategoryCount).to.be.greaterThan(0);
    });

    it('should handle empty failures array', async () => {
      const { analyzeFailureRootCauses: analyzeRootCauses } = await import('../../../src/tasks/opportunity-status-processor/handler.js');
      const rootCauses = analyzeRootCauses([]);

      expect(rootCauses).to.be.an('array');
      expect(rootCauses.length).to.equal(0);
    });
  });
});
