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
import { queryBotProtectionLogs, aggregateBotProtectionStats } from '../../src/utils/cloudwatch-utils.js';

describe('CloudWatch Utils', () => {
  let cloudWatchStub;
  let mockContext;

  beforeEach(() => {
    cloudWatchStub = sinon.stub(CloudWatchLogsClient.prototype, 'send');
    mockContext = {
      env: {
        AWS_REGION: 'us-east-1',
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
      // One warning: the second message matches pattern but has invalid JSON
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
          url: 'https://test.com/3', httpStatus: 401, blockerType: 'akamai', confidence: 0.8,
        },
      ];

      const result = aggregateBotProtectionStats(events);

      expect(result.totalCount).to.equal(3);
      expect(result.highConfidenceCount).to.equal(2);
      expect(result.byHttpStatus).to.deep.equal({ 403: 2, 401: 1 });
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
});
