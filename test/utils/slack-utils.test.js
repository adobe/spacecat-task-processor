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
        slackBotToken: 'test-bot-token',
        slackSigningSecret: 'test-signing-secret',
        slackTokenWorkspaceInternal: 'test-workspace-token',
        slackOpsChannelWorkspaceInternal: 'test-ops-channel',
      };
      slackContext = {
        channelId: 'C12345678',
        threadTs: '12345.67890',
      };
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
});
