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
import {
  convertAbortInfoToStats,
  checkAndAlertBotProtection,
} from '../../src/utils/bot-detection.js';

describe('CloudWatch Utils', () => {
  let mockContext;
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockContext = {
      env: {
        AWS_REGION: 'us-east-1',
      },
      log: {
        info: sandbox.stub(),
        debug: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('convertAbortInfoToStats', () => {
    it('should convert abortInfo to stats format with isPartial=false for COMPLETE jobs', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 5,
          totalUrlsCount: 10,
          byBlockerType: { cloudflare: 3, datadome: 2 },
          byHttpStatus: { 403: 4, 503: 1 },
          blockedUrls: [
            {
              url: 'https://test.com/1', httpStatus: 403, type: 'cloudflare', confidence: 0.99,
            },
            {
              url: 'https://test.com/2', httpStatus: 403, type: 'cloudflare', confidence: 0.95,
            },
          ],
        },
      };

      const stats = convertAbortInfoToStats(abortInfo, true);

      expect(stats.totalCount).to.equal(5);
      expect(stats.totalUrlsInJob).to.equal(10);
      expect(stats.isPartial).to.be.false;
      expect(stats.byBlockerType).to.deep.equal({ cloudflare: 3, datadome: 2 });
      expect(stats.byHttpStatus).to.deep.equal({ 403: 4, 503: 1 });
      expect(stats.highConfidenceCount).to.equal(2);
      expect(stats.urls).to.have.lengthOf(2);
    });

    it('should convert abortInfo to stats format with isPartial=true for RUNNING jobs', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 3,
          totalUrlsCount: 100,
          byBlockerType: { cloudflare: 3 },
          byHttpStatus: { 403: 3 },
          blockedUrls: [],
        },
      };

      const stats = convertAbortInfoToStats(abortInfo, false);

      expect(stats.totalCount).to.equal(3);
      expect(stats.isPartial).to.be.true;
    });

    it('should handle abortInfo with missing optional fields', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 2,
        },
      };

      const stats = convertAbortInfoToStats(abortInfo, true);

      expect(stats.totalCount).to.equal(2);
      expect(stats.totalUrlsInJob).to.equal(0);
      expect(stats.byBlockerType).to.deep.equal({});
      expect(stats.byHttpStatus).to.deep.equal({});
      expect(stats.highConfidenceCount).to.equal(0);
      expect(stats.urls).to.have.lengthOf(0);
    });

    it('should return null when abortInfo is null', () => {
      const stats = convertAbortInfoToStats(null, true);
      expect(stats).to.be.null;
    });

    it('should return null when abortInfo reason is not bot-protection', () => {
      const abortInfo = {
        reason: 'timeout',
        details: {
          blockedUrlsCount: 5,
        },
      };

      const stats = convertAbortInfoToStats(abortInfo, true);
      expect(stats).to.be.null;
    });

    it('should return null when details is null', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: null,
      };

      const stats = convertAbortInfoToStats(abortInfo, true);
      expect(stats).to.be.null;
    });

    it('should calculate highConfidenceCount correctly with mixed confidence levels', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 5,
          totalUrlsCount: 10,
          byBlockerType: { cloudflare: 5 },
          byHttpStatus: { 403: 5 },
          blockedUrls: [
            { url: 'https://test.com/1', confidence: 0.99 },
            { url: 'https://test.com/2', confidence: 0.95 },
            { url: 'https://test.com/3', confidence: 0.90 },
            { url: 'https://test.com/4', confidence: 0.98 },
            { url: 'https://test.com/5', confidence: 0.85 },
          ],
        },
      };

      const stats = convertAbortInfoToStats(abortInfo, true);
      expect(stats.highConfidenceCount).to.equal(3); // 0.99, 0.95, 0.98 (>= 0.95)
    });

    it('should handle blockedUrls with missing confidence field', () => {
      const abortInfo = {
        reason: 'bot-protection',
        details: {
          blockedUrlsCount: 2,
          totalUrlsCount: 10,
          byBlockerType: { cloudflare: 2 },
          byHttpStatus: { 403: 2 },
          blockedUrls: [
            { url: 'https://test.com/1' }, // No confidence field
            { url: 'https://test.com/2', confidence: 0.99 },
          ],
        },
      };

      const stats = convertAbortInfoToStats(abortInfo, true);
      expect(stats.highConfidenceCount).to.equal(1); // Only one with confidence >= 0.95
      expect(stats.urls).to.have.lengthOf(2);
    });
  });

  describe('checkAndAlertBotProtection', () => {
    let mockSlackContext;
    let mockScrapeClient;

    beforeEach(() => {
      mockSlackContext = {
        channelId: 'test-channel',
        threadTs: 'test-thread',
      };
      mockContext.env.SPACECAT_BOT_IPS = '1.2.3.4,5.6.7.8';
      mockScrapeClient = {
        getScrapeJobStatus: sandbox.stub(),
      };
    });

    it('should return null and log warning when jobId is not provided', async () => {
      const result = await checkAndAlertBotProtection({
        jobId: null,
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.warn).to.have.been.calledWithMatch(/No jobId provided for bot protection check/);
    });

    it('should return null and log warning when jobId is empty string', async () => {
      const result = await checkAndAlertBotProtection({
        jobId: '',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.warn).to.have.been.calledWithMatch(/No jobId provided for bot protection check/);
    });

    it('should return null and log debug when job is not found', async () => {
      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(null);

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/Job not found: jobId=job-123/);
    });

    it('should return null and log debug when abortInfo is not present', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: null,
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/No abortInfo found: jobId=job-123/);
    });

    it('should return null and log debug when abortInfo reason is not bot-protection', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'timeout',
          details: {},
        },
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(
        /AbortInfo present but reason is not bot-protection/,
      );
    });

    it('should return null and log error when database query fails', async () => {
      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.rejects(new Error('Database connection error'));

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.error).to.have.been.calledWithMatch(
        /Failed to get bot protection stats from ScrapeJob/,
      );
    });

    it('should return null and log debug when convertAbortInfoToStats returns null', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'bot-protection',
          details: null, // This will cause convertAbortInfoToStats to return null
        },
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/No bot protection found: jobId=job-123/);
    });

    it('should detect bot protection and send Slack alert successfully', async function () {
      this.timeout(5000);
      const esmock = (await import('esmock')).default;

      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 5,
            totalUrlsCount: 10,
            byBlockerType: { cloudflare: 5 },
            byHttpStatus: { 403: 5 },
            blockedUrls: [],
          },
        },
      };

      const mockSay = sandbox.stub().resolves();
      const mockFormatBotProtectionSlackMessage = sandbox.stub().returns('Test message');
      const mockFetchRecentThreadMessages = sandbox.stub().resolves([]);
      const mockFormatAllowlistMessage = sandbox.stub().returns({
        ips: '1.2.3.4,5.6.7.8',
        userAgent: 'test-agent',
      });

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const { checkAndAlertBotProtection: checkAndAlert } = await esmock(
        '../../src/utils/bot-detection.js',
        {
          '@adobe/spacecat-shared-utils': {
            formatAllowlistMessage: mockFormatAllowlistMessage,
          },
          '../../src/utils/slack-utils.js': {
            say: mockSay,
            formatBotProtectionSlackMessage: mockFormatBotProtectionSlackMessage,
            fetchRecentThreadMessages: mockFetchRecentThreadMessages,
          },
        },
      );

      const result = await checkAndAlert({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.not.be.null;
      expect(result.totalCount).to.equal(5);
      expect(result.isPartial).to.be.false;
      expect(mockSay).to.have.been.called;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/\[BOT-BLOCKED\] Bot protection detected/);
    });

    it('should handle Slack alert failure gracefully and still return stats', async function () {
      this.timeout(5000);
      const esmock = (await import('esmock')).default;

      const mockJob = {
        id: 'job-123',
        status: 'RUNNING',
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 3,
            totalUrlsCount: 10,
            byBlockerType: { cloudflare: 3 },
            byHttpStatus: { 403: 3 },
            blockedUrls: [],
          },
        },
      };

      const mockSay = sandbox.stub().rejects(new Error('Slack API error'));
      const mockFormatBotProtectionSlackMessage = sandbox.stub().returns('Test message');
      const mockFetchRecentThreadMessages = sandbox.stub().resolves([]);
      const mockFormatAllowlistMessage = sandbox.stub().returns({
        ips: '1.2.3.4,5.6.7.8',
        userAgent: 'test-agent',
      });

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const { checkAndAlertBotProtection: checkAndAlert } = await esmock(
        '../../src/utils/bot-detection.js',
        {
          '@adobe/spacecat-shared-utils': {
            formatAllowlistMessage: mockFormatAllowlistMessage,
          },
          '../../src/utils/slack-utils.js': {
            say: mockSay,
            formatBotProtectionSlackMessage: mockFormatBotProtectionSlackMessage,
            fetchRecentThreadMessages: mockFetchRecentThreadMessages,
          },
        },
      );

      const result = await checkAndAlert({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.not.be.null;
      expect(result.totalCount).to.equal(3);
      expect(result.isPartial).to.be.true;
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Failed to send Slack alert/);
    });

    it('should handle empty SPACECAT_BOT_IPS', async function () {
      this.timeout(5000);
      const esmock = (await import('esmock')).default;

      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'bot-protection',
          details: {
            blockedUrlsCount: 5,
            totalUrlsCount: 10,
            byBlockerType: { cloudflare: 5 },
            byHttpStatus: { 403: 5 },
            blockedUrls: [],
          },
        },
      };

      const mockSay = sandbox.stub().resolves();
      const mockFormatBotProtectionSlackMessage = sandbox.stub().returns('Test message');
      const mockFetchRecentThreadMessages = sandbox.stub().resolves([]);
      const mockFormatAllowlistMessage = sandbox.stub().returns({
        ips: [],
        userAgent: 'test-agent',
      });

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      mockContext.env.SPACECAT_BOT_IPS = '';

      const { checkAndAlertBotProtection: checkAndAlert } = await esmock(
        '../../src/utils/bot-detection.js',
        {
          '@adobe/spacecat-shared-utils': {
            formatAllowlistMessage: mockFormatAllowlistMessage,
          },
          '../../src/utils/slack-utils.js': {
            say: mockSay,
            formatBotProtectionSlackMessage: mockFormatBotProtectionSlackMessage,
            fetchRecentThreadMessages: mockFetchRecentThreadMessages,
          },
        },
      );

      const result = await checkAndAlert({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.not.be.null;
      expect(mockFormatAllowlistMessage).to.have.been.calledWith('');
      expect(mockSay).to.have.been.called;
    });

    it('should handle job with undefined abortInfo', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        // abortInfo is undefined
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);
      mockScrapeClient.getScrapeJobStatus.resolves(mockJob);

      const result = await checkAndAlertBotProtection({
        jobId: 'job-123',
        siteUrl: 'https://test.com',
        slackContext: mockSlackContext,
        context: mockContext,
      });

      expect(result).to.be.null;
      expect(mockContext.log.debug).to.have.been.calledWithMatch(/No abortInfo found: jobId=job-123/);
    });
  });
});
