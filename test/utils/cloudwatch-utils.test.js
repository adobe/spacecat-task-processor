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
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { getAuditStatus } from '../../src/utils/cloudwatch-utils.js';

describe('CloudWatch Utils', () => {
  let mockContext;
  let sandbox;
  let mockSendStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockContext = {
      env: {
        AWS_REGION: 'us-east-1',
        AUDIT_WORKER_LOG_GROUP: '/aws/lambda/spacecat-services--audit-worker',
      },
      log: {
        info: sandbox.stub(),
        debug: sandbox.stub(),
        warn: sandbox.stub(),
        error: sandbox.stub(),
      },
    };

    // Stub CloudWatchLogsClient.prototype.send
    mockSendStub = sandbox.stub(CloudWatchLogsClient.prototype, 'send');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getAuditStatus', () => {
    const auditType = 'cwv';
    const siteId = 'test-site-id';
    const onboardStartTime = Date.now() - 3600000; // 1 hour ago

    it('should return executed: false when no execution log found', async () => {
      mockSendStub.resolves({
        events: [],
      });

      const result = await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      expect(result).to.deep.equal({ executed: false, failureReason: null });
      expect(mockSendStub).to.have.been.calledOnce;
      expect(mockContext.log.error).to.not.have.been.called;
    });

    it('should return executed: true, failureReason: null when audit executed successfully', async () => {
      // First call: execution found
      mockSendStub.onFirstCall().resolves({
        events: [
          { message: `Received ${auditType} audit request for: ${siteId}` },
        ],
      });

      // Second call: no failure found
      mockSendStub.onSecondCall().resolves({
        events: [],
      });

      const result = await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      expect(result).to.deep.equal({ executed: true, failureReason: null });
      expect(mockSendStub).to.have.been.calledTwice;
    });

    it('should return executed: true with failureReason when audit failed', async () => {
      const failureMessage = `${auditType} audit for ${siteId} failed. Reason: Connection timeout`;

      // First call: execution found
      mockSendStub.onFirstCall().resolves({
        events: [
          { message: `Received ${auditType} audit request for: ${siteId}` },
        ],
      });

      // Second call: failure found
      mockSendStub.onSecondCall().resolves({
        events: [
          { message: failureMessage },
        ],
      });

      const result = await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      expect(result).to.deep.equal({
        executed: true,
        failureReason: 'Connection timeout',
      });
      expect(mockSendStub).to.have.been.calledTwice;
    });

    it('should extract failure reason from message with stack trace', async () => {
      const failureMessage = `${auditType} audit for ${siteId} failed. Reason: Database error at Error: ...`;

      mockSendStub.onFirstCall().resolves({
        events: [
          { message: `Received ${auditType} audit request for: ${siteId}` },
        ],
      });

      mockSendStub.onSecondCall().resolves({
        events: [
          { message: failureMessage },
        ],
      });

      const result = await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      expect(result.failureReason).to.equal('Database error');
    });

    it('should return full message as failureReason when no reason pattern matches', async () => {
      const failureMessage = `${auditType} audit for ${siteId} failed with unknown error format`;

      mockSendStub.onFirstCall().resolves({
        events: [
          { message: `Received ${auditType} audit request for: ${siteId}` },
        ],
      });

      mockSendStub.onSecondCall().resolves({
        events: [
          { message: failureMessage },
        ],
      });

      const result = await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      expect(result.failureReason).to.equal(failureMessage);
    });

    it('should use custom log group from env if provided', async () => {
      mockContext.env.AUDIT_WORKER_LOG_GROUP = '/custom/log/group';
      mockSendStub.resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      const { firstCall } = mockSendStub;
      expect(firstCall.args[0]).to.be.instanceOf(FilterLogEventsCommand);
      expect(firstCall.args[0].input.logGroupName).to.equal('/custom/log/group');
    });

    it('should use default log group when env variable not set', async () => {
      delete mockContext.env.AUDIT_WORKER_LOG_GROUP;
      mockSendStub.resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      const { firstCall } = mockSendStub;
      expect(firstCall.args[0].input.logGroupName).to.equal('/aws/lambda/spacecat-services--audit-worker');
    });

    it('should use default AWS_REGION when not provided', async () => {
      delete mockContext.env.AWS_REGION;
      mockSendStub.resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      // CloudWatchLogsClient should be created with default region
      expect(mockSendStub).to.have.been.called;
    });

    it('should calculate search window with 5 minute buffer for execution check', async () => {
      const now = Date.now();
      const onboardTime = now - 3600000; // 1 hour ago
      mockSendStub.resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardTime, mockContext);

      const { firstCall } = mockSendStub;
      const command = firstCall.args[0];
      const expectedStartTime = onboardTime - (5 * 60 * 1000); // 5 min buffer

      // Allow 1 second tolerance for timing
      expect(command.input.startTime).to.be.closeTo(expectedStartTime, 1000);
      expect(command.input.endTime).to.be.closeTo(now, 1000);
    });

    it('should calculate search window with 30 second buffer for failure check', async () => {
      const now = Date.now();
      const onboardTime = now - 3600000; // 1 hour ago

      mockSendStub.onFirstCall().resolves({
        events: [
          { message: `Received ${auditType} audit request for: ${siteId}` },
        ],
      });
      mockSendStub.onSecondCall().resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardTime, mockContext);

      const { secondCall } = mockSendStub;
      const command = secondCall.args[0];
      const expectedStartTime = onboardTime - (30 * 1000); // 30 sec buffer

      // Allow 1 second tolerance for timing
      expect(command.input.startTime).to.be.closeTo(expectedStartTime, 1000);
    });

    it('should use 30 minute fallback when onboardStartTime is not provided', async () => {
      const now = Date.now();
      mockSendStub.resolves({ events: [] });

      await getAuditStatus(auditType, siteId, null, mockContext);

      const { firstCall } = mockSendStub;
      const command = firstCall.args[0];
      const expectedStartTime = now - (30 * 60 * 1000); // 30 min fallback

      // Allow 1 second tolerance for timing
      expect(command.input.startTime).to.be.closeTo(expectedStartTime, 1000);
    });

    it('should handle CloudWatch API errors gracefully', async () => {
      const error = new Error('CloudWatch API error');
      mockSendStub.rejects(error);

      const result = await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      expect(result).to.deep.equal({ executed: false, failureReason: null });
      expect(mockContext.log.error).to.have.been.calledWithMatch(
        /Error getting audit status for cwv/,
      );
      expect(mockContext.log.error.firstCall.args[1]).to.equal(error);
    });

    it('should use correct filter pattern for execution check', async () => {
      mockSendStub.resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      const { firstCall } = mockSendStub;
      const command = firstCall.args[0];
      expect(command.input.filterPattern).to.equal(`"Received ${auditType} audit request for: ${siteId}"`);
    });

    it('should use correct filter pattern for failure check', async () => {
      mockSendStub.onFirstCall().resolves({
        events: [
          { message: `Received ${auditType} audit request for: ${siteId}` },
        ],
      });
      mockSendStub.onSecondCall().resolves({ events: [] });

      await getAuditStatus(auditType, siteId, onboardStartTime, mockContext);

      const { secondCall } = mockSendStub;
      const command = secondCall.args[0];
      expect(command.input.filterPattern).to.equal(`"${auditType} audit for ${siteId} failed"`);
    });
  });
});
