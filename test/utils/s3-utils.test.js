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
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getObjectFromKey } from '../../src/utils/s3-utils.js';

describe('S3 Utils', () => {
  let mockS3Client;
  let mockLog;

  beforeEach(() => {
    mockS3Client = {
      send: sinon.stub(),
    };

    mockLog = {
      error: sinon.stub(),
      warn: sinon.stub(),
      info: sinon.stub(),
      debug: sinon.stub(),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getObjectFromKey', () => {
    it('should successfully fetch and parse JSON content', async () => {
      const jsonData = { test: 'data', botProtection: { type: 'cloudflare' } };
      const mockResponse = {
        ContentType: 'application/json',
        Body: {
          transformToString: sinon.stub().resolves(JSON.stringify(jsonData)),
        },
      };

      mockS3Client.send.resolves(mockResponse);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'test-key.json',
        mockLog,
      );

      expect(result).to.deep.equal(jsonData);
      expect(mockS3Client.send).to.have.been.calledOnce;
      expect(mockLog.error).to.not.have.been.called;

      // Verify the command
      const command = mockS3Client.send.firstCall.args[0];
      expect(command).to.be.instanceOf(GetObjectCommand);
      expect(command.input.Bucket).to.equal('test-bucket');
      expect(command.input.Key).to.equal('test-key.json');
    });

    it('should return raw text for non-JSON content', async () => {
      const textContent = '<html><body>Test HTML</body></html>';
      const mockResponse = {
        ContentType: 'text/html',
        Body: {
          transformToString: sinon.stub().resolves(textContent),
        },
      };

      mockS3Client.send.resolves(mockResponse);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'test-key.html',
        mockLog,
      );

      expect(result).to.equal(textContent);
      expect(mockS3Client.send).to.have.been.calledOnce;
      expect(mockLog.error).to.not.have.been.called;
    });

    it('should handle JSON parse errors gracefully', async () => {
      const invalidJson = '{ invalid json }';
      const mockResponse = {
        ContentType: 'application/json',
        Body: {
          transformToString: sinon.stub().resolves(invalidJson),
        },
      };

      mockS3Client.send.resolves(mockResponse);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'invalid.json',
        mockLog,
      );

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledOnce;
      expect(mockLog.error.firstCall.args[0]).to.include('Unable to parse JSON content');
    });

    it('should handle S3 errors and log them', async () => {
      const s3Error = new Error('S3 access denied');
      mockS3Client.send.rejects(s3Error);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'test-key.json',
        mockLog,
      );

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledOnce;
      expect(mockLog.error.firstCall.args[0]).to.include('Error while fetching S3 object');
      expect(mockLog.error.firstCall.args[0]).to.include('test-bucket');
      expect(mockLog.error.firstCall.args[0]).to.include('test-key.json');
    });

    it('should return null when s3Client is missing', async () => {
      const result = await getObjectFromKey(
        null,
        'test-bucket',
        'test-key.json',
        mockLog,
      );

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledOnce;
      expect(mockLog.error.firstCall.args[0]).to.include('Invalid input parameters');
      expect(mockS3Client.send).to.not.have.been.called;
    });

    it('should return null when bucketName is missing', async () => {
      const result = await getObjectFromKey(
        mockS3Client,
        null,
        'test-key.json',
        mockLog,
      );

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledOnce;
      expect(mockLog.error.firstCall.args[0]).to.include('Invalid input parameters');
      expect(mockS3Client.send).to.not.have.been.called;
    });

    it('should return null when key is missing', async () => {
      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        null,
        mockLog,
      );

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledOnce;
      expect(mockLog.error.firstCall.args[0]).to.include('Invalid input parameters');
      expect(mockS3Client.send).to.not.have.been.called;
    });

    it('should handle empty string parameters', async () => {
      const result = await getObjectFromKey(
        mockS3Client,
        '',
        '',
        mockLog,
      );

      expect(result).to.be.null;
      expect(mockLog.error).to.have.been.calledOnce;
      expect(mockLog.error.firstCall.args[0]).to.include('Invalid input parameters');
      expect(mockS3Client.send).to.not.have.been.called;
    });

    it('should parse JSON when ContentType includes application/json', async () => {
      const jsonData = { status: 'success' };
      const mockResponse = {
        ContentType: 'application/json; charset=utf-8',
        Body: {
          transformToString: sinon.stub().resolves(JSON.stringify(jsonData)),
        },
      };

      mockS3Client.send.resolves(mockResponse);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'test.json',
        mockLog,
      );

      expect(result).to.deep.equal(jsonData);
    });

    it('should return raw text when ContentType is undefined', async () => {
      const textContent = 'plain text content';
      const mockResponse = {
        ContentType: undefined,
        Body: {
          transformToString: sinon.stub().resolves(textContent),
        },
      };

      mockS3Client.send.resolves(mockResponse);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'test.txt',
        mockLog,
      );

      expect(result).to.equal(textContent);
    });

    it('should handle complex nested JSON objects', async () => {
      const complexJson = {
        url: 'https://example.com',
        status: 'COMPLETE',
        botProtection: {
          detected: true,
          type: 'cloudflare',
          blocked: true,
          confidence: 0.95,
          details: {
            httpStatus: 403,
            htmlLength: 1234,
            title: 'Challenge',
          },
        },
      };
      const mockResponse = {
        ContentType: 'application/json',
        Body: {
          transformToString: sinon.stub().resolves(JSON.stringify(complexJson)),
        },
      };

      mockS3Client.send.resolves(mockResponse);

      const result = await getObjectFromKey(
        mockS3Client,
        'test-bucket',
        'scrape.json',
        mockLog,
      );

      expect(result).to.deep.equal(complexJson);
      expect(result.botProtection.details.httpStatus).to.equal(403);
    });
  });
});
