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
import { ScrapeClient } from '@adobe/spacecat-shared-scrape-client';
import {
  queryBotProtectionLogs,
  aggregateBotProtectionStats,
  convertAbortInfoToStats,
  getBotProtectionFromDatabase,
  checkAndAlertBotProtection,
  getAuditStatus,
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
      const result = await queryBotProtectionLogs(mockContext, onboardStartTime);

      expect(result).to.deep.equal([]);
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/No bot protection logs found/);
    });

    it('should handle CloudWatch query errors gracefully', async () => {
      cloudWatchStub.rejects(new Error('CloudWatch error'));

      const onboardStartTime = Date.now() - 3600000; // 1 hour ago
      const result = await queryBotProtectionLogs(mockContext, onboardStartTime);

      expect(result).to.deep.equal([]);
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Failed to query CloudWatch logs/);
    });

    it('should handle malformed log messages gracefully', async () => {
      cloudWatchStub.resolves({
        events: [
          { message: 'INVALID_LOG_FORMAT no json here' }, // Doesn't match pattern, returns null silently
          { message: '[BOT-BLOCKED] Bot Protection Detection in Scraper: { invalid: json }' }, // Matches pattern but invalid JSON, logs warning
          { message: `[BOT-BLOCKED] Bot Protection Detection in Scraper: ${JSON.stringify({ jobId: 'test', httpStatus: 403, url: 'https://example.com/test' })}` },
        ],
      });

      const onboardStartTime = Date.now() - 3600000; // 1 hour ago
      const result = await queryBotProtectionLogs(mockContext, onboardStartTime);

      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.deep.equal({ jobId: 'test', httpStatus: 403, url: 'https://example.com/test' });
      // Only one warning: second message matches pattern but has invalid JSON
      expect(mockContext.log.warn).to.have.been.calledOnce;
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

  describe('convertAbortInfoToStats', () => {
    it('should convert complete job abortInfo to stats', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 5,
          totalUrlsCount: 10,
          blockedUrls: [
            {
              url: 'https://test.com/1', httpStatus: 403, blockerType: 'cloudflare', confidence: 0.99,
            },
            {
              url: 'https://test.com/2', httpStatus: 403, blockerType: 'cloudflare', confidence: 0.95,
            },
          ],
          byHttpStatus: { 403: 5 },
          byBlockerType: { cloudflare: 5 },
        },
      };

      const result = convertAbortInfoToStats(abortInfo, true);

      expect(result.totalCount).to.equal(5);
      expect(result.highConfidenceCount).to.equal(2);
      expect(result.isPartial).to.be.false;
      expect(result.totalUrlsInJob).to.equal(10);
      expect(result.byHttpStatus).to.deep.equal({ 403: 5 });
      expect(result.byBlockerType).to.deep.equal({ cloudflare: 5 });
    });

    it('should mark stats as partial for running job', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 3,
          totalUrlsCount: 10,
          blockedUrls: [],
          byHttpStatus: { 403: 3 },
          byBlockerType: { cloudflare: 3 },
        },
      };

      const result = convertAbortInfoToStats(abortInfo, false);

      expect(result.isPartial).to.be.true;
      expect(result.totalCount).to.equal(3);
      expect(result.totalUrlsInJob).to.equal(10);
    });

    it('should return null for non-bot-protection abortInfo', () => {
      const abortInfo = {
        reason: 'other-error',
        details: {},
      };

      const result = convertAbortInfoToStats(abortInfo, true);

      expect(result).to.be.null;
    });

    it('should return null when abortInfo is null', () => {
      const result = convertAbortInfoToStats(null, true);

      expect(result).to.be.null;
    });
  });

  describe('getBotProtectionFromDatabase', () => {
    let scrapeClientStub;
    let mockScrapeClient;

    beforeEach(() => {
      mockScrapeClient = {
        getScrapeJobStatus: sinon.stub(),
      };
      scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);
    });

    afterEach(() => {
      scrapeClientStub.restore();
    });

    it('should return null when jobId is empty', async () => {
      const result = await getBotProtectionFromDatabase('', mockContext);

      expect(result).to.be.null;
      expect(mockScrapeClient.getScrapeJobStatus.called).to.be.false;
    });

    it('should return null when scrape job not found', async () => {
      mockScrapeClient.getScrapeJobStatus.resolves(null);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.be.null;
    });

    it('should return bot protection stats from complete job', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 5,
            totalUrlsCount: 10,
            blockedUrls: [
              {
                url: 'https://test.com/1', httpStatus: 403, blockerType: 'cloudflare', confidence: 0.99,
              },
            ],
            byHttpStatus: { 403: 5 },
            byBlockerType: { cloudflare: 5 },
          },
        },
      };

      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.not.be.null;
      expect(result.totalCount).to.equal(5);
      expect(result.isPartial).to.be.false;
      expect(mockScrapeClient.getScrapeJobStatus).to.have.been.calledWith('job-123');
    });

    it('should return bot protection stats from running job (partial)', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'RUNNING',
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 3,
            totalUrlsCount: 10,
            blockedUrls: [],
            byHttpStatus: { 403: 3 },
            byBlockerType: { cloudflare: 3 },
          },
        },
      };

      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.not.be.null;
      expect(result.totalCount).to.equal(3);
      expect(result.isPartial).to.be.true;
    });

    it('should return null when job has no abort info', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: null,
      };

      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.be.null;
    });

    it('should return null when abort reason is not bot-protection', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'timeout',
          details: {},
        },
      };

      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.be.null;
    });

    it('should handle errors gracefully', async () => {
      mockScrapeClient.getScrapeJobStatus.rejects(new Error('Database error'));

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.be.null;
      expect(mockContext.log.error).to.have.been.called;
    });
  });

  describe('checkAndAlertBotProtection (database-based)', () => {
    let scrapeClientStub;
    let mockScrapeClient;

    beforeEach(() => {
      mockScrapeClient = {
        getScrapeJobStatus: sinon.stub(),
      };
      scrapeClientStub = sinon.stub(ScrapeClient, 'createFrom').returns(mockScrapeClient);
    });

    afterEach(() => {
      scrapeClientStub.restore();
    });

    it('should return null when no bot protection found in database', async () => {
      mockScrapeClient.getScrapeJobStatus.resolves(null);

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://example.com',
        slackContext: { channelId: 'C123', threadTs: '123.456' },
        context: mockContext,
      });

      expect(result).to.be.null;
    });

    it('should query database and aggregate stats when bot protection detected', async () => {
      // Mock BaseSlackClient for say() function
      const mockSlackClient = {
        postMessage: sinon.stub().resolves(),
      };
      const BaseSlackClientModule = await import('@adobe/spacecat-shared-slack-client');
      const slackStub = sinon.stub(BaseSlackClientModule.BaseSlackClient, 'createFrom').returns(mockSlackClient);

      // Mock scrape job with bot protection abortInfo
      const mockScrapeJob = {
        status: 'COMPLETE',
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 2,
            totalUrlsCount: 10,
            blockedUrls: [
              {
                url: 'https://example.com/page1',
                httpStatus: 403,
                blockerType: 'cloudflare',
                confidence: 0.99,
              },
              {
                url: 'https://example.com/page2',
                httpStatus: 403,
                blockerType: 'cloudflare',
                confidence: 0.98,
              },
            ],
            byHttpStatus: { 403: 2 },
            byBlockerType: { cloudflare: 2 },
          },
        },
      };

      mockScrapeClient.getScrapeJobStatus.resolves(mockScrapeJob);
      // Set SPACECAT_BOT_IPS to ensure IPs are included in message
      mockContext.env.SPACECAT_BOT_IPS = '1.2.3.4,5.6.7.8';

      try {
        const result = await checkAndAlertBotProtection({
          jobId: 'job-123',
          siteUrl: 'https://example.com',
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
        expect(result.isPartial).to.equal(false); // Job is COMPLETE

        // Verify warning was logged
        expect(mockContext.log.warn).to.have.been.calledWithMatch(/BOT-BLOCKED/);
        expect(mockContext.log.warn).to.have.been.calledWithMatch(/blockedUrls=2/);

        // Verify Slack message was sent
        expect(mockSlackClient.postMessage).to.have.been.calledOnce;
      } finally {
        slackStub.restore();
      }
    });

    it('should handle database query errors gracefully', async () => {
      mockScrapeClient.getScrapeJobStatus.rejects(new Error('Database error'));

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: { channelId: 'C456', threadTs: '456.789' },
        context: mockContext,
      });

      // Should return null due to error
      expect(result).to.be.null;
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Failed to get bot protection from database/);
    });

    it('should handle partial data when job is still running', async () => {
      const mockSlackClient = {
        postMessage: sinon.stub().resolves(),
      };
      const BaseSlackClientModule = await import('@adobe/spacecat-shared-slack-client');
      const slackStub = sinon.stub(BaseSlackClientModule.BaseSlackClient, 'createFrom').returns(mockSlackClient);

      // Mock scrape job that's still running (partial data)
      const mockScrapeJob = {
        status: 'RUNNING', // Job still in progress
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 1,
            totalUrlsCount: 5,
            blockedUrls: [
              {
                url: 'https://example.com/page1',
                httpStatus: 403,
                blockerType: 'cloudflare',
                confidence: 0.99,
              },
            ],
            byHttpStatus: { 403: 1 },
            byBlockerType: { cloudflare: 1 },
          },
        },
      };

      mockScrapeClient.getScrapeJobStatus.resolves(mockScrapeJob);
      mockContext.env.SPACECAT_BOT_IPS = '1.2.3.4';

      try {
        const result = await checkAndAlertBotProtection({
          jobId: 'job-123',
          siteUrl: 'https://example.com',
          slackContext: { channelId: 'C123', threadTs: '123.456' },
          context: mockContext,
        });

        // Verify partial flag is set
        expect(result).to.not.be.null;
        expect(result.totalCount).to.equal(1);
        expect(result.isPartial).to.equal(true); // Job is RUNNING
        expect(result.totalUrlsInJob).to.equal(5);

        // Verify Slack message includes partial data warning
        expect(mockSlackClient.postMessage).to.have.been.calledOnce;
        const slackMessage = mockSlackClient.postMessage.firstCall.args[0].text;
        expect(slackMessage).to.include('Partial');
        expect(slackMessage).to.include('scraping is still in progress');
      } finally {
        slackStub.restore();
      }
    });

    it('should return null when job not found', async () => {
      mockScrapeClient.getScrapeJobStatus.resolves(null);

      const result = await checkAndAlertBotProtection({
        jobId: 'non-existent-job',
        siteUrl: 'https://example.com',
        slackContext: { channelId: 'C123', threadTs: '123.456' },
        context: mockContext,
      });

      // Should return null when job not found
      expect(result).to.be.null;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/Scrape job not found/);
    });
  });

  describe('getAuditStatus', () => {
    it('should return executed: true and failureReason when audit executed and failed', async () => {
      // First call: audit executed, second call: failure found
      cloudWatchStub.onFirstCall().resolves({
        events: [
          { message: 'Received meta-tags audit request for: site-123' },
        ],
      });
      cloudWatchStub.onSecondCall().resolves({
        events: [
          { message: 'meta-tags audit for site-123 failed. Reason: No top pages found' },
        ],
      });

      const result = await getAuditStatus('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(result).to.deep.equal({
        executed: true,
        failureReason: 'No top pages found',
      });
      expect(cloudWatchStub).to.have.been.calledTwice;
    });

    it('should return executed: true and failureReason: null when audit succeeded', async () => {
      // First call: audit executed, second call: no failure
      cloudWatchStub.onFirstCall().resolves({
        events: [
          { message: 'Received cwv audit request for: site-456' },
        ],
      });
      cloudWatchStub.onSecondCall().resolves({
        events: [],
      });

      const result = await getAuditStatus('cwv', 'site-456', Date.now() - 3600000, mockContext);

      expect(result).to.deep.equal({
        executed: true,
        failureReason: null,
      });
      expect(cloudWatchStub).to.have.been.calledTwice;
    });

    it('should return executed: false and failureReason: null when audit not executed', async () => {
      cloudWatchStub.resolves({
        events: [],
      });

      const result = await getAuditStatus('broken-backlinks', 'site-789', Date.now() - 3600000, mockContext);

      expect(result).to.deep.equal({
        executed: false,
        failureReason: null,
      });
      // Should not check for failure if audit was not executed
      expect(cloudWatchStub).to.have.been.calledOnce;
    });

    it('should extract failure reason with "at" keyword', async () => {
      cloudWatchStub.onFirstCall().resolves({
        events: [
          { message: 'Received meta-tags audit request for: site-123' },
        ],
      });
      cloudWatchStub.onSecondCall().resolves({
        events: [
          { message: 'meta-tags audit for site-123 failed. Reason: Database error at connection' },
        ],
      });

      const result = await getAuditStatus('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(result.executed).to.be.true;
      expect(result.failureReason).to.equal('Database error');
    });

    it('should use entire message as fallback when Reason pattern not found', async () => {
      cloudWatchStub.onFirstCall().resolves({
        events: [
          { message: 'Received cwv audit request for: site-456' },
        ],
      });
      cloudWatchStub.onSecondCall().resolves({
        events: [
          { message: 'Some error without expected pattern' },
        ],
      });

      const result = await getAuditStatus('cwv', 'site-456', Date.now() - 3600000, mockContext);

      expect(result.executed).to.be.true;
      expect(result.failureReason).to.equal('Some error without expected pattern');
    });

    it('should handle CloudWatch errors gracefully', async () => {
      cloudWatchStub.rejects(new Error('CloudWatch service unavailable'));

      const result = await getAuditStatus('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(result).to.deep.equal({
        executed: false,
        failureReason: null,
      });
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Error getting audit status/);
    });

    it('should use default time window when onboardStartTime is null', async () => {
      cloudWatchStub.resolves({
        events: [],
      });

      const result = await getAuditStatus('cwv', 'site-456', null, mockContext);

      expect(result).to.deep.equal({
        executed: false,
        failureReason: null,
      });
      expect(cloudWatchStub).to.have.been.calledOnce;
    });

    it('should use custom log group from environment', async () => {
      mockContext.env.AUDIT_WORKER_LOG_GROUP = '/custom/audit-worker-logs';
      cloudWatchStub.resolves({
        events: [],
      });

      await getAuditStatus('meta-tags', 'site-123', Date.now() - 3600000, mockContext);

      expect(cloudWatchStub).to.have.been.calledOnce;
    });
  });
});
