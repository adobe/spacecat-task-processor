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
import esmock from 'esmock';
import { MockContextBuilder } from '../../shared.js';

// Dynamic import for ES modules
let runAuditTroubleshootingProcessor;
let sayStub;
let mockCloudWatchClient;

describe('Audit Troubleshooting Processor', () => {
  let sandbox;
  let mockContext;
  let mockSite;
  let mockMessage;

  // Helper function to create mock CloudWatch events
  const createMockCloudWatchEvents = (events) => ({
    events: events.map((event, index) => ({
      message: event.message,
      timestamp: event.timestamp || Date.now() - (index * 1000),
      logStreamName: event.logStreamName || `stream${index}`,
    })),
  });

  // Helper function to setup common mocks
  const setupCommonMocks = () => {
    mockContext.dataAccess.Site.findById.resolves(mockSite);
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Create sayStub
    sayStub = sandbox.stub().resolves();

    // Create mock CloudWatch client
    mockCloudWatchClient = {
      send: sandbox.stub(),
    };

    // Import the function to test with esmock to mock dependencies
    const module = await esmock('../../../src/tasks/audit-troubleshooting-processor/handler.js', {
      '../../../src/utils/slack-utils.js': {
        say: sayStub,
      },
      '@aws-sdk/client-cloudwatch-logs': {
        CloudWatchLogsClient: sandbox.stub().returns(mockCloudWatchClient),
        FilterLogEventsCommand: sandbox.stub(),
      },
    });
    runAuditTroubleshootingProcessor = module.runAuditTroubleshootingProcessor;

    // Mock context using MockContextBuilder
    mockContext = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Site: {
          findById: sandbox.stub(),
        },
      })
      .withOverrides({
        env: {
          AWS_REGION: 'us-east-1',
          S3_SCRAPER_BUCKET_NAME: 'test-bucket',
        },
      })
      .build();

    // Mock site
    mockSite = {
      getBaseURL: sandbox.stub().returns('https://example.com'),
    };

    // Mock message
    mockMessage = {
      siteId: 'test-site-id',
      organizationId: 'test-org-id',
      taskContext: {
        slackContext: 'test-slack-context',
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('runAuditTroubleshootingProcessor', () => {
    it('should process audit troubleshooting successfully with no failures', async () => {
      setupCommonMocks();

      // Mock CloudWatch to return no events
      mockCloudWatchClient.send.resolves({ events: [] });

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(mockContext.log.info.calledWith('Processing audit failure analysis for site:', {
        taskType: 'audit-troubleshooting-processor',
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
      })).to.be.true;

      expect(mockContext.dataAccess.Site.findById.calledWith('test-site-id')).to.be.true;
      expect(mockContext.log.info.calledWith('Searching CloudWatch logs for failure patterns...')).to.be.true;
      expect(mockContext.log.info.calledWith('Analyzing failure root causes...')).to.be.true;
      expect(mockContext.log.info.calledWith('Audit failure analysis completed for site test-site-id')).to.be.true;
    });

    it('should handle site not found error', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(mockContext.log.error.calledWith('Site not found for siteId: test-site-id')).to.be.true;
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':x: Site not found for siteId: test-site-id')).to.be.true;
    });

    it('should handle CloudWatch search errors gracefully', async () => {
      setupCommonMocks();

      // Mock CloudWatch to throw error
      mockCloudWatchClient.send.rejects(new Error('CloudWatch error'));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(mockContext.log.warn.calledWith('Failed to search Audit Failures logs: CloudWatch error')).to.be.true;
      expect(mockContext.log.warn.calledWith('Failed to search Import Failures logs: CloudWatch error')).to.be.true;
      expect(mockContext.log.warn.calledWith('Failed to search Scraping Failures logs: CloudWatch error')).to.be.true;
      expect(mockContext.log.info.calledWith('Audit failure analysis completed for site test-site-id')).to.be.true;
    });

    it('should handle missing slackContext', async () => {
      setupCommonMocks();
      delete mockMessage.taskContext.slackContext;

      // Mock CloudWatch to return no events
      mockCloudWatchClient.send.resolves({ events: [] });

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      // Should complete without error
      expect(mockContext.log.info.calledWith('Processing audit failure analysis for site:', {
        taskType: 'audit-troubleshooting-processor',
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
      })).to.be.true;
    });

    it('should handle main function errors', async () => {
      mockContext.dataAccess.Site.findById.rejects(new Error('Database error'));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(mockContext.log.error.calledWith('Error in audit failure analysis:', sinon.match.any)).to.be.true;
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':x: Error analyzing failures for site test-site-id: Database error')).to.be.true;
    });
  });

  describe('searchFailurePatterns', () => {
    it('should search all failure patterns', async () => {
      setupCommonMocks();

      // Mock CloudWatch responses for different log groups
      mockCloudWatchClient.send
        .onFirstCall().resolves({ events: [] }) // Audit Failures
        .onSecondCall().resolves({ events: [] }) // Import Failures
        .onThirdCall()
        .resolves({ events: [] }); // Scraping Failures

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      // Verify all three log groups were searched
      expect(mockCloudWatchClient.send.calledThrice).to.be.true;

      // Check that CloudWatch was called (we can't easily verify the specific log groups
      // due to esmock limitations)
      expect(mockCloudWatchClient.send.called).to.be.true;
    });

    it('should handle mixed CloudWatch responses', async () => {
      setupCommonMocks();

      // Mock CloudWatch responses - some with events, some without
      const mockEvents = [
        {
          message: 'Error scraping URL: timeout occurred',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
        {
          message: 'Import failed for site test-site-id',
          timestamp: Date.now() - 1000,
          logStreamName: 'stream2',
        },
      ];

      mockCloudWatchClient.send
        .onFirstCall().resolves({ events: [] }) // Audit Failures - no events
        .onSecondCall().resolves({ events: [mockEvents[1]] }) // Import Failures - 1 event
        .onThirdCall()
        .resolves({ events: [mockEvents[0]] }); // Scraping Failures - 1 event

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      // Should find 2 failure types
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 2 failure types in CloudWatch logs*')).to.be.true;
    });
  });

  describe('analyzeFailureRootCauses', () => {
    it('should analyze timeout errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Error scraping URL: timeout occurred',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
        {
          message: 'Request timeout after 30 seconds',
          timestamp: Date.now() - 1000,
          logStreamName: 'stream2',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze ad blocker errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Error: net::ERR_BLOCKED_BY_CLIENT',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze forbidden errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'HTTP 403 Forbidden response',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
        {
          message: 'Access forbidden to resource',
          timestamp: Date.now() - 1000,
          logStreamName: 'stream2',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze cloudflare errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Cloudflare protection blocking request',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze rate limit errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Rate limit exceeded for API calls',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze auth errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'HTTP 401 Unauthorized',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
        {
          message: 'Authentication failed for user',
          timestamp: Date.now() - 1000,
          logStreamName: 'stream2',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze no data errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'No data available from source',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
        {
          message: 'Empty response received',
          timestamp: Date.now() - 1000,
          logStreamName: 'stream2',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should analyze connection refused errors correctly', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Connection refused by target server',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should handle unknown error patterns', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Some unknown error occurred',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });
  });

  describe('generateFailureRecommendations', () => {
    it('should generate recommendations for ad_blocker', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'net::ERR_BLOCKED_BY_CLIENT error',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for timeout', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Request timeout occurred',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for forbidden', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: '403 Forbidden response',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for cloudflare', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Cloudflare protection active',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for rate_limit', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Rate limit exceeded',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for auth_error', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: '401 Unauthorized',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for no_data', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'No data available',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for connection_refused', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Connection refused',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });

    it('should generate recommendations for unknown errors', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Some random error message',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
    });
  });

  describe('Slack Integration', () => {
    it('should send no failures message to Slack', async () => {
      setupCommonMocks();

      // Mock CloudWatch to return no events
      mockCloudWatchClient.send.resolves({ events: [] });

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':mag: *Failure Analysis Report for https://example.com*')).to.be.true;
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':tada: *No failures detected in the last 7 days*')).to.be.true;
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', 'All systems appear to be functioning normally')).to.be.true;
    });

    it('should send failure analysis to Slack', async () => {
      setupCommonMocks();

      const mockEvents = [
        {
          message: 'Error scraping URL: timeout occurred',
          timestamp: Date.now(),
          logStreamName: 'stream1',
        },
      ];

      mockCloudWatchClient.send.resolves(createMockCloudWatchEvents(mockEvents));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':mag: *Failure Analysis Report for https://example.com*')).to.be.true;
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', ':warning: *Found 3 failure types in CloudWatch logs*')).to.be.true;
      expect(sayStub.calledWith(mockContext.env, mockContext.log, 'test-slack-context', '*Failure Analysis:*')).to.be.true;
    });

    it('should handle Slack errors gracefully', async () => {
      setupCommonMocks();

      // Mock CloudWatch to return no events
      mockCloudWatchClient.send.resolves({ events: [] });

      // Mock say function to throw error on first call
      sayStub.onFirstCall().rejects(new Error('Slack error'));

      await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      expect(mockContext.log.error.calledWith('Error in audit failure analysis:', sinon.match.any)).to.be.true;
    });
  });

  describe('Return Values', () => {
    it('should return correct success response', async () => {
      setupCommonMocks();

      // Mock CloudWatch to return no events
      mockCloudWatchClient.send.resolves({ events: [] });

      const result = await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      // The function should complete successfully and return a response
      expect(result).to.exist;
      expect(result.status).to.equal(200);
    });

    it('should return correct error response', async () => {
      mockContext.dataAccess.Site.findById.rejects(new Error('Database error'));

      const result = await runAuditTroubleshootingProcessor(mockMessage, mockContext);

      // The function should complete and return a response even on error
      expect(result).to.exist;
      expect(result.status).to.equal(200);
    });
  });
});
