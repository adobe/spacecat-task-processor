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

import { expect } from 'chai';
import sinon from 'sinon';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import {
  queryBotProtectionLogs,
  aggregateBotProtectionStats,
  checkAndAlertBotProtection,
  checkAuditExecution,
  getAuditFailureReason,
} from '../../src/utils/cloudwatch-utils.js';

describe('CloudWatch Utils', () => {
  let cloudWatchStub;
  let mockContext;

  beforeEach(() => {
    cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
    mockContext = {
      env: {
        AWS_REGION: 'us-east-1',
        SPACECAT_BOT_IPS: '', // Set default empty string to avoid shared library errors
        // Slack env vars for say() function
        SLACK_BOT_TOKEN: 'test-bot-token',
        SLACK_SIGNING_SECRET: 'test-signing-secret',
        SLACK_TOKEN_WORKSPACE_INTERNAL: 'test-workspace-token',
        SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: 'test-ops-channel',
      },
      log: {
        info: sinon.stub(),
        debug: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('queryBotProtectionLogs', () => {
    it('should return empty array when CloudWatch returns no events', async () => {
      cloudWatchStub.resolves({ events: [] });

      const onboardStartTime = Date.now() - 3600000; // 1 hour ago
      const result = await queryBotProtectionLogs('test-job-id', mockContext, onboardStartTime);

      expect(result).to.deep.equal([]);
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/No bot protection logs found/);
    });

    it('should handle CloudWatch query errors gracefully', async () => {
      cloudWatchStub.rejects(new Error('CloudWatch error'));

      const onboardStartTime = Date.now() - 3600000; // 1 hour ago
      const result = await queryBotProtectionLogs('test-job-id', mockContext, onboardStartTime);

      expect(result).to.deep.equal([]);
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Failed to query CloudWatch logs/);
    });

    it('should handle malformed log messages gracefully', async () => {
      cloudWatchStub.resolves({
        events: [
          { message: 'INVALID_LOG_FORMAT no json here' }, // Doesn't match pattern
          { message: 'Bot Protection Detection in Scraper: { invalid: json }' }, // Matches pattern but invalid JSON, logs warning
          { message: `Bot Protection Detection in Scraper: ${JSON.stringify({ jobId: 'test', httpStatus: 403 })}` },
        ],
      });

      const onboardStartTime = Date.now() - 3600000; // 1 hour ago
      const result = await queryBotProtectionLogs('test-job-id', mockContext, onboardStartTime);

      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.deep.equal({ jobId: 'test', httpStatus: 403 });
      // Two warnings: first message doesn't match pattern, second matches but has invalid JSON
      expect(mockContext.log.warn).to.have.been.calledTwice;
    });
  });

  describe('aggregateBotProtectionStats', () => {
    it('should aggregate bot protection statistics', () => {
      const events = [
        {
          url: 'https://test.com/1', httpStatus: 403, blockerType: 'cloudflare', confidence: 0.99,
        },
        {
          url: 'https://test.com/2', httpStatus: 403, blockerType: 'cloudflare', confidence: 0.95,
        },
        {
          url: 'https://test.com/3', httpStatus: 200, blockerType: 'akamai', confidence: 0.8,
        },
      ];

      const result = aggregateBotProtectionStats(events);

      expect(result.totalCount).to.equal(3);
      expect(result.highConfidenceCount).to.equal(2);
      expect(result.byHttpStatus).to.deep.equal({ 403: 2, 200: 1 });
      expect(result.byBlockerType).to.deep.equal({ cloudflare: 2, akamai: 1 });
      expect(result.urls).to.have.lengthOf(3);
    });

    it('should handle events with missing fields', () => {
      const events = [
        { url: 'https://test.com/1' },
        { url: 'https://test.com/2', httpStatus: 403 },
      ];

      const result = aggregateBotProtectionStats(events);

      expect(result.totalCount).to.equal(2);
      expect(result.highConfidenceCount).to.equal(0);
      expect(result.byHttpStatus).to.deep.equal({ unknown: 1, 403: 1 });
      expect(result.byBlockerType).to.deep.equal({ unknown: 2 });
    });
  });

  describe('checkAndAlertBotProtection', () => {
    it('should return null when no bot protection logs found', async () => {
      cloudWatchStub.resolves({ events: [] });

      const result = await checkAndAlertBotProtection({
        siteId: 'site-123',
        siteUrl: 'https://example.com',
        searchStartTime: Date.now() - 3600000,
        slackContext: { channelId: 'C123', threadTs: '123.456' },
        context: mockContext,
      });

      expect(result).to.be.null;
    });

    it('should query CloudWatch and aggregate stats when bot protection detected', async () => {
      // Mock BaseSlackClient for say() function
      const mockSlackClient = {
        postMessage: sinon.stub().resolves(),
      };
      const BaseSlackClientModule = await import('@adobe/spacecat-shared-slack-client');
      const slackStub = sinon.stub(BaseSlackClientModule.BaseSlackClient, 'createFrom').returns(mockSlackClient);

      const mockEvents = [
        {
          message: `Bot Protection Detection in Scraper: ${JSON.stringify({
            url: 'https://example.com/page1',
            httpStatus: 403,
            blockerType: 'cloudflare',
            confidence: 0.99,
          })}`,
        },
        {
          message: `Bot Protection Detection in Scraper: ${JSON.stringify({
            url: 'https://example.com/page2',
            httpStatus: 403,
            blockerType: 'cloudflare',
            confidence: 0.98,
          })}`,
        },
      ];

      cloudWatchStub.resolves({ events: mockEvents });
      // Set SPACECAT_BOT_IPS to trigger line 174
      mockContext.env.SPACECAT_BOT_IPS = '1.2.3.4,5.6.7.8';

      try {
        // The function will execute line 174: const botIps = env.SPACECAT_BOT_IPS || '';
        const result = await checkAndAlertBotProtection({
          siteId: 'site-123',
          siteUrl: 'https://example.com',
          searchStartTime: Date.now() - 3600000,
          slackContext: { channelId: 'C123', threadTs: '123.456' },
          context: mockContext,
        });

        // Verify stats are aggregated correctly
        expect(result).to.not.be.null;
        expect(result.totalCount).to.equal(2);
        expect(result.highConfidenceCount).to.equal(2);
        expect(result.byHttpStatus).to.deep.equal({ 403: 2 });
        expect(result.byBlockerType).to.deep.equal({ cloudflare: 2 });
        expect(result.urls).to.have.lengthOf(2);

        // Verify warning was logged
        expect(mockContext.log.warn).to.have.been.calledWithMatch(/BOT-BLOCKED/);
        expect(mockContext.log.warn).to.have.been.calledWithMatch(/2 URLs blocked/);

        // Verify Slack message was sent
        expect(mockSlackClient.postMessage).to.have.been.calledOnce;
      } finally {
        slackStub.restore();
      }
    });

    it('should handle CloudWatch query errors gracefully', async () => {
      cloudWatchStub.rejects(new Error('CloudWatch error'));

      const result = await checkAndAlertBotProtection({
        siteId: 'site-456',
        siteUrl: 'https://test.com',
        searchStartTime: Date.now() - 3600000,
        slackContext: { channelId: 'C456', threadTs: '456.789' },
        context: mockContext,
      });

      // Should return null due to error (queryBotProtectionLogs returns [] on error)
      expect(result).to.be.null;
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Failed to query CloudWatch logs/);
    });
  });

  describe('checkAuditExecution', () => {
    it('should return true when audit execution log is found', async () => {
      cloudWatchStub.resolves({
        events: [
          { message: 'Received meta-tags audit request for: site-123' },
        ],
      });

      const result = await checkAuditExecution('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(result).to.be.true;
    });

    it('should return false when no audit execution log is found', async () => {
      cloudWatchStub.resolves({ events: [] });

      const result = await checkAuditExecution('cwv', 'site-456', Date.now() - 3600000, mockContext);

      expect(result).to.be.false;
    });

    it('should return false on CloudWatch error', async () => {
      cloudWatchStub.rejects(new Error('CloudWatch error'));

      const result = await checkAuditExecution('broken-backlinks', 'site-789', Date.now() - 3600000, mockContext);

      expect(result).to.be.false;
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Error checking audit execution/);
    });

    it('should use default time window when onboardStartTime is not provided', async () => {
      cloudWatchStub.resolves({ events: [] });

      const result = await checkAuditExecution('meta-tags', 'site-123', null, mockContext);

      expect(result).to.be.false;
      // Verify the command was called (stub was invoked)
      expect(cloudWatchStub).to.have.been.calledOnce;
    });

    it('should use custom log group from environment', async () => {
      mockContext.env.AUDIT_WORKER_LOG_GROUP = '/custom/log-group';
      cloudWatchStub.resolves({ events: [] });

      await checkAuditExecution('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(cloudWatchStub).to.have.been.calledOnce;
    });
  });

  describe('getAuditFailureReason', () => {
    it('should return failure reason when found', async () => {
      cloudWatchStub.resolves({
        events: [
          { message: 'meta-tags audit for site-123 failed after 0.12 seconds. Reason: No top pages found in database' },
        ],
      });

      const result = await getAuditFailureReason('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(result).to.equal('No top pages found in database');
    });

    it('should return null when no failure log is found', async () => {
      cloudWatchStub.resolves({ events: [] });

      const result = await getAuditFailureReason('cwv', 'site-456', Date.now() - 3600000, mockContext);

      expect(result).to.be.null;
    });

    it('should return entire message as fallback when Reason pattern not found', async () => {
      cloudWatchStub.resolves({
        events: [
          { message: 'Some error message without the expected pattern' },
        ],
      });

      const result = await getAuditFailureReason('broken-backlinks', 'site-789', Date.now() - 3600000, mockContext);

      expect(result).to.equal('Some error message without the expected pattern');
    });

    it('should return null on CloudWatch error', async () => {
      cloudWatchStub.rejects(new Error('CloudWatch error'));

      const result = await getAuditFailureReason('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(result).to.be.null;
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Error getting audit failure reason/);
    });

    it('should use default time window when onboardStartTime is not provided', async () => {
      cloudWatchStub.resolves({ events: [] });

      const result = await getAuditFailureReason('meta-tags', 'site-123', null, mockContext);

      expect(result).to.be.null;
      expect(cloudWatchStub).to.have.been.calledOnce;
    });

    it('should extract reason with "at" in the error message', async () => {
      cloudWatchStub.resolves({
        events: [
          {
            message: 'cwv audit for site-456 failed. Reason: Database connection timeout at line 42',
          },
        ],
      });

      const result = await getAuditFailureReason('cwv', 'site-456', Date.now() - 3600000, mockContext);

      expect(result).to.equal('Database connection timeout');
    });

    it('should use custom log group from environment', async () => {
      mockContext.env.AUDIT_WORKER_LOG_GROUP = '/custom/log-group';
      cloudWatchStub.resolves({ events: [] });

      await getAuditFailureReason('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(cloudWatchStub).to.have.been.calledOnce;
    });
  });
});
