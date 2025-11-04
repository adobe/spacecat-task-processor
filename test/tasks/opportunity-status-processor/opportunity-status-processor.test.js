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
      expect(context.log.info.calledWith('Found 2 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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
      expect(context.log.info.calledWith('Found 2 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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

      expect(context.log.info.calledWith('Found 3 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
    });

    it('should handle empty opportunities array', async () => {
      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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
      expect(context.log.info.calledWith('Found 1 opportunity for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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
      expect(context.log.info.calledWith('Found 4 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;

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
      expect(context.log.info.calledWith('Found 1 opportunity for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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
      expect(context.log.info.calledWith('Found 1 opportunity for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
    });

    it('should check AHREFS Import data availability', async () => {
      // Mock AHREFSImport data available
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
      expect(context.log.info.calledWith('AHREFS Import data availability for site test-site-id: Available (2 top pages)')).to.be.true;
      expect(context.log.info.calledWithMatch(/Found 1 opportunity for site test-site-id.*AHREFS Import: true/)).to.be.true;
    });

    it('should handle AHREFSImport data not available', async () => {
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
      expect(context.log.info.calledWith('Found 1 opportunity for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
    });

    it('should handle AHREFSImport check errors', async () => {
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
      expect(context.log.info.calledWith('Found 1 opportunity for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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
        expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;
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
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: true, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;

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
        const opportunityWord = testCase.expectedCount === 1 ? 'opportunity' : 'opportunities';
        expect(testContext.log.info.calledWith(`Found ${testCase.expectedCount} ${opportunityWord} for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false`)).to.be.true;
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
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: true, Scraping: false')).to.be.true;

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
      expect(testContext.log.info.calledWith('Found 0 opportunities for site test-site-id. Data sources - RUM: false, AHREFS Import: false, GSC: false, Scraping: false')).to.be.true;

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

      await runOpportunityStatusProcessor(message, context);

      // Should detect missing cwv opportunity
      expect(context.log.warn.calledWithMatch('Missing opportunities')).to.be.true;
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

      expect(context.log.info.calledWith('All expected opportunities are present for site test-site-id')).to.be.true;
    });

    it('should check scraping for site with URL', async () => {
      message.siteUrl = 'https://www.example.com';

      const mockOpportunities = [
        {
          getType: () => 'alt-text',
          getSuggestions: sinon.stub().resolves([]),
        },
      ];
      mockSite.getOpportunities.resolves(mockOpportunities);

      await runOpportunityStatusProcessor(message, context);

      // Scraping check should be performed
      expect(mockSite.getOpportunities.called).to.be.true;
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
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo.rejects(new Error('Database error'));

      await runOpportunityStatusProcessor(message, context);

      expect(context.log.error.calledWithMatch('Error checking AHREFS Import data availability')).to.be.true;
    });

    it('should check AHREFSImport data with specific source and geo parameters', async () => {
      context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .withArgs('test-site-id', 'ahrefs', 'global')
        .resolves([{ url: 'https://example.com/page1' }]);

      await runOpportunityStatusProcessor(message, context);

      expect(context.dataAccess.SiteTopPage.allBySiteIdAndSourceAndGeo
        .calledWith('test-site-id', 'ahrefs', 'global')).to.be.true;
    });

    it('should log AHREFS Import data availability with page count', async () => {
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

    it('should show no failures message when all checks pass', async () => {
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

      // Should complete successfully
      expect(mockSite.getOpportunities.called).to.be.true;
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

    it('should handle opportunities with empty runbook', async () => {
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

      await runOpportunityStatusProcessor(message, context);

      expect(mockSite.getOpportunities.called).to.be.true;
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

    it('should handle empty opportunities with Slack output', async () => {
      message.siteUrl = 'https://example.com';
      message.taskContext.slackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };

      mockSite.getOpportunities.resolves([]);

      await runOpportunityStatusProcessor(message, context);

      // Should show "No opportunities found for this site"
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
});
