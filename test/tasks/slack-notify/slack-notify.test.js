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
import { MockContextBuilder } from '../../shared.js';

use(sinonChai);

describe('slack-notify handler', () => {
  let runSlackNotify;
  let sandbox;
  let context;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    context = new MockContextBuilder().withSandbox(sandbox).build();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns badRequest when slackContext.channelId is missing', async () => {
    const handlerModule = await esmock('../../../src/tasks/slack-notify/handler.js', {
      '@adobe/spacecat-shared-slack-client': {
        BaseSlackClient: { createFrom: sandbox.stub() },
        SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
      },
      '../../../src/utils/slack-utils.js': {
        say: sandbox.stub().resolves(),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: (s) => !!s && s.length > 0,
      },
    });
    runSlackNotify = handlerModule.runSlackNotify;

    const message = { slackContext: { channelId: '' }, text: 'hello' };
    const resp = await runSlackNotify(message, context);
    expect(resp.status).to.equal(400);
  });

  it('uses say() for simple text notifications (no blocks)', async () => {
    const sayStub = sandbox.stub().resolves();
    const handlerModule = await esmock('../../../src/tasks/slack-notify/handler.js', {
      '@adobe/spacecat-shared-slack-client': {
        BaseSlackClient: { createFrom: sandbox.stub() },
        SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
      },
      '../../../src/utils/slack-utils.js': {
        say: sayStub,
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
      },
    });
    runSlackNotify = handlerModule.runSlackNotify;

    const message = {
      slackContext: { channelId: 'C123', threadTs: '123.456' },
      text: 'Test text',
    };
    const resp = await runSlackNotify(message, context);
    expect(resp.status).to.equal(200);
    expect(sayStub).to.have.been.calledOnceWithExactly(
      context.env,
      context.log,
      { channelId: 'C123', threadTs: '123.456' },
      'Test text',
    );
  });

  it('uses Slack client for block messages', async () => {
    const postMessage = sandbox.stub().resolves();
    const baseCreateFrom = sandbox.stub().returns({ postMessage });
    const handlerModule = await esmock('../../../src/tasks/slack-notify/handler.js', {
      '@adobe/spacecat-shared-slack-client': {
        BaseSlackClient: { createFrom: baseCreateFrom },
        SLACK_TARGETS: { WORKSPACE_INTERNAL: 'workspace_internal' },
      },
      '../../../src/utils/slack-utils.js': {
        say: sandbox.stub().resolves(),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: () => true,
      },
    });
    runSlackNotify = handlerModule.runSlackNotify;

    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello' } }];
    const message = {
      slackContext: { channelId: 'C999', threadTs: '999.000' },
      text: 'fallback text',
      blocks,
    };
    const resp = await runSlackNotify(message, context);
    expect(resp.status).to.equal(200);
    expect(baseCreateFrom).to.have.been.calledOnce;
    expect(postMessage).to.have.been.calledOnceWith({
      channel: 'C999',
      thread_ts: '999.000',
      text: 'fallback text',
      blocks,
    });
  });
});
