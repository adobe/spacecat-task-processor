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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('disable-import-audit-processor handler', () => {
  let sandbox;
  let context;
  let message;
  let mockSite;
  let mockSiteConfig;
  let mockConfiguration;
  let mockSay;
  let runDisableImportAuditProcessor;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    mockSay = sandbox.stub().resolves();

    const handlerModule = await esmock('../../../src/tasks/disable-import-audit-processor/handler.js', {
      '../../../src/utils/slack-utils.js': { say: mockSay },
      '@adobe/spacecat-shared-data-access': {
        Config: { toDynamoItem: sandbox.stub().returns({}) },
      },
    });
    runDisableImportAuditProcessor = handlerModule.runDisableImportAuditProcessor;

    mockSiteConfig = {
      disableImport: sandbox.stub(),
    };

    mockSite = {
      getConfig: sandbox.stub().returns(mockSiteConfig),
      setConfig: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    mockConfiguration = {
      isHandlerEnabledForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    context = {
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
        warn: sandbox.stub(),
      },
      env: {},
      dataAccess: {
        Site: { findByBaseURL: sandbox.stub().resolves(mockSite) },
        Configuration: { findLatest: sandbox.stub().resolves(mockConfiguration) },
      },
    };

    message = {
      siteId: 'site-123',
      siteUrl: 'https://example.com',
      organizationId: 'org-123',
      taskContext: {
        importTypes: ['traffic-analysis'],
        auditTypes: ['cwv', 'apex'],
        scheduledRun: false,
        slackContext: null,
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('skips all disabling when scheduledRun is true', async () => {
    message.taskContext.scheduledRun = true;

    const result = await runDisableImportAuditProcessor(message, context);

    expect(result.status).to.equal(200);
    expect(context.dataAccess.Site.findByBaseURL).not.to.have.been.called;
    expect(context.dataAccess.Configuration.findLatest).not.to.have.been.called;
    expect(context.log.info.calledWith(sinon.match(/Scheduled run detected/))).to.be.true;
  });

  it('disables imports and enabled audits for non-scheduled site', async () => {
    mockConfiguration.isHandlerEnabledForSite.withArgs('cwv', mockSite).returns(true);
    mockConfiguration.isHandlerEnabledForSite.withArgs('apex', mockSite).returns(true);

    await runDisableImportAuditProcessor(message, context);

    expect(mockSiteConfig.disableImport).to.have.been.calledWith('traffic-analysis');
    expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('cwv', mockSite);
    expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('apex', mockSite);
    expect(mockConfiguration.save).to.have.been.calledOnce;
    expect(mockSite.save).to.have.been.calledOnce;
  });

  it('is a no-op for audits that are already disabled', async () => {
    mockConfiguration.isHandlerEnabledForSite.returns(false);

    await runDisableImportAuditProcessor(message, context);

    expect(mockConfiguration.disableHandlerForSite).not.to.have.been.called;
    expect(mockConfiguration.save).not.to.have.been.called;
  });

  it('only disables audits that are currently enabled', async () => {
    mockConfiguration.isHandlerEnabledForSite.withArgs('cwv', mockSite).returns(true);
    mockConfiguration.isHandlerEnabledForSite.withArgs('apex', mockSite).returns(false);

    await runDisableImportAuditProcessor(message, context);

    expect(mockConfiguration.disableHandlerForSite).to.have.been.calledOnceWith('cwv', mockSite);
    expect(mockConfiguration.save).to.have.been.calledOnce;
  });

  it('skips audit disable when auditTypes is empty', async () => {
    message.taskContext.auditTypes = [];

    await runDisableImportAuditProcessor(message, context);

    expect(mockConfiguration.isHandlerEnabledForSite).not.to.have.been.called;
    expect(mockConfiguration.disableHandlerForSite).not.to.have.been.called;
    expect(mockConfiguration.save).not.to.have.been.called;
    expect(mockSite.save).to.have.been.calledOnce;
  });

  it('handles missing site gracefully', async () => {
    context.dataAccess.Site.findByBaseURL.resolves(null);

    const result = await runDisableImportAuditProcessor(message, context);

    expect(result.status).to.equal(200);
    expect(context.log.error.calledWith(
      'Error in disable import and audit processor:',
      sinon.match.instanceOf(Error),
    )).to.be.true;
  });

  it('returns 200 on success', async () => {
    mockConfiguration.isHandlerEnabledForSite.returns(false);

    const result = await runDisableImportAuditProcessor(message, context);

    expect(result.status).to.equal(200);
  });
});
