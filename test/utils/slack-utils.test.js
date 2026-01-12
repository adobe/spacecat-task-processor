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
      const slackUtilsModule = await import('../../src/utils/slack-utils.js');
      formatBotProtectionSlackMessage = slackUtilsModule.formatBotProtectionSlackMessage;
    });

    it('should format message with sample URLs when count <= 3', () => {
      const stats = {
        totalCount: 3,
        highConfidenceCount: 2,
        byHttpStatus: { 403: 3 },
        byBlockerType: { cloudflare: 3 },
        urls: [
          { url: 'https://test.com/1', httpStatus: 403, blockerType: 'cloudflare' },
          { url: 'https://test.com/2', httpStatus: 403, blockerType: 'cloudflare' },
          { url: 'https://test.com/3', httpStatus: 403, blockerType: 'cloudflare' },
        ],
      };

      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://test.com',
        stats,
        allowlistIps: ['1.2.3.4', '5.6.7.8'],
        allowlistUserAgent: 'TestBot/1.0',
      });

      expect(result).to.be.a('string');
      expect(result).to.include('3 URL'); // Changed: no longer shows "of X"
      expect(result).to.not.include('... and');
    });

    it('should format message with "and X more" when count > 3', () => {
      const stats = {
        totalCount: 5,
        highConfidenceCount: 4,
        byHttpStatus: { 403: 5 },
        byBlockerType: { cloudflare: 5 },
        urls: [
          { url: 'https://test.com/1', httpStatus: 403, blockerType: 'cloudflare' },
          { url: 'https://test.com/2', httpStatus: 403, blockerType: 'cloudflare' },
          { url: 'https://test.com/3', httpStatus: 403, blockerType: 'cloudflare' },
          { url: 'https://test.com/4', httpStatus: 403, blockerType: 'cloudflare' },
          { url: 'https://test.com/5', httpStatus: 403, blockerType: 'cloudflare' },
        ],
      };

      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://test.com',
        stats,
        allowlistIps: ['1.2.3.4', '5.6.7.8'],
        allowlistUserAgent: 'TestBot/1.0',
      });

      expect(result).to.be.a('string');
      expect(result).to.include('5 URL'); // Changed: no longer shows "of X"
      expect(result).to.include('... and 2 more URLs');
    });
  });
});
