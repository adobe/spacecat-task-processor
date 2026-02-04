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
import { convertAbortInfoToStats, getBotProtectionFromDatabase } from '../../src/utils/cloudwatch-utils.js';

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
  });

  describe('getBotProtectionFromDatabase', () => {
    it('should return null when jobId is not provided', async () => {
      const result = await getBotProtectionFromDatabase(null, mockContext);
      expect(result).to.be.null;
    });

    it('should return null when job is not found', async () => {
      const mockScrapeClient = {
        getScrapeJobStatus: sandbox.stub().resolves(null),
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);
      expect(result).to.be.null;
    });

    it('should return null when abortInfo is not present', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: null,
      };

      const mockScrapeClient = {
        getScrapeJobStatus: sandbox.stub().resolves(mockJob),
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);
      expect(result).to.be.null;
    });

    it('should return null when abortInfo reason is not bot-protection', async () => {
      const mockJob = {
        id: 'job-123',
        status: 'COMPLETE',
        abortInfo: {
          reason: 'timeout',
          details: {},
        },
      };

      const mockScrapeClient = {
        getScrapeJobStatus: sandbox.stub().resolves(mockJob),
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);
      expect(result).to.be.null;
    });

    it('should return bot protection stats when abortInfo is present', async () => {
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

      const mockScrapeClient = {
        getScrapeJobStatus: sandbox.stub().resolves(mockJob),
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.not.be.null;
      expect(result.totalCount).to.equal(5);
      expect(result.isPartial).to.be.false;
      expect(mockContext.log.info).to.have.been.calledWithMatch(/Bot protection detected from database/);
    });

    it('should handle database errors gracefully', async () => {
      const mockScrapeClient = {
        getScrapeJobStatus: sandbox.stub().rejects(new Error('Database error')),
      };

      const ScrapeClientModule = await import('@adobe/spacecat-shared-scrape-client');
      sandbox.stub(ScrapeClientModule.ScrapeClient, 'createFrom').returns(mockScrapeClient);

      const result = await getBotProtectionFromDatabase('job-123', mockContext);

      expect(result).to.be.null;
      expect(mockContext.log.error).to.have.been.calledWithMatch(/Failed to get bot protection from database/);
    });
  });
});
