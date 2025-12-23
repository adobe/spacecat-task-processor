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
import esmock from 'esmock';

use(sinonChai);

describe('slack-utils', () => {
  let say;
  let mockBaseSlackClient;
  let mockSlackClient;
  let mockHasText;

  beforeEach(async () => {
    // Create mock for BaseSlackClient
    mockSlackClient = {
      postMessage: sinon.stub().resolves(),
    };

    mockBaseSlackClient = {
      createFrom: sinon.stub().returns(mockSlackClient),
    };

    // Create mock for hasText utility
    mockHasText = sinon.stub();

    // Import the module with mocks
    const slackUtilsModule = await esmock('../../src/utils/slack-utils.js', {
      '@adobe/spacecat-shared-utils': {
        hasText: mockHasText,
      },
      '@adobe/spacecat-shared-slack-client': {
        BaseSlackClient: mockBaseSlackClient,
        SLACK_TARGETS: {
          WORKSPACE_INTERNAL: 'workspace_internal',
        },
      },
    });

    say = slackUtilsModule.say;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('say', () => {
    let log;
    let env;
    let slackContext;

    beforeEach(() => {
      log = { error: sinon.spy() };
      env = {
        SLACK_BOT_TOKEN: 'test-bot-token',
        SLACK_SIGNING_SECRET: 'test-signing-secret',
        SLACK_TOKEN_WORKSPACE_INTERNAL: 'test-workspace-token',
        SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: 'test-ops-channel',
      };
      slackContext = {
        channelId: 'C12345678',
        threadTs: '12345.67890',
      };
    });

    it('should send a message to Slack when all parameters are valid', async () => {
      mockHasText.returns(true);

      await say(env, log, slackContext, 'Test message');

      expect(mockBaseSlackClient.createFrom.calledOnce).to.be.true;
      expect(mockBaseSlackClient.createFrom.calledWith({
        channelId: 'C12345678',
        threadTs: '12345.67890',
        env: {
          SLACK_BOT_TOKEN: 'test-bot-token',
          SLACK_SIGNING_SECRET: 'test-signing-secret',
          SLACK_TOKEN_WORKSPACE_INTERNAL: 'test-workspace-token',
          SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: 'test-ops-channel',
        },
      }, 'workspace_internal')).to.be.true;

      expect(mockSlackClient.postMessage.calledOnce).to.be.true;
      expect(mockSlackClient.postMessage.calledWith({
        channel: 'C12345678',
        thread_ts: '12345.67890',
        text: 'Test message',
        unfurl_links: false,
      })).to.be.true;
    });

    it('should not send message if threadTs is missing or empty', async () => {
      mockHasText.withArgs('C12345678').returns(true);
      mockHasText.withArgs('').returns(false);

      slackContext.threadTs = '';
      await say(env, log, slackContext, 'Test message');

      expect(mockSlackClient.postMessage.called).to.be.false;
    });

    it('should not send message if channelId is missing or empty', async () => {
      mockHasText.withArgs('').returns(false);
      mockHasText.withArgs('12345.67890').returns(true);

      slackContext.channelId = '';
      await say(env, log, slackContext, 'Test message');

      expect(mockSlackClient.postMessage.called).to.be.false;
    });

    it('should not send message if both threadTs and channelId are missing', async () => {
      mockHasText.returns(false);

      slackContext.threadTs = '';
      slackContext.channelId = '';
      await say(env, log, slackContext, 'Test message');

      expect(mockSlackClient.postMessage.called).to.be.false;
    });

    it('should handle error when slackContext is null', async () => {
      await say(env, log, null, 'Test message');

      expect(log.error.calledOnce).to.be.true;
      expect(log.error.calledWith('Error sending Slack message:', {
        error: sinon.match.string,
        stack: sinon.match.string,
        errorType: sinon.match.string,
      })).to.be.true;
    });

    it('should handle error when slackContext is undefined', async () => {
      await say(env, log, undefined, 'Test message');

      expect(log.error.calledOnce).to.be.true;
      expect(log.error.calledWith('Error sending Slack message:', {
        error: sinon.match.string,
        stack: sinon.match.string,
        errorType: sinon.match.string,
      })).to.be.true;
    });

    it('should handle error when BaseSlackClient.createFrom throws', async () => {
      mockBaseSlackClient.createFrom.throws(new Error('Client creation failed'));

      await say(env, log, slackContext, 'Test message');

      expect(log.error.calledOnce).to.be.true;
      expect(log.error.calledWith('Error sending Slack message:', {
        error: 'Client creation failed',
        stack: sinon.match.string,
        errorType: 'Error',
      })).to.be.true;
    });

    it('should handle error when postMessage throws', async () => {
      mockHasText.returns(true);
      mockSlackClient.postMessage.rejects(new Error('Post message failed'));

      await say(env, log, slackContext, 'Test message');

      expect(log.error.calledOnce).to.be.true;
      expect(log.error.calledWith('Error sending Slack message:', {
        error: 'Post message failed',
        stack: sinon.match.string,
        errorType: 'Error',
      })).to.be.true;
    });

    it('should handle error when env is missing required properties', async () => {
      const incompleteEnv = {
        SLACK_BOT_TOKEN: 'test-bot-token',
        // Missing other required properties
      };

      // Make BaseSlackClient.createFrom throw when it receives incomplete env
      mockBaseSlackClient.createFrom.withArgs(sinon.match({
        env: sinon.match({
          SLACK_BOT_TOKEN: 'test-bot-token',
          SLACK_SIGNING_SECRET: undefined,
          SLACK_TOKEN_WORKSPACE_INTERNAL: undefined,
          SLACK_OPS_CHANNEL_WORKSPACE_INTERNAL: undefined,
        }),
      })).throws(new Error('Missing required environment variables'));

      await say(incompleteEnv, log, slackContext, 'Test message');

      expect(log.error.calledOnce).to.be.true;
      expect(log.error.calledWith('Error sending Slack message:', {
        error: 'Missing required environment variables',
        stack: sinon.match.string,
        errorType: 'Error',
      })).to.be.true;
    });

    it('should handle empty message string', async () => {
      mockHasText.returns(true);

      await say(env, log, slackContext, '');

      expect(mockSlackClient.postMessage.calledOnce).to.be.true;
      expect(mockSlackClient.postMessage.calledWith({
        channel: 'C12345678',
        thread_ts: '12345.67890',
        text: '',
        unfurl_links: false,
      })).to.be.true;
    });

    it('should handle null message', async () => {
      mockHasText.returns(true);

      await say(env, log, slackContext, null);

      expect(mockSlackClient.postMessage.calledOnce).to.be.true;
      expect(mockSlackClient.postMessage.calledWith({
        channel: 'C12345678',
        thread_ts: '12345.67890',
        text: null,
        unfurl_links: false,
      })).to.be.true;
    });
  });

  describe('formatBotProtectionSlackMessage', () => {
    let formatBotProtectionSlackMessage;

    beforeEach(async () => {
      // Import directly without esmock since we need the real implementation
      const slackUtilsModule = await import('../../src/utils/slack-utils.js');
      formatBotProtectionSlackMessage = slackUtilsModule.formatBotProtectionSlackMessage;
    });

    it('should format message with all parameters', () => {
      const message = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'cloudflare',
          confidence: 0.9,
          reason: 'Challenge page detected',
        },
        auditType: 'broken-backlinks',
        environment: 'prod',
        blockedCount: 2,
        totalCount: 3,
      });

      expect(message).to.include(':warning: *Bot Protection Detected during broken-backlinks audit*');
      expect(message).to.include('*Site:* https://example.com');
      expect(message).to.include('*Protection Type:* cloudflare');
      expect(message).to.include('*Confidence:* 90%');
      expect(message).to.include('*Blocked URLs:* 2/3 (67%)');
      expect(message).to.include('*Reason:* Challenge page detected');
      expect(message).to.include('*Production IPs to allowlist:*');
      // Check for actual production IPs from SPACECAT_BOT_IPS
      expect(message).to.include('• `3.218.16.42`');
      expect(message).to.include('• `52.55.82.37`');
      expect(message).to.include('• `54.172.145.38`');
    });

    it('should format message without blocked count', () => {
      const message = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'imperva',
          confidence: 0.85,
        },
        environment: 'dev',
      });

      expect(message).to.include(':warning: *Bot Protection Detected*');
      expect(message).to.not.include('*Blocked URLs:*');
      expect(message).to.include('*Development IPs to allowlist:*');
      // Check for actual development IPs from SPACECAT_BOT_IPS
      expect(message).to.include('• `44.218.57.115`');
      expect(message).to.include('• `54.87.205.187`');
    });

    it('should format message without reason', () => {
      const message = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'datadome',
          confidence: 0.8,
        },
      });

      expect(message).to.include('*Protection Type:* datadome');
      expect(message).to.not.include('*Reason:*');
    });

    it('should default to production environment', () => {
      const message = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'cloudflare',
          confidence: 0.9,
        },
      });

      expect(message).to.include('*Production IPs to allowlist:*');
      expect(message).to.include('• `3.218.16.42`');
    });

    it('should format message with audit type', () => {
      const message = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'perimeterx',
          confidence: 0.75,
        },
        auditType: 'canonical',
      });

      expect(message).to.include('during canonical audit');
    });

    it('should format message without audit type', () => {
      const message = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'akamai',
          confidence: 0.7,
        },
      });

      expect(message).to.include(':warning: *Bot Protection Detected*');
      expect(message).to.not.include('during');
    });
  });
});
