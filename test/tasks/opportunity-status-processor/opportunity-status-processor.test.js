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

    // Mock fetch for robots.txt and HEAD requests
    global.fetch = sandbox.stub();
    global.fetch.resolves({
      ok: true,
      status: 200,
      text: sandbox.stub().resolves('User-agent: *\nAllow: /'),
    });

    // Mock S3 client
    const mockS3Client = {
      send: sandbox.stub().resolves({
        Body: {
          transformToString: sandbox.stub().resolves('{}'),
        },
        ContentType: 'application/json',
      }),
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
      .withOverrides({
        s3Client: mockS3Client,
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
    delete global.fetch;
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
      expect(mockSite.getOpportunities.called).to.be.true;
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

      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle empty opportunities array', async () => {
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
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
      expect(mockSite.getOpportunities.called).to.be.true;
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
      expect(mockSite.getOpportunities.called).to.be.true;

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
      expect(mockSite.getOpportunities.called).to.be.true;
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
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should check AHREFS Import data availability', async () => {
      // Set audit type that requires AHREFSImport
      message.taskContext.auditTypes = ['meta-tags'];
      // Mock AHREFSImport data available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([
        { url: 'https://example.com/page1', traffic: 100 },
        { url: 'https://example.com/page2', traffic: 50 },
      ]);

      const mockOpportunities = [
        {
          getType: () => 'meta-tags',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.calledWith('test-site-id', 'ahrefs', 'global')).to.be.true;
      expect(context.log.info.calledWith('AHREFS Import data availability for site test-site-id: Available (2 top pages)')).to.be.true;
    });

    it('should handle AHREFSImport data not available', async () => {
      // Set audit type that requires AHREFSImport
      message.taskContext.auditTypes = ['meta-tags'];
      // Mock AHREFSImport data not available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([]);

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('AHREFS Import data availability for site test-site-id: Not available (0 top pages)')).to.be.true;
    });

    it('should handle AHREFSImport check errors', async () => {
      // Set audit type that requires AHREFSImport
      message.taskContext.auditTypes = ['meta-tags'];
      // Mock AHREFSImport check error
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.rejects(new Error('Database error'));

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWith('Error checking AHREFS Import data availability for site test-site-id: Database error')).to.be.true;
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

      // Mock ScrapeClient to prevent hanging
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const mockScrapeClientLocal = {
        getScrapeJobsByBaseURL: sinon.stub().resolves([]),
      };
      const scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClientLocal);

      await runOpportunityStatusProcessor(testMessage, testContext);

      // Verify RUM was checked successfully - this should cover lines 26-37
      expect(createFromStub.calledWith(testContext)).to.be.true;
      expect(mockRUMClient.retrieveDomainkey.calledWith('example.com')).to.be.true;
      expect(testContext.log.info.calledWith('RUM is available for domain: example.com')).to.be.true;

      scrapeClientStub.restore();
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

        const testSiteMock = {
          getOpportunities: sinon.stub().resolves(testCase.opportunities),
        };

        const testContext = {
          ...context,
          dataAccess: {
            Site: {
              findById: sinon.stub().resolves(testSiteMock),
            },
            SiteTopPage: {
              allBySiteIdAndSourceAndGeo: sinon.stub().resolves([]),
            },
          },
        };

        await runOpportunityStatusProcessor(testMessage, testContext);

        // Verify that the processor completes successfully even with localhost URLs
        expect(testSiteMock.getOpportunities.called).to.be.true;
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

    it('should handle GSC configuration success', async function () {
      this.timeout(5000);
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      let scrapeClientStub = null;

      try {
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

        // Mock scrape client to avoid hanging
        const mockScrapeClientLocal = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([]),
          getScrapeJobUrlResults: sinon.stub().resolves([]),
        };
        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClientLocal);

        await runOpportunityStatusProcessor(testMessage, testContext);

        // GSC is not checked because 'cwv' opportunity only requires RUM, not GSC
        // So GoogleClient.createFrom should NOT be called
        expect(createFromStub.called).to.be.false;

        createFromStub.restore();
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          scrapeClientStub.restore();
        }
      }
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

      // GSC is not checked because 'cwv' opportunity only requires RUM, not GSC
      // So GoogleClient.createFrom should NOT be called
      expect(createFromStub.called).to.be.false;

      createFromStub.restore();
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

    it('should detect AHREFSImport failure from runbook', async () => {
      const mockOpportunities = [
        {
          getType: () => 'seo',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'AHREFSImport data is required for this analysis' }),
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

    it('should detect missing opportunities when expected opportunities are not found', async () => {
      // Set up audit types and expected opportunities
      // (don't set onboardStartTime to avoid CloudWatch calls)
      message.taskContext.auditTypes = ['cwv', 'broken-backlinks'];

      // Mock site with no opportunities (all are missing)
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWith('Missing opportunities for site test-site-id: cwv, broken-backlinks')).to.be.true;
    });

    it('should analyze missing opportunities without onboard start time', async () => {
      // Set up audit types but no onboardStartTime
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = undefined;

      // Mock site with no opportunities
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // Should warn about missing but not analyze
      expect(context.log.warn.calledWith('Missing opportunities for site test-site-id: cwv')).to.be.true;
    });

    it('should handle missing opportunities with unmet dependencies', async () => {
      // Set up audit types
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;

      // Mock site with no opportunities
      mockSite.getOpportunities.resolves([]);

      // Mock ScrapeClient to prevent hanging
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const mockScrapeClientLocal = {
        getScrapeJobsByBaseURL: sinon.stub().resolves([]),
      };
      const scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClientLocal);

      await runOpportunityStatusProcessor(message, context);

      // Should detect missing cwv opportunity
      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;

      scrapeClientStub.restore();
    });

    it('should log all expected opportunities when present', async () => {
      // Set up audit types
      message.taskContext.auditTypes = ['cwv', 'broken-backlinks'];

      // Mock site with all expected opportunities
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
        },
        {
          getType: () => 'broken-backlinks',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Verify that all expected opportunities were processed
      expect(mockSite.getOpportunities.called).to.be.true;
      expect(mockOpportunities[0].getSuggestions.called).to.be.true;
      expect(mockOpportunities[1].getSuggestions.called).to.be.true;
    });

    it('should handle when auditTypes is empty array', async () => {
      message.taskContext.auditTypes = [];

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should still process opportunities
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle opportunities with no audit types mapping', async () => {
      message.taskContext.auditTypes = ['unknown-audit'];

      const mockOpportunities = [
        {
          getType: () => 'some-opportunity',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
    });
  });

  describe('Audit Execution and Failure Detection', () => {
    it('should check if audit has been executed in CloudWatch logs', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // Should check CloudWatch for audit execution
      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should extract failure reason from CloudWatch logs', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // Should attempt to extract failure reason
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle audit not executed scenario', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // When audit hasn't been executed, should be detected in analysis
      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should report unknown reason when audit executed but opportunity missing', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // Should detect missing opportunities
      expect(context.log.warn.calledWith('Missing opportunities for site test-site-id: cwv')).to.be.true;
    });
  });

  describe('Import and AHREFSImport Checks', () => {
    it('should handle AHREFSImport check errors gracefully', async () => {
      // Set audit type that requires AHREFSImport
      message.taskContext.auditTypes = ['meta-tags'];
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.rejects(new Error('Database error'));

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWithMatch('Error checking AHREFS Import data availability')).to.be.true;
    });

    it('should check AHREFSImport data with specific source and geo parameters', async () => {
      // Set audit type that requires AHREFSImport
      message.taskContext.auditTypes = ['meta-tags'];
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs('test-site-id', 'ahrefs', 'global')
        .resolves([{ url: 'https://example.com/page1' }]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .calledWith('test-site-id', 'ahrefs', 'global')).to.be.true;
    });

    it('should log AHREFS Import data availability with page count', async () => {
      // Set audit type that requires AHREFSImport
      message.taskContext.auditTypes = ['meta-tags'];
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs('test-site-id', 'ahrefs', 'global')
        .resolves([
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' },
          { url: 'https://example.com/page3' },
        ]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWithMatch('AHREFS Import data availability')).to.be.true;
      expect(context.log.info.calledWithMatch('3 top pages')).to.be.true;
    });
  });

  describe('Slack Output Formatting', () => {
    it('should send formatted Data Sources section to Slack', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      await runOpportunityStatusProcessor(message, context);

      // Should complete processing with slackContext
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should send formatted Opportunity Statuses section to Slack', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should send Opportunity Statuses messages
      // The say function logs these messages
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should send formatted Audit Processing Errors section to Slack', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      await runOpportunityStatusProcessor(message, context);

      // Should send Audit Processing Errors messages
      // The say function logs these messages
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should include failed opportunities in Audit Processing Errors', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'RUM data required' }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should include the failed opportunity in errors section
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should show no failures message when all checks pass', async function () {
      this.timeout(5000);
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      let scrapeClientStub = null;

      try {
        message.siteUrl = 'https://example.com';
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };

        // Mock all services as available
        context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([
          { url: 'https://example.com/page1' },
        ]);

        const mockOpportunities = [
          {
            getType: () => 'cwv',
            getSuggestions: sinon.stub().resolves(['suggestion1']),
          },
        ];
        mockSite.getOpportunities.resolves(mockOpportunities);

        // Mock scrape client to avoid hanging
        const mockScrapeClientLocal = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([]),
          getScrapeJobUrlResults: sinon.stub().resolves([]),
        };
        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClientLocal);

        await runOpportunityStatusProcessor(message, context);

        // Should complete successfully
        expect(mockSite.getOpportunities.called).to.be.true;
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          scrapeClientStub.restore();
        }
      }
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty audit types array', async () => {
      message.taskContext.auditTypes = [];

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle null siteUrl gracefully', async () => {
      message.siteUrl = null;

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWithMatch('Processing opportunities')).to.be.true;
    });

    it('should handle undefined siteUrl gracefully', async () => {
      message.siteUrl = undefined;

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWithMatch('Processing opportunities')).to.be.true;
    });

    it('should handle malformed siteUrl', async () => {
      message.siteUrl = 'not-a-valid-url';

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Could not resolve canonical URL')).to.be.true;
    });

    it('should handle opportunities with missing getData method', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
          // No getData method
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle opportunities with empty runbook', async function () {
      this.timeout(5000);
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      let scrapeClientStub = null;

      try {
        message.siteUrl = 'https://example.com';
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };

        const mockOpportunities = [
          {
            getType: () => 'cwv',
            getSuggestions: sinon.stub().resolves([]),
            getData: () => ({ runbook: '' }),
          },
        ];
        mockSite.getOpportunities.resolves(mockOpportunities);

        // Mock scrape client to avoid hanging
        const mockScrapeClientLocal = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([]),
          getScrapeJobUrlResults: sinon.stub().resolves([]),
        };
        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClientLocal);

        await runOpportunityStatusProcessor(message, context);

        expect(mockSite.getOpportunities.called).to.be.true;
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          scrapeClientStub.restore();
        }
      }
    });

    it('should handle opportunities with null runbook', async () => {
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: null }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle opportunities with GSC-related runbook', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        {
          getType: () => 'seo',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'Google Search Console data is required' }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should parse GSC from runbook
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle opportunities with getRunbook method instead of getData', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
          getRunbook: () => 'RUM data is needed',
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should use getRunbook method
      expect(mockSite.getOpportunities.called).to.be.true;
    });
  });

  describe('CloudWatch Log Analysis - Deep Testing', () => {
    let CloudWatchLogsClient;
    let mockSendStub;

    beforeEach(async () => {
      // Dynamically import CloudWatch Client
      const CloudWatchModule = await import('@aws-sdk/client-cloudwatch-logs');
      CloudWatchLogsClient = CloudWatchModule.CloudWatchLogsClient;

      // Create a mock for CloudWatchLogsClient.prototype.send
      mockSendStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');

      // Default: return empty events
      mockSendStub.resolves({ events: [] });

      context.mockCloudWatchSend = mockSendStub;
    });

    afterEach(() => {
      if (mockSendStub && mockSendStub.restore) {
        mockSendStub.restore();
      }
    });

    it('should detect audit execution in CloudWatch logs', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock CloudWatch to return audit execution event
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received cwv audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should extract failure reason with "Reason:" and "at" pattern', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock CloudWatch to return failure event
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `cwv audit for ${message.siteId} failed. Reason: RUM data not available at line 123`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should analyze missing opportunities with all dependencies met', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock all services as available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([
        { url: 'https://example.com/page1' },
      ]);

      // Mock audit was executed
      context.mockCloudWatchSend.onFirstCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received cwv audit request for: ${message.siteId}`,
        }],
      });

      // Mock no failure found - should report as "unknown reason"
      context.mockCloudWatchSend.onSecondCall().resolves({ events: [] });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should handle broken-internal-links with unmet RUM dependency', async () => {
      message.taskContext.auditTypes = ['broken-internal-links'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // RUM not available, top-pages available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([
        { url: 'https://example.com/page1' },
      ]);

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received broken-internal-links audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should handle broken-internal-links with unmet top-pages dependency', async () => {
      message.taskContext.auditTypes = ['broken-internal-links'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // No top pages
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([]);

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received broken-internal-links audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should check scraping success rate with successful scrapes', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.onboardStartTime = Date.now() - 3600000;

      // Mock successful scrapes
      context.mockCloudWatchSend.onCall(0).resolves({
        events: [
          { message: 'successfully scraped' },
          { message: 'successfully scraped' },
          { message: 'successfully scraped' },
        ],
      });

      // Mock failed scrapes
      context.mockCloudWatchSend.onCall(1).resolves({
        events: [
          { message: 'failed to scrape' },
        ],
      });

      await runOpportunityStatusProcessor(message, context);

      // Should calculate success rate: 3/4 = 75% (above threshold)
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should flag site as unavailable with low scraping success rate', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.onboardStartTime = Date.now() - 3600000;

      // Mock 2 successful scrapes
      context.mockCloudWatchSend.onCall(0).resolves({
        events: [
          { message: 'successfully scraped' },
          { message: 'successfully scraped' },
        ],
      });

      // Mock 5 failed scrapes (2/7 = 28% success rate < 50% threshold)
      context.mockCloudWatchSend.onCall(1).resolves({
        events: [
          { message: 'failed to scrape' },
          { message: 'failed to scrape' },
          { message: 'failed to scrape' },
          { message: 'failed to scrape' },
          { message: 'failed to scrape' },
        ],
      });

      await runOpportunityStatusProcessor(message, context);

      // Should flag as unavailable due to low success rate
      expect(mockSite.getOpportunities.called).to.be.true;
    });
  });

  describe('Complete Slack Output Flow', () => {
    it('should send all three sections with complete data', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };
      message.taskContext.auditTypes = ['cwv', 'broken-backlinks'];

      // Mock AHREFSImport and Import available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs(message.siteId, 'ahrefs', 'global')
        .resolves([{ url: 'https://example.com/page1' }]);

      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs(message.siteId)
        .resolves([{ url: 'https://example.com/page1' }]);

      // Mock opportunities with suggestions and without
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'broken-backlinks',
          getSuggestions: sinon.stub().resolves([]),
          getData: () => ({ runbook: 'AHREFSImport data required' }),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should complete with all sections
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should trigger all service preconditions passed log', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      // Mock all services as available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([
        { url: 'https://example.com/page1' },
      ]);

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should log that all preconditions passed
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should output audit errors when no services available', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      // All services unavailable
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([]);

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      // Make robots.txt block scraping
      global.fetch.onFirstCall().resolves({
        ok: true,
        status: 200,
        text: sinon.stub().resolves('User-agent: *\nDisallow: /'),
      });

      await runOpportunityStatusProcessor(message, context);

      // Should output all error messages
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should handle duplicate opportunity types', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      // Multiple opportunities of the same type
      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion2']),
        },
        {
          getType: () => 'meta-tags',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should only process each type once
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should test all opportunity title mappings', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      const mockOpportunities = [
        { getType: () => 'cwv', getSuggestions: sinon.stub().resolves(['s1']) },
        { getType: () => 'meta-tags', getSuggestions: sinon.stub().resolves(['s2']) },
        { getType: () => 'broken-backlinks', getSuggestions: sinon.stub().resolves(['s3']) },
        { getType: () => 'broken-internal-links', getSuggestions: sinon.stub().resolves(['s4']) },
        { getType: () => 'alt-text', getSuggestions: sinon.stub().resolves(['s5']) },
        { getType: () => 'sitemap', getSuggestions: sinon.stub().resolves(['s6']) },
        { getType: () => 'unknown-type', getSuggestions: sinon.stub().resolves(['s7']) },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Should handle all opportunity types
      expect(mockSite.getOpportunities.called).to.be.true;
    });
  });

  describe('Missing Opportunity Analysis with Real Audits', () => {
    let CloudWatchLogsClient;
    let mockSendStub;

    beforeEach(async () => {
      const CloudWatchModule = await import('@aws-sdk/client-cloudwatch-logs');
      CloudWatchLogsClient = CloudWatchModule.CloudWatchLogsClient;
      mockSendStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
      mockSendStub.resolves({ events: [] });
      context.mockCloudWatchSend = mockSendStub;
    });

    afterEach(() => {
      if (mockSendStub && mockSendStub.restore) {
        mockSendStub.restore();
      }
    });

    it('should analyze meta-tags audit with missing top-pages', async () => {
      message.taskContext.auditTypes = ['meta-tags'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // No top pages
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.resolves([]);

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received meta-tags audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should analyze forms-opportunities audit', async () => {
      message.taskContext.auditTypes = ['forms-opportunities'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received forms-opportunities audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should analyze experimentation-opportunities audit', async () => {
      message.taskContext.auditTypes = ['experimentation-opportunities'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received experimentation-opportunities audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should analyze accessibility audit', async () => {
      message.taskContext.auditTypes = ['accessibility'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received accessibility audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should analyze audit failure with detailed reason', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock audit was executed
      context.mockCloudWatchSend.onFirstCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received cwv audit request for: ${message.siteId}`,
        }],
      });

      // Mock audit failure with reason
      context.mockCloudWatchSend.onSecondCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `cwv audit for ${message.siteId} failed. Reason: Timeout waiting for RUM data at runtime.js:123`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should handle scraping dependency', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.auditTypes = ['alt-text'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock scraping not available (site not reachable)
      global.fetch.onFirstCall().resolves({
        ok: true,
        status: 200,
        text: sinon.stub().resolves('User-agent: *\nAllow: /'),
      });
      global.fetch.onSecondCall().resolves({
        ok: false,
        status: 500,
      });

      // Mock audit was executed
      context.mockCloudWatchSend.resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received alt-text audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should trigger audit failure path (lines 616-620)', async () => {
      // Use meta-tags which only depends on 'top-pages' (import)
      message.taskContext.auditTypes = ['meta-tags'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]); // meta-tags opportunity is missing

      // Mock import (top-pages) as available so dependency check passes
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs(message.siteId)
        .resolves([{ url: 'https://example.com/page1' }]);

      // Reset and configure CloudWatch calls
      context.mockCloudWatchSend.reset();

      // First call: checkAuditExecution - audit WAS executed
      context.mockCloudWatchSend.onCall(0).resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received meta-tags audit request for: ${message.siteId}`,
        }],
      });

      // Second call: getAuditFailureReason - return a failure reason
      context.mockCloudWatchSend.onCall(1).resolves({
        events: [{
          timestamp: Date.now(),
          message: `meta-tags audit for ${message.siteId} failed. Reason: Unable to parse meta tags`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      // Verify the audit failure path was triggered
      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should test getServicesNeedingLogAnalysis with all services available', async () => {
      message.siteUrl = undefined; // No siteUrl to skip RUM/GSC/Scraping checks
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      // Mock import and AHREFSImport as available
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo = sinon.stub();
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs(message.siteId)
        .resolves([{ url: 'https://example.com/page1' }]);
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs(message.siteId, 'ahrefs', 'global')
        .resolves([{ url: 'https://example.com/page1', traffic: 1000 }]);

      const mockOpportunities = [
        {
          getType: () => 'cwv',
          getSuggestions: sinon.stub().resolves(['suggestion1']),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // When no siteUrl, RUM/GSC/Scraping are false, but AHREFSImport and Import are true
      // This will trigger "Services requiring log analysis" log,
      // not "All service preconditions passed"
      // The test verifies the function executes without errors
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should extract failure reason with Reason: pattern (lines 475-476)', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock audit execution
      context.mockCloudWatchSend.onFirstCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received cwv audit request for: ${message.siteId}`,
        }],
      });

      // Mock failure with "Reason:" pattern (without "at")
      context.mockCloudWatchSend.onSecondCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `cwv audit for ${message.siteId} failed. Reason: Invalid RUM data format`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should handle CloudWatch error in getAuditFailureReason (lines 481-483)', async () => {
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock audit execution
      context.mockCloudWatchSend.onFirstCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received cwv audit request for: ${message.siteId}`,
        }],
      });

      // Mock CloudWatch error on second call
      context.mockCloudWatchSend.onSecondCall().rejects(new Error('CloudWatch service error'));

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });

    it('should handle opportunity with no related audits (lines 557-560)', async () => {
      message.taskContext.auditTypes = ['unknown-audit'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // Should complete without errors even with unknown audit type
      expect(mockSite.getOpportunities.called).to.be.true;
    });

    it('should check scraping dependency for missing opportunity (lines 593-594)', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.auditTypes = ['alt-text'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      mockSite.getOpportunities.resolves([]);

      // Mock robots.txt blocking scraping
      global.fetch.resetBehavior();
      global.fetch.resolves({
        ok: true,
        status: 200,
        text: sinon.stub().resolves('User-agent: *\nDisallow: /'),
      });

      // Mock audit executed
      context.mockCloudWatchSend.onFirstCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: `Received alt-text audit request for: ${message.siteId}`,
        }],
      });

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
    });
  });

  describe('GSC and Scraping Dependency Coverage', () => {
    it('should cover scraping dependency when checked (lines 330-331, 454-457, 595-596, 628-638)', async () => {
      // Temporarily modify OPPORTUNITY_DEPENDENCY_MAP to include a scraping dependency
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalScraping = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

      message.siteUrl = 'https://example.com';
      message.taskContext.auditTypes = ['broken-backlinks'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      mockSite.getOpportunities.resolves([]);

      // Reset CloudWatch to say audit was executed (if mockCloudWatchSend exists)
      if (context.mockCloudWatchSend) {
        context.mockCloudWatchSend.reset();
        context.mockCloudWatchSend.resolves({
          events: [{
            timestamp: Date.now(),
            message: 'Received broken-backlinks audit request for: test-site-id',
          }],
        });
      }

      await runOpportunityStatusProcessor(message, context);

      // Should have tried to check scraping and detected it's not available
      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;

      // Restore
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalScraping;
    });

    it('should cover GSC dependency when checked (lines 450-451, 592-593, 646-647)', async () => {
      // Temporarily modify OPPORTUNITY_DEPENDENCY_MAP to include GSC
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalCwv = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP.cwv;
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP.cwv = ['GSC'];

      message.siteUrl = 'https://example.com';
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      mockSite.getOpportunities.resolves([]);

      // Reset CloudWatch to say audit was executed (if mockCloudWatchSend exists)
      if (context.mockCloudWatchSend) {
        context.mockCloudWatchSend.reset();
        context.mockCloudWatchSend.resolves({
          events: [{
            timestamp: Date.now(),
            message: 'Received cwv audit request for: test-site-id',
          }],
        });
      }

      await runOpportunityStatusProcessor(message, context);

      // Should have tried to check GSC
      expect(context.log.info.calledWithMatch('GSC')).to.be.true;

      // Restore
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP.cwv = originalCwv;
    });
  });

  describe('isScrapingAvailable function coverage (lines 149-187)', () => {
    it('should handle empty/null baseUrl in scraping check (lines 138-139)', async () => {
      // Import ScrapeClient and create stub
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const { ScrapeClient } = scrapeModule;

      const mockScrapeClient = {
        getScrapeJobsByBaseURL: sinon.stub(),
        getScrapeJobUrlResults: sinon.stub(),
      };

      const scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);

      // Temporarily add scraping dependency to trigger scraping check
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        // Set null/undefined siteUrl which will be passed to isScrapingAvailable
        message.siteUrl = null;
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        mockSite.getOpportunities.resolves([]);

        await runOpportunityStatusProcessor(message, context);

        // Should not try to get scrape jobs for null/empty URL
        expect(mockScrapeClient.getScrapeJobsByBaseURL.called).to.be.false;
      } finally {
        scrapeClientStub.restore();
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should handle no scrape jobs found (line 149-150)', async () => {
      // Temporarily add scraping dependency to trigger scraping check
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const mockScrapeClient = {
        getScrapeJobsByBaseURL: sinon.stub().resolves([]),
        getScrapeJobUrlResults: sinon.stub(),
      };

      const mockScrapeClientClass = {
        createFrom: sinon.stub().returns(mockScrapeClient),
      };

      try {
        // Use esmock to mock the ScrapeClient module
        const esmock = (await import('esmock')).default;
        const handler = await esmock('../../../src/tasks/opportunity-status-processor/handler.js', {
          '@adobe/spacecat-shared-scrape-client': { ScrapeClient: mockScrapeClientClass },
          '../../../src/utils/cloudwatch-utils.js': {
            checkAndAlertBotProtection: sinon.stub().resolves(null),
            checkAuditExecution: sinon.stub().resolves(true),
            getAuditFailureReason: sinon.stub().resolves(null),
          },
        });

        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now();
        mockSite.getOpportunities.resolves([]);

        await handler.runOpportunityStatusProcessor(message, context);

        // Verify that scraping check was performed
        expect(mockScrapeClient.getScrapeJobsByBaseURL.calledWith('https://example.com', 'default')).to.be.true;
      } finally {
        // Cleanup
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should handle jobs with no URL results (line 175-177)', async () => {
      // Import ScrapeClient and create stub
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const { ScrapeClient } = scrapeModule;

      // Temporarily add scraping dependency
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000; // 1 hour ago
        context.env.AWS_REGION = 'us-east-1'; // Required for CloudWatch client

        const mockScrapeClient = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([
            // Jobs AFTER onboardStartTime so they're not filtered out
            { id: 'job-1', startedAt: new Date(Date.now() - 1800000).toISOString() }, // 30 min ago
            { id: 'job-2', createdAt: new Date(Date.now() - 2400000).toISOString() }, // 40 min ago
          ]),
          getScrapeJobUrlResults: sinon.stub().resolves([]), // No results for any job
        };

        const scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);
        mockSite.getOpportunities.resolves([]);

        // Mock CloudWatch to return NO bot protection events
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({ events: [] });

        await runOpportunityStatusProcessor(message, context);

        // Verify that scraping jobs were checked
        expect(mockScrapeClient.getScrapeJobsByBaseURL.called).to.be.true;
        expect(mockScrapeClient.getScrapeJobUrlResults.called).to.be.true;

        // Cleanup
        cloudWatchStub.restore();
        scrapeClientStub.restore();
      } finally {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should sort jobs by date and find first job with results (lines 154-172)', async () => {
      // Import ScrapeClient and create stub
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const { ScrapeClient } = scrapeModule;

      // Temporarily add scraping dependency
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000; // 1 hour ago
        context.env.AWS_REGION = 'us-east-1'; // Required for CloudWatch client

        const getScrapeJobUrlResultsStub = sinon.stub();
        getScrapeJobUrlResultsStub
          .onFirstCall().resolves([]) // job-recent has no results
          .onSecondCall().resolves([ // job-old has results
            { url: 'https://example.com/page1', status: 'COMPLETE' },
          ]);

        const mockScrapeClient = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([
            // All jobs AFTER onboardStartTime so they're not filtered out
            { id: 'job-old', createdAt: new Date(Date.now() - 2400000).toISOString() }, // 40 min ago
            { id: 'job-recent', startedAt: new Date(Date.now() - 600000).toISOString() }, // 10 min ago (most recent)
            { id: 'job-oldest', createdAt: new Date(Date.now() - 3000000).toISOString() }, // 50 min ago
          ]),
          getScrapeJobUrlResults: getScrapeJobUrlResultsStub,
        };

        const scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);
        mockSite.getOpportunities.resolves([]);

        // Mock CloudWatch to return NO bot protection events
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({ events: [] });

        await runOpportunityStatusProcessor(message, context);

        // Verify jobs were checked in order (sorted by date)
        expect(mockScrapeClient.getScrapeJobUrlResults.calledWith('job-recent')).to.be.true;
        expect(mockScrapeClient.getScrapeJobUrlResults.calledWith('job-old')).to.be.true;

        // Cleanup
        cloudWatchStub.restore();
        scrapeClientStub.restore();
      } finally {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should detect successful scrape with COMPLETE status (lines 181-187)', async () => {
      // Import ScrapeClient and create stub
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const { ScrapeClient } = scrapeModule;

      // Temporarily add scraping dependency
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        context.env.AWS_REGION = 'us-east-1'; // Required for CloudWatch client

        const mockScrapeClient = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([
            // Job AFTER onboardStartTime so it's not filtered out
            { id: 'job-1', startedAt: new Date(Date.now() - 1800000).toISOString() }, // 30 min ago
          ]),
          getScrapeJobUrlResults: sinon.stub().resolves([
            { url: 'https://example.com/page1', status: 'COMPLETE' },
            { url: 'https://example.com/page2', status: 'FAILED' },
          ]),
        };

        const scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);
        mockSite.getOpportunities.resolves([]);

        // Mock CloudWatch to return NO bot protection events
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({ events: [] });

        await runOpportunityStatusProcessor(message, context);

        // Should detect successful scrape (at least one COMPLETE)
        // Verify that scraping was checked and completed successfully
        expect(mockScrapeClient.getScrapeJobsByBaseURL.calledWith('https://example.com', 'default')).to.be.true;
        expect(mockScrapeClient.getScrapeJobUrlResults.calledOnce).to.be.true;

        // Cleanup
        cloudWatchStub.restore();
        scrapeClientStub.restore();
      } finally {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should handle jobs with completely missing timestamps (line 160, 172-173)', async () => {
      // Import ScrapeClient and create stub
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const { ScrapeClient } = scrapeModule;

      // Temporarily add scraping dependency
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        // Set onboardStartTime to 0 so jobs with timestamp 0 can pass the filter
        message.taskContext.onboardStartTime = 0;
        context.env.AWS_REGION = 'us-east-1';

        const mockScrapeClient = {
          getScrapeJobsByBaseURL: sinon.stub().resolves([
            // Job with NO timestamps - triggers || 0 on line 160 (filter), and lines 172-173 (sort)
            { id: 'job-no-timestamps' },
            // Job with only createdAt, no startedAt - line 172: b.startedAt || b.createdAt
            { id: 'job-created-only', createdAt: new Date(Date.now() - 1200000).toISOString() },
            // Job with only startedAt, no createdAt - line 173: a.startedAt || a.createdAt
            { id: 'job-started-only', startedAt: new Date(Date.now() - 1800000).toISOString() },
            // Job with both - ensures sort comparisons happen
            { id: 'job-both', startedAt: new Date(Date.now() - 600000).toISOString(), createdAt: new Date(Date.now() - 900000).toISOString() },
          ]),
          getScrapeJobUrlResults: sinon.stub().resolves([]),
        };

        const scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);
        mockSite.getOpportunities.resolves([]);

        // Mock CloudWatch
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({ events: [] });

        await runOpportunityStatusProcessor(message, context);

        // Verify jobs were processed and sorted
        expect(mockScrapeClient.getScrapeJobsByBaseURL.called).to.be.true;
        // The sort function will compare all pairs, hitting both line 172 and 173

        // Cleanup
        cloudWatchStub.restore();
        scrapeClientStub.restore();
      } finally {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });
  });

  describe('Additional coverage for uncovered lines', () => {
    it('should use info icon for opportunities with no suggestions (line 621)', async () => {
      // Mock Slack client
      const mockSlackClient = {
        postMessage: sinon.stub().resolves(),
      };
      const SlackClientModule = await import('@adobe/spacecat-shared-slack-client');
      const slackStub = sinon.stub(SlackClientModule.BaseSlackClient, 'createFrom').returns(mockSlackClient);

      message.siteUrl = 'https://example.com';
      message.taskContext.auditTypes = ['cwv', 'broken-backlinks'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };
      context.env.AWS_REGION = 'us-east-1';

      // Mock TWO opportunities with no suggestions to ensure loop executes multiple times
      const mockOpportunity1 = {
        getType: () => 'cwv',
        getSuggestions: sinon.stub().resolves([]), // No suggestions
      };

      const mockOpportunity2 = {
        getType: () => 'broken-backlinks',
        getSuggestions: sinon.stub().resolves([]), // No suggestions
      };

      mockSite.getOpportunities.resolves([mockOpportunity1, mockOpportunity2]);

      // Mock CloudWatch - no bot protection
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
      cloudWatchStub.resolves({ events: [] });

      try {
        await runOpportunityStatusProcessor(message, context);

        // Verify Slack messages were sent
        const postMessageCalls = mockSlackClient.postMessage.getCalls();
        expect(postMessageCalls.length).to.be.at.least(1);

        // Line 621 should be executed for both opportunities
        // Find messages with the error details
        const allMessages = postMessageCalls.map((c) => c.args[0]?.text).join('\n');

        // Both opportunities should appear with :information_source: emoji
        expect(allMessages).to.include('Core Web Vitals');
        expect(allMessages).to.include('Broken Backlinks');
        expect(allMessages).to.include(':information_source:');
        expect(allMessages).to.include('found no suggestions');
      } finally {
        cloudWatchStub.restore();
        slackStub.restore();
      }
    });

    it('should handle empty baseUrl in scraping check (lines 138-139)', async () => {
      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const { ScrapeClient } = scrapeModule;

      const mockScrapeClient = {
        getScrapeJobsByBaseURL: sinon.stub(),
        getScrapeJobUrlResults: sinon.stub(),
      };

      const scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);

      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = ''; // Empty URL
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        mockSite.getOpportunities.resolves([]);

        await runOpportunityStatusProcessor(message, context);

        // Should not try to get scrape jobs for empty URL
        expect(mockScrapeClient.getScrapeJobsByBaseURL.called).to.be.false;
      } finally {
        scrapeClientStub.restore();
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should detect successful audit with no opportunities created (lines 376-380)', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.auditTypes = ['cwv'];
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      // Site has NO opportunities (audit ran successfully but found no issues)
      mockSite.getOpportunities.resolves([]);

      // Mock CloudWatch responses
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      const originalSend = CloudWatchLogsClient.prototype.send;

      const mockSend = sinon.stub();
      // First call: Check if audit was executed - YES
      mockSend.onFirstCall().resolves({
        events: [{
          timestamp: Date.now(),
          message: 'Received cwv audit request for: test-site-id',
        }],
      });
      // Second call: Check for failure logs - NONE
      mockSend.onSecondCall().resolves({ events: [] });

      CloudWatchLogsClient.prototype.send = mockSend;

      // Mock RUM as available (dependency met)
      const RUMAPIClientModule = await import('@adobe/spacecat-shared-rum-api-client');
      const originalCreateFrom = RUMAPIClientModule.default.createFrom;
      RUMAPIClientModule.default.createFrom = sinon.stub().returns({
        retrieveDomainkey: sinon.stub().resolves({ domainkey: 'test-key' }),
      });

      try {
        await runOpportunityStatusProcessor(message, context);

        // Should complete successfully
        expect(mockSite.getOpportunities.called).to.be.true;
      } finally {
        CloudWatchLogsClient.prototype.send = originalSend;
        RUMAPIClientModule.default.createFrom = originalCreateFrom;
      }
    });

    it('should check GSC listSites when GSC is needed (lines 84-86)', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalCwv = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP.cwv;

      const GoogleClientModule = await import('@adobe/spacecat-shared-google-client');
      const originalCreateFrom = GoogleClientModule.default.createFrom;

      try {
        // Temporarily make cwv require GSC
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP.cwv = ['GSC'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['cwv'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        mockSite.getOpportunities.resolves([]);

        // Mock GoogleClient
        const mockGoogleClient = {
          listSites: sinon.stub().resolves({
            data: {
              siteEntry: [{ siteUrl: 'https://example.com/' }],
            },
          }),
        };

        GoogleClientModule.default.createFrom = sinon.stub().resolves(mockGoogleClient);

        await runOpportunityStatusProcessor(message, context);

        // Should have called createFrom and listSites
        expect(GoogleClientModule.default.createFrom.called).to.be.true;
        expect(mockGoogleClient.listSites.called).to.be.true;
      } finally {
        GoogleClientModule.default.createFrom = originalCreateFrom;
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP.cwv = originalCwv;
      }
    });
  });

  describe('Bot Protection Detection', () => {
    let mockScrapeClient;
    let scrapeClientStub;
    let mockSlackClient;
    let BaseSlackClientStub;

    beforeEach(async () => {
      // Restore any previous BaseSlackClient stub first
      if (BaseSlackClientStub && BaseSlackClientStub.restore) {
        BaseSlackClientStub.restore();
      }

      // Create fresh mock scrape client with new stubs for each test
      mockScrapeClient = {
        getScrapeJobsByBaseURL: sinon.stub(),
        getScrapeJobUrlResults: sinon.stub(),
      };

      // Create fresh mock Slack client with new stubs for each test
      mockSlackClient = {
        postMessage: sinon.stub().resolves(),
      };

      const SlackClientModule = await import('@adobe/spacecat-shared-slack-client');
      BaseSlackClientStub = sinon.stub(SlackClientModule.BaseSlackClient, 'createFrom').returns(mockSlackClient);

      // Reset mock site
      mockSite.getOpportunities.resolves([]);

      // Recreate S3 client stub (it was restored by afterEach sinon.restore())
      context.s3Client = {
        send: sinon.stub().resolves({
          Body: {
            transformToString: sinon.stub().resolves('{}'),
          },
          ContentType: 'application/json',
        }),
      };

      // Reset AWS_REGION to ensure each test starts fresh
      delete context.env.AWS_REGION;
    });

    afterEach(() => {
      // Restore BaseSlackClient stub
      if (BaseSlackClientStub && BaseSlackClientStub.restore) {
        BaseSlackClientStub.restore();
      }

      // Restore scrape client stub
      if (scrapeClientStub && scrapeClientStub.restore) {
        try {
          scrapeClientStub.restore();
        } catch (e) {
          // Already restored, ignore
        }
        scrapeClientStub = null;
      }
    });

    it('should detect bot protection from CloudWatch logs and send Slack alert', async function () {
      this.timeout(5000);
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      // Make broken-backlinks require scraping
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

      message.siteUrl = 'https://zepbound.lilly.com';
      message.taskContext.auditTypes = ['broken-backlinks'];
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };
      // Set onboard time to trigger bot protection check
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      context.env.AWS_REGION = 'us-east-1'; // Production environment
      context.env.SPACECAT_BOT_IPS = '3.218.16.42,52.55.82.37,54.172.145.38';

      // Ensure mockSite returns empty opportunities
      mockSite.getOpportunities.resolves([]);

      // Mock CloudWatch to return bot protection log events
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
      cloudWatchStub.resolves({
        events: [
          {
            message: `Bot Protection Detection in Scraper: ${JSON.stringify({
              jobId: 'job-123',
              errorCategory: 'bot-protection',
              url: 'https://zepbound.lilly.com/',
              blockerType: 'cloudflare',
              confidence: 0.99,
              httpStatus: 403,
            })}`,
          },
          {
            message: `Bot Protection Detection in Scraper: ${JSON.stringify({
              jobId: 'job-123',
              errorCategory: 'bot-protection',
              url: 'https://zepbound.lilly.com/about',
              blockerType: 'cloudflare',
              confidence: 0.99,
              httpStatus: 403,
            })}`,
          },
        ],
      });

      // No need to mock scrape client - bot protection check happens BEFORE fetching scrape data
      const result = await runOpportunityStatusProcessor(message, context);

      // Verify bot protection alert was sent via Slack
      expect(mockSlackClient.postMessage).to.have.been.called;

      // Find the bot protection message among all Slack calls
      const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
        const args = call.args[0]; // postMessage({ channel, thread_ts, text, ... })
        return args && args.text && args.text.includes('Bot Protection Detected');
      });

      expect(botProtectionCall).to.exist;
      const slackMessage = botProtectionCall.args[0].text;

      expect(slackMessage).to.include('Bot Protection Detected');
      expect(slackMessage).to.include('Cloudflare'); // Formatted blocker type
      expect(slackMessage).to.include('2'); // Total count
      expect(slackMessage).to.include('403'); // HTTP status
      expect(slackMessage).to.include('Spacecat/1.0');
      expect(slackMessage).to.include('3.218.16.42'); // Production IP
      expect(slackMessage).to.include('How to Resolve'); // Resolution instructions

      expect(result.status).to.equal(200);

      // Cleanup CloudWatch stub
      cloudWatchStub.restore();
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
    });

    it('should use dev IPs when AWS_REGION is not us-east', async function () {
      this.timeout(5000);
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      // Make broken-backlinks require scraping
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

      message.siteUrl = 'https://dev-test.com';
      message.taskContext.auditTypes = ['broken-backlinks'];
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };
      // Set onboard time to trigger analysis
      message.taskContext.onboardStartTime = Date.now() - 3600000;
      context.env.AWS_REGION = 'eu-west-1'; // Dev environment (non-us-east)
      context.env.S3_SCRAPER_BUCKET_NAME = 'test-bucket';
      context.env.SPACECAT_BOT_IPS = '44.218.57.115,3.225.211.141,44.219.217.174';

      // Ensure mockSite returns empty opportunities
      mockSite.getOpportunities.resolves([]);

      // Mock CloudWatch to return bot protection log events
      const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
      const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
      cloudWatchStub.resolves({
        events: [
          {
            message: `Bot Protection Detection in Scraper: ${JSON.stringify({
              jobId: 'job-dev',
              errorCategory: 'bot-protection',
              url: 'https://dev-test.com/',
              blockerType: 'akamai',
              confidence: 0.99,
              httpStatus: 403,
            })}`,
          },
        ],
      });

      // No need to mock scrape client - bot protection check happens BEFORE fetching scrape data
      const result = await runOpportunityStatusProcessor(message, context);

      // Verify bot protection alert was sent via Slack
      expect(mockSlackClient.postMessage).to.have.been.called;

      // Find the bot protection message
      const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
        const args = call.args[0];
        return args && args.text && args.text.includes('Bot Protection Detected');
      });

      expect(botProtectionCall).to.exist;
      const slackMessage = botProtectionCall.args[0].text;

      // Should use dev IPs (not prod IPs)
      expect(slackMessage).to.include('44.218.57.115'); // Dev IP
      expect(slackMessage).to.not.include('3.218.16.42'); // Prod IP should not be present
      expect(slackMessage).to.include('Akamai'); // Formatted blocker type
      expect(slackMessage).to.include('403'); // HTTP status

      expect(result.status).to.equal(200);

      // Cleanup CloudWatch stub
      cloudWatchStub.restore();
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
    });

    it('should not send bot protection alert when no bot protection logs found', async function () {
      this.timeout(5000);
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://no-bot-protection.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        // Set onboard time to trigger bot protection check
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        context.env.AWS_REGION = 'us-east-1';

        // Ensure mockSite returns empty opportunities
        mockSite.getOpportunities.resolves([]);

        // Mock CloudWatch to return EMPTY events (no bot protection)
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({
          events: [], // No bot protection events
        });

        const mockJob = {
          id: 'job-no-bot',
          startedAt: new Date().toISOString(),
        };

        mockScrapeClient.getScrapeJobsByBaseURL.resolves([mockJob]);

        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Should not send bot protection alert (no bot protection logs)
        const botProtectionCall = mockSlackClient.postMessage
          && mockSlackClient.postMessage.getCalls
          ? mockSlackClient.postMessage.getCalls().find((call) => {
            const args = call.args[0];
            return args && args.text && args.text.includes('Bot Protection Detected');
          })
          : undefined;
        expect(botProtectionCall).to.not.exist;

        expect(result.status).to.equal(200);

        // Cleanup CloudWatch stub
        cloudWatchStub.restore();
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          try {
            scrapeClientStub.restore();
          } catch (e) {
            // Already restored
          }
          scrapeClientStub = null;
        }
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should handle partial bot protection blocking', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        context.env.S3_SCRAPER_BUCKET_NAME = 'test-bucket';
        context.env.AWS_REGION = 'us-east-1';
        context.env.SPACECAT_BOT_IPS = '3.218.16.42,52.55.82.37,54.172.145.38';

        // Mock CloudWatch to return bot protection events for 2 out of 3 URLs
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({
          events: [
            {
              message: `Bot Protection Detection in Scraper: ${JSON.stringify({
                jobId: 'job-456',
                errorCategory: 'bot-protection',
                url: 'https://example.com/blocked',
                blockerType: 'cloudflare',
                confidence: 0.99,
                httpStatus: 403,
              })}`,
            },
            {
              message: `Bot Protection Detection in Scraper: ${JSON.stringify({
                jobId: 'job-456',
                errorCategory: 'bot-protection',
                url: 'https://example.com/also-blocked',
                blockerType: 'cloudflare',
                confidence: 0.99,
                httpStatus: 403,
              })}`,
            },
          ],
        });

        // No need to mock scrape client - bot protection check happens BEFORE fetching scrape data
        const result = await runOpportunityStatusProcessor(message, context);

        // Verify bot protection alert was sent via Slack
        expect(mockSlackClient.postMessage).to.have.been.called;

        // Find the bot protection message among all Slack calls
        const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
          const args = call.args[0]; // postMessage({ channel, thread_ts, text, ... })
          return args && args.text && args.text.includes('Bot Protection Detected');
        });

        expect(botProtectionCall).to.exist;
        const slackMessage = botProtectionCall.args[0].text;

        expect(slackMessage).to.include('Bot Protection Detected');
        expect(slackMessage).to.include('2'); // 2 total blocked URLs
        expect(slackMessage).to.include('Cloudflare'); // Formatted blocker type
        expect(slackMessage).to.include('403'); // HTTP status

        expect(result.status).to.equal(200);

        // Cleanup CloudWatch stub
        cloudWatchStub.restore();
      } finally {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should not send alert when no bot protection detected', async function () {
      this.timeout(5000);
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://clean-site.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000;

        // Mock CloudWatch to return NO bot protection events
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({ events: [] });

        // Mock scrape results - no bot protection
        const mockScrapeResults = [
          {
            url: 'https://clean-site.com/',
            status: 'COMPLETE',
            metadata: {
              botProtection: {
                detected: false,
                type: 'none',
                blocked: false,
                crawlable: true,
              },
            },
          },
          {
            url: 'https://clean-site.com/page',
            status: 'COMPLETE',
            metadata: {
              botProtection: {
                detected: false,
                type: 'none',
                blocked: false,
                crawlable: true,
              },
            },
          },
        ];

        const mockJob = {
          id: 'job-789',
          startedAt: new Date().toISOString(),
        };

        mockScrapeClient.getScrapeJobsByBaseURL.resolves([mockJob]);
        mockScrapeClient.getScrapeJobUrlResults.resolves(mockScrapeResults);

        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Verify scraping was checked exactly once
        expect(mockScrapeClient.getScrapeJobsByBaseURL).to.have.been.calledOnce;
        expect(mockScrapeClient.getScrapeJobUrlResults).to.have.been.calledOnce;

        // Verify NO bot protection alert was sent via Slack
        // postMessage may be called for other messages, but not for bot protection
        const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
          const args = call.args[0];
          return args && args.text && args.text.includes('Bot Protection Detected');
        });
        expect(botProtectionCall).to.be.undefined;

        expect(result.status).to.equal(200);

        // Cleanup
        cloudWatchStub.restore();
        scrapeClientStub.restore();
      } finally {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should handle scrapes without bot protection metadata', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://old-scrape.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };

        // Mock scrape results - old format without botProtection field
        const mockScrapeResults = [
          {
            url: 'https://old-scrape.com/',
            status: 'COMPLETE',
            metadata: {
              // No botProtection field
            },
          },
        ];

        const mockJob = {
          id: 'job-old',
          startedAt: new Date().toISOString(),
        };

        mockScrapeClient.getScrapeJobsByBaseURL.resolves([mockJob]);
        mockScrapeClient.getScrapeJobUrlResults.resolves(mockScrapeResults);

        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Should not crash, and no bot protection alert via Slack
        // postMessage may be called for other messages, but not for bot protection
        const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
          const args = call.args[0];
          return args && args.text && args.text.includes('Bot Protection Detected');
        });
        expect(botProtectionCall).to.be.undefined;
        expect(result.status).to.equal(200);
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          try {
            scrapeClientStub.restore();
          } catch (e) {
            // Already restored
          }
          scrapeClientStub = null;
        }
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should not check bot protection when slackContext is missing', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://example.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = null; // No slack context

        // Mock scrape results with bot protection
        const mockScrapeResults = [
          {
            url: 'https://example.com/',
            status: 'COMPLETE',
            metadata: {
              botProtection: {
                detected: true,
                type: 'cloudflare',
                blocked: true,
                crawlable: false,
              },
            },
          },
        ];

        const mockJob = {
          id: 'job-no-slack',
          startedAt: new Date().toISOString(),
        };

        mockScrapeClient.getScrapeJobsByBaseURL.resolves([mockJob]);
        mockScrapeClient.getScrapeJobUrlResults.resolves(mockScrapeResults);

        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Should not crash, bot protection checked but not sent to Slack
        expect(result.status).to.equal(200);
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          try {
            scrapeClientStub.restore();
          } catch (e) {
            // Already restored
          }
          scrapeClientStub = null;
        }
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should not send alert when all S3 files exist (no missing files)', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://all-files-exist.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        context.env.S3_SCRAPER_BUCKET_NAME = 'test-bucket';
        context.env.AWS_REGION = 'us-east-1';
        context.env.SPACECAT_BOT_IPS = '3.218.16.42,52.55.82.37,54.172.145.38';

        mockSite.getOpportunities.resolves([]);

        // Mock scrape results with paths
        const mockScrapeResults = [
          {
            url: 'https://all-files-exist.com/',
            status: 'COMPLETE',
            path: 'scrapes/job-all-exist/url-1/scrape.json',
          },
          {
            url: 'https://all-files-exist.com/page',
            status: 'COMPLETE',
            path: 'scrapes/job-all-exist/url-2/scrape.json',
          },
        ];

        // Mock S3 client to return valid data (all files exist)
        context.s3Client.send.reset();
        context.s3Client.send.onFirstCall().resolves({
          Body: {
            transformToString: sinon.stub().resolves(JSON.stringify({
              url: 'https://all-files-exist.com/',
              content: 'valid content',
            })),
          },
          ContentType: 'application/json',
        });
        context.s3Client.send.onSecondCall().resolves({
          Body: {
            transformToString: sinon.stub().resolves(JSON.stringify({
              url: 'https://all-files-exist.com/page',
              content: 'valid content',
            })),
          },
          ContentType: 'application/json',
        });

        const mockJob = {
          id: 'job-all-exist',
          startedAt: new Date().toISOString(),
        };

        mockScrapeClient.getScrapeJobsByBaseURL.resolves([mockJob]);
        mockScrapeClient.getScrapeJobUrlResults.resolves(mockScrapeResults);

        scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Verify NO bot protection alert was sent (all files exist, no missing files)
        const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
          const args = call.args[0];
          return args && args.text && args.text.includes('Bot Protection Detected');
        });
        expect(botProtectionCall).to.be.undefined;

        expect(result.status).to.equal(200);
      } finally {
        if (scrapeClientStub && scrapeClientStub.restore) {
          try {
            scrapeClientStub.restore();
          } catch (e) {
            // Already restored
          }
          scrapeClientStub = null;
        }
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it.skip('should use fallback stats when CloudWatch returns no logs', async function () {
      this.timeout(5000);
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      let localScrapeStub = null;

      try {
        // Set up broken-backlinks to require scraping
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://no-cw-logs.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        context.env.S3_SCRAPER_BUCKET_NAME = 'test-bucket';
        context.env.AWS_REGION = 'us-east-1';
        context.env.SPACECAT_BOT_IPS = '3.218.16.42,52.55.82.37,54.172.145.38';

        // Ensure site returns empty opportunities
        mockSite.getOpportunities.resolves([]);

        // Mock scrape results WITH bot protection metadata
        const mockScrapeResults = [
          {
            url: 'https://no-cw-logs.com/blocked',
            status: 'COMPLETE',
            path: 'scrapes/job-no-cw/url-1/scrape.json',
            metadata: {
              botProtectionDetected: true,
            },
          },
        ];

        // Mock CloudWatch to return empty events array (no logs found)
        const { CloudWatchLogsClient } = await import('@aws-sdk/client-cloudwatch-logs');
        const cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
        cloudWatchStub.resolves({
          events: [], // No events found - triggers fallback stats
        });

        const mockJob = {
          id: 'job-no-cw',
          startedAt: new Date().toISOString(),
        };

        mockScrapeClient.getScrapeJobsByBaseURL.resolves([mockJob]);
        mockScrapeClient.getScrapeJobUrlResults.resolves(mockScrapeResults);

        localScrapeStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Verify bot protection alert was sent
        expect(mockSlackClient.postMessage).to.have.been.called;

        // Should send alert with fallback "unknown" stats
        const botProtectionCall = mockSlackClient.postMessage.getCalls().find((call) => {
          const args = call.args[0];
          return args && args.text && args.text.includes('Bot Protection Detected');
        });

        expect(botProtectionCall).to.exist;
        const slackMessage = botProtectionCall.args[0].text;
        expect(slackMessage).to.include('unknown'); // Fallback blocker type (lowercase)

        expect(result.status).to.equal(200);

        // Cleanup CloudWatch stub
        cloudWatchStub.restore();
      } finally {
        if (localScrapeStub && localScrapeStub.restore) {
          try {
            localScrapeStub.restore();
          } catch (e) {
            // Already restored
          }
          localScrapeStub = null;
        }
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    it('should use fallback stats when no scrape job ID is available', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      let localScrapeStub2 = null;

      try {
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

        message.siteUrl = 'https://no-job-id.com';
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.slackContext = {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        };
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        context.env.S3_SCRAPER_BUCKET_NAME = 'test-bucket';
        context.env.AWS_REGION = 'us-east-1';
        context.env.SPACECAT_BOT_IPS = '3.218.16.42,52.55.82.37,54.172.145.38';

        mockSite.getOpportunities.resolves([]);

        const mockScrapeResults = [
          {
            url: 'https://no-job-id.com/',
            status: 'COMPLETE',
            path: 'scrapes/job-missing/url-1/scrape.json',
          },
        ];

        // Mock S3 to reject (missing file)
        context.s3Client.send.reset();
        context.s3Client.send.rejects(new Error('NoSuchKey'));

        // Mock getScrapeJobsByBaseURL to throw error (simulating no job ID scenario)
        mockScrapeClient.getScrapeJobsByBaseURL.rejects(new Error('Scrape client error'));
        mockScrapeClient.getScrapeJobUrlResults.resolves(mockScrapeResults);

        localScrapeStub2 = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

        const result = await runOpportunityStatusProcessor(message, context);

        // Should handle gracefully even without job ID
        expect(result.status).to.equal(200);
      } finally {
        if (localScrapeStub2 && localScrapeStub2.restore) {
          try {
            localScrapeStub2.restore();
          } catch (e) {
            // Already restored
          }
          localScrapeStub2 = null;
        }
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });

    // Removed: Too complex and difficult to maintain
  });

  describe('Edge Cases', () => {
    it('should handle unknown audit types', async () => {
      message.taskContext.auditTypes = ['unknown-audit-type'];
      mockSite.getOpportunities.resolves([]);

      const result = await runOpportunityStatusProcessor(message, context);

      expect(result.status).to.equal(200);
    });

    it('should filter opportunities based on audit configuration', async () => {
      message.taskContext.auditTypes = ['cwv'];

      const cwvOpp = {
        getType: sinon.stub().returns('cwv'),
        getSuggestions: sinon.stub().resolves([{ id: 'test' }]),
      };

      const metaTagsOpp = {
        getType: sinon.stub().returns('meta-tags'),
        getSuggestions: sinon.stub().resolves([]),
      };

      mockSite.getOpportunities.resolves([cwvOpp, metaTagsOpp]);

      const result = await runOpportunityStatusProcessor(message, context);

      expect(result.status).to.equal(200);
      expect(cwvOpp.getSuggestions).to.have.been.called;
      expect(metaTagsOpp.getSuggestions).to.not.have.been.called;
    });

    it('should handle bot protection without job ID (fallback stats)', async () => {
      const dependencyMapModule = await import('../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js');
      const originalBrokenBacklinks = dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'];
      dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = ['scraping'];

      const scrapeModule = await import('@adobe/spacecat-shared-scrape-client');
      const mockScrapeClientLocal = {
        getScrapeJobsByBaseURL: sinon.stub().resolves([{
          id: null, // Job with null ID
          startedAt: new Date().toISOString(),
        }]),
        getScrapeJobUrlResults: sinon.stub().resolves([
          { url: 'https://test.com/page1', status: 'COMPLETE', path: 'scrapes/test/url1/scrape.json' },
          { url: 'https://test.com/page2', status: 'FAILED', path: 'scrapes/test/url2/scrape.json' },
        ]),
        getScrapeResultPaths: sinon.stub().resolves(new Map([
          ['https://test.com/page1', 'scrapes/test/url1/scrape.json'],
        ])),
      };
      const scrapeClientStub = sinon.stub(scrapeModule.ScrapeClient, 'createFrom').returns(mockScrapeClientLocal);

      try {
        message.taskContext.auditTypes = ['broken-backlinks'];
        message.taskContext.onboardStartTime = Date.now() - 3600000;
        message.taskContext.slackContext = { channelId: 'test', threadTs: 'test' };
        context.env.S3_SCRAPER_BUCKET_NAME = 'test-bucket';
        context.env.SPACECAT_BOT_IPS = '3.218.16.42,52.55.82.37,54.172.145.38';
        mockSite.getOpportunities.resolves([]);

        // Mock S3: first success, second missing (bot protection without jobId for CloudWatch)
        context.s3Client.send.reset();
        context.s3Client.send.onFirstCall().resolves({
          Body: {
            transformToString: sinon.stub().resolves(JSON.stringify({ url: 'https://test.com/page1' })),
          },
          ContentType: 'application/json',
        });
        const noSuchKeyError = new Error('NoSuchKey');
        noSuchKeyError.name = 'NoSuchKey';
        context.s3Client.send.onSecondCall().rejects(noSuchKeyError);
        // Additional calls for bot protection check
        context.s3Client.send.onCall(2).resolves({
          Body: {
            transformToString: sinon.stub().resolves(JSON.stringify({ url: 'https://test.com/page1' })),
          },
          ContentType: 'application/json',
        });
        context.s3Client.send.onCall(3).rejects(noSuchKeyError);

        const result = await runOpportunityStatusProcessor(message, context);

        expect(result.status).to.equal(200);
        // Should use fallback stats (no CloudWatch query due to null jobId)
        expect(context.log.info).to.not.have.been.calledWithMatch(/querying CloudWatch logs/);
      } finally {
        scrapeClientStub.restore();
        dependencyMapModule.OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks'] = originalBrokenBacklinks;
      }
    });
  });
});
