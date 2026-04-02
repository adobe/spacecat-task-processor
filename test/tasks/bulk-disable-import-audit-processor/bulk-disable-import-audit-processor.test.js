/*
 * Copyright 2026 Adobe. All rights reserved.
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

let runBulkDisableImportAuditProcessor;
let mockSay;

describe('Bulk Disable Import Audit Processor', () => {
  let context;
  let message;
  let mockSite;
  let mockSiteConfig;
  let mockConfiguration;
  let toDynamoItemStub;

  const serializedConfigFixture = { slack: {}, handlers: {}, imports: [] };

  beforeEach(async () => {
    sinon.restore();
    const sandbox = sinon.createSandbox();

    mockSay = sandbox.stub().resolves();
    toDynamoItemStub = sandbox.stub().returns(serializedConfigFixture);

    const handlerModule = await esmock('../../../src/tasks/bulk-disable-import-audit-processor/handler.js', {
      '../../../src/utils/slack-utils.js': { say: mockSay },
      '@adobe/spacecat-shared-data-access': {
        Config: { toDynamoItem: toDynamoItemStub },
      },
    });
    runBulkDisableImportAuditProcessor = handlerModule.runBulkDisableImportAuditProcessor;

    mockSiteConfig = {
      disableImport: sandbox.stub(),
    };

    mockSite = {
      getId: sandbox.stub().returns('site-id-1'),
      getConfig: sandbox.stub().returns(mockSiteConfig),
      setConfig: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    mockConfiguration = {
      disableHandlerForSite: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .build();

    context.dataAccess.Site.findByBaseURL = sandbox.stub().resolves(mockSite);
    context.dataAccess.Configuration.findLatest = sandbox.stub().resolves(mockConfiguration);

    message = {
      sites: [
        {
          siteId: 'site-id-1',
          siteUrl: 'https://example.com',
          importTypes: ['top-pages', 'organic-traffic'],
          auditTypes: ['cwv', 'meta-tags'],
        },
      ],
      taskContext: {
        slackContext: { channelId: 'C1', threadTs: 'ts1' },
        scheduledRun: false,
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('scheduledRun handling', () => {
    it('skips all processing when scheduledRun is true', async () => {
      message.taskContext.scheduledRun = true;

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Configuration.findLatest).to.not.have.been.called;
      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
      expect(mockSay).to.have.been.calledOnce;
      expect(mockSay.firstCall.args[3]).to.include('Scheduled run detected');
      const body = await result.json();
      expect(body.message).to.include('Scheduled run');
    });

    it('skips individual site when per-site scheduledRun is true', async () => {
      message.sites[0].scheduledRun = true;

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
      expect(mockConfiguration.disableHandlerForSite).to.not.have.been.called;

      const body = await result.json();
      expect(body.message).to.equal('Bulk disable import and audit processor completed');
      expect(body.results[0].status).to.equal('skipped');
    });

    it('processes other sites when only one has per-site scheduledRun true', async () => {
      const mockSite2 = {
        getId: sinon.stub().returns('site-id-2'),
        getConfig: sinon.stub().returns({ disableImport: sinon.stub() }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      // First site is skipped (scheduledRun=true); findByBaseURL is called once for site 2
      context.dataAccess.Site.findByBaseURL.resolves(mockSite2);

      message.sites = [
        {
          siteId: 's-1', siteUrl: 'https://example.com', scheduledRun: true, importTypes: ['top-pages'], auditTypes: [],
        },
        {
          siteId: 's-2', siteUrl: 'https://other.com', importTypes: [], auditTypes: ['cwv'],
        },
      ];

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://other.com');
      expect(mockSite2.save).to.have.been.calledOnce;
      const body = await result.json();
      expect(body.results[0].status).to.equal('skipped');
      expect(body.results[1].status).to.equal('disabled');
    });
  });

  describe('empty sites handling', () => {
    it('returns early when sites array is empty', async () => {
      message.sites = [];

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Configuration.findLatest).to.not.have.been.called;
      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
      const body = await result.json();
      expect(body.message).to.equal('No sites to process');
    });

    it('defaults sites to empty array when omitted from message', async () => {
      delete message.sites;

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Configuration.findLatest).to.not.have.been.called;
      const body = await result.json();
      expect(body.message).to.equal('No sites to process');
    });
  });

  describe('successful processing', () => {
    it('disables imports per site and saves configuration once for all sites', async () => {
      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Configuration.findLatest).to.have.been.calledOnce;
      expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledOnceWith('https://example.com');

      expect(mockSiteConfig.disableImport).to.have.been.calledWith('top-pages');
      expect(mockSiteConfig.disableImport).to.have.been.calledWith('organic-traffic');
      expect(toDynamoItemStub).to.have.been.calledOnceWith(mockSiteConfig);
      expect(mockSite.setConfig).to.have.been.calledOnceWith(serializedConfigFixture);
      expect(mockSite.save).to.have.been.calledOnce;

      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('cwv', mockSite);
      expect(mockConfiguration.disableHandlerForSite).to.have.been.calledWith('meta-tags', mockSite);

      // configuration.save called only once for all sites
      expect(mockConfiguration.save).to.have.been.calledOnce;

      const body = await result.json();
      expect(body.message).to.equal('Bulk disable import and audit processor completed');
      expect(body.results).to.have.length(1);
      expect(body.results[0].status).to.equal('disabled');
    });

    it('sends summary slack message for succeeded sites', async () => {
      await runBulkDisableImportAuditProcessor(message, context);

      const summaryCall = mockSay.getCalls().find((c) => c.args[3].includes(':broom:'));
      expect(summaryCall).to.exist;
      expect(summaryCall.args[3]).to.include('https://example.com');
      expect(summaryCall.args[3]).to.include('top-pages, organic-traffic');
      expect(summaryCall.args[3]).to.include('cwv, meta-tags');
    });

    it('does not send warning slack message when no sites fail', async () => {
      await runBulkDisableImportAuditProcessor(message, context);

      const warningCall = mockSay.getCalls().find((c) => c.args[3].includes(':warning:'));
      expect(warningCall).to.not.exist;
    });

    it('handles empty importTypes and auditTypes for a site', async () => {
      message.sites[0].importTypes = [];
      message.sites[0].auditTypes = [];

      await runBulkDisableImportAuditProcessor(message, context);

      expect(mockSiteConfig.disableImport).to.not.have.been.called;
      expect(mockConfiguration.disableHandlerForSite).to.not.have.been.called;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockConfiguration.save).to.have.been.calledOnce;

      const summaryCall = mockSay.getCalls().find((c) => c.args[3].includes(':broom:'));
      expect(summaryCall.args[3]).to.include('None');
    });

    it('defaults importTypes and auditTypes to empty arrays when omitted', async () => {
      message.sites[0] = { siteId: 's-1', siteUrl: 'https://example.com' };

      await runBulkDisableImportAuditProcessor(message, context);

      expect(mockSiteConfig.disableImport).to.not.have.been.called;
      expect(mockConfiguration.disableHandlerForSite).to.not.have.been.called;
      expect(mockSite.save).to.have.been.calledOnce;
    });

    it('processes multiple sites and calls configuration.save() only once', async () => {
      const mockSite2 = {
        getId: sinon.stub().returns('site-id-2'),
        getConfig: sinon.stub().returns({ disableImport: sinon.stub() }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      context.dataAccess.Site.findByBaseURL
        .onFirstCall().resolves(mockSite)
        .onSecondCall().resolves(mockSite2);

      message.sites = [
        {
          siteId: 's-1', siteUrl: 'https://example.com', importTypes: ['top-pages'], auditTypes: ['cwv'],
        },
        {
          siteId: 's-2', siteUrl: 'https://other.com', importTypes: ['organic-traffic'], auditTypes: ['meta-tags'],
        },
      ];

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledTwice;
      expect(mockSite.save).to.have.been.calledOnce;
      expect(mockSite2.save).to.have.been.calledOnce;
      // configuration.save called only once despite two sites
      expect(mockConfiguration.save).to.have.been.calledOnce;

      const body = await result.json();
      expect(body.results).to.have.length(2);
      expect(body.results.every((r) => r.status === 'disabled')).to.be.true;
    });

    it('sends combined summary for multiple succeeded sites', async () => {
      const mockSite2 = {
        getId: sinon.stub().returns('site-id-2'),
        getConfig: sinon.stub().returns({ disableImport: sinon.stub() }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      context.dataAccess.Site.findByBaseURL
        .onFirstCall().resolves(mockSite)
        .onSecondCall().resolves(mockSite2);

      message.sites = [
        {
          siteId: 's-1', siteUrl: 'https://example.com', importTypes: ['top-pages'], auditTypes: [],
        },
        {
          siteId: 's-2', siteUrl: 'https://other.com', importTypes: [], auditTypes: ['cwv'],
        },
      ];

      await runBulkDisableImportAuditProcessor(message, context);

      const summaryCall = mockSay.getCalls().find((c) => c.args[3].includes(':broom:'));
      expect(summaryCall.args[3]).to.include('https://example.com');
      expect(summaryCall.args[3]).to.include('https://other.com');
    });

    it('processes sites in parallel batches of 10', async () => {
      const siteEntries = Array.from({ length: 25 }, (_, i) => ({
        siteId: `site-${i}`,
        siteUrl: `https://site${i}.com`,
        importTypes: [],
        auditTypes: [],
      }));
      context.dataAccess.Site.findByBaseURL.resolves(mockSite);
      message.sites = siteEntries;

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Site.findByBaseURL).to.have.callCount(25);
      expect(mockConfiguration.save).to.have.been.calledOnce;

      const body = await result.json();
      expect(body.results).to.have.length(25);
    });
  });

  describe('site not found handling', () => {
    it('records not_found and continues when site is missing', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.log.warn).to.have.been.calledWithMatch(/Site not found/);
      expect(mockSiteConfig.disableImport).to.not.have.been.called;
      expect(mockSite.save).to.not.have.been.called;
      // configuration.save still called (no sites succeeded but still saves once)
      expect(mockConfiguration.save).to.have.been.calledOnce;

      const body = await result.json();
      expect(body.results[0].status).to.equal('not_found');
    });

    it('sends warning slack message when some sites are not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);

      await runBulkDisableImportAuditProcessor(message, context);

      const warningCall = mockSay.getCalls().find((c) => c.args[3].includes(':warning:'));
      expect(warningCall).to.exist;
      expect(warningCall.args[3]).to.include('not_found');
    });

    it('continues processing remaining sites when one is not found', async () => {
      const mockSite2 = {
        getId: sinon.stub().returns('site-id-2'),
        getConfig: sinon.stub().returns({ disableImport: sinon.stub() }),
        setConfig: sinon.stub(),
        save: sinon.stub().resolves(),
      };
      context.dataAccess.Site.findByBaseURL
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(mockSite2);

      message.sites = [
        {
          siteId: 's-1', siteUrl: 'https://missing.com', importTypes: ['top-pages'], auditTypes: [],
        },
        {
          siteId: 's-2', siteUrl: 'https://found.com', importTypes: [], auditTypes: ['cwv'],
        },
      ];

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(mockSite2.save).to.have.been.calledOnce;
      const body = await result.json();
      expect(body.results).to.have.length(2);
      expect(body.results[0].status).to.equal('not_found');
      expect(body.results[1].status).to.equal('disabled');
    });
  });

  describe('per-site error handling', () => {
    it('records error and continues when site processing throws', async () => {
      const dbError = new Error('DB connection lost');
      context.dataAccess.Site.findByBaseURL.rejects(dbError);

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.log.error).to.have.been.calledWithMatch(/Error processing site/);
      expect(mockConfiguration.save).to.have.been.calledOnce;

      const body = await result.json();
      expect(body.results[0].status).to.equal('error');
      expect(body.results[0].error).to.equal('Site processing failed');
    });

    it('records error and continues when site.save throws', async () => {
      mockSite.save.rejects(new Error('site save failed'));

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.log.error).to.have.been.calledWithMatch(/Error processing site/);
      const body = await result.json();
      expect(body.results[0].status).to.equal('error');
    });

    it('sends warning slack message when sites have errors', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('DB error'));

      await runBulkDisableImportAuditProcessor(message, context);

      const warningCall = mockSay.getCalls().find((c) => c.args[3].includes(':warning:'));
      expect(warningCall).to.exist;
    });

    it('does not include internal error details in slack warning message', async () => {
      context.dataAccess.Site.findByBaseURL.rejects(new Error('arn:aws:dynamodb:us-east-1:123456789:table/Sites'));

      await runBulkDisableImportAuditProcessor(message, context);

      const warningCall = mockSay.getCalls().find((c) => c.args[3].includes(':warning:'));
      expect(warningCall).to.exist;
      expect(warningCall.args[3]).to.not.include('arn:aws');
    });
  });

  describe('siteUrl validation', () => {
    it('records error when siteUrl is missing from site entry', async () => {
      message.sites[0] = { siteId: 'site-id-1', importTypes: ['top-pages'], auditTypes: [] };

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
      expect(context.log.warn).to.have.been.calledWithMatch(/missing siteUrl/);

      const body = await result.json();
      expect(body.results[0].status).to.equal('error');
      expect(body.results[0].error).to.equal('Missing siteUrl');
    });

    it('records error when siteUrl is null', async () => {
      message.sites[0] = {
        siteId: 'site-id-1', siteUrl: null, importTypes: [], auditTypes: [],
      };

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
      const body = await result.json();
      expect(body.results[0].status).to.equal('error');
    });
  });

  describe('Configuration.findLatest() failure', () => {
    it('returns 500 and sends slack error when Configuration.findLatest throws', async () => {
      context.dataAccess.Configuration.findLatest.rejects(new Error('DynamoDB unavailable'));

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(result.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWithMatch(/Failed to load configuration/);

      const errorCall = mockSay.getCalls().find((c) => c.args[3].includes(':x:'));
      expect(errorCall).to.exist;
      expect(errorCall.args[3]).to.not.include('DynamoDB');

      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
    });

    it('does not process any sites when Configuration.findLatest fails', async () => {
      context.dataAccess.Configuration.findLatest.rejects(new Error('timeout'));

      await runBulkDisableImportAuditProcessor(message, context);

      expect(mockSite.save).to.not.have.been.called;
      expect(mockConfiguration.save).to.not.have.been.called;
    });
  });

  describe('configuration.save() failure', () => {
    it('returns 500 when configuration.save fails', async () => {
      const configError = new Error('DynamoDB write failed');
      mockConfiguration.save.rejects(configError);

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(result.status).to.equal(500);
      expect(context.log.error).to.have.been.calledWithMatch(/Failed to save configuration/);
      expect(mockSay).to.have.been.calledWithMatch(sinon.match.any, sinon.match.any, sinon.match.any, sinon.match(/:x:/));
    });

    it('sends slack error message with site count when configuration.save fails', async () => {
      mockConfiguration.save.rejects(new Error('timeout'));

      await runBulkDisableImportAuditProcessor(message, context);

      const errorCall = mockSay.getCalls().find((c) => c.args[3].includes(':x:'));
      expect(errorCall).to.exist;
      expect(errorCall.args[3]).to.include('1 sites');
    });

    it('does not include internal error details in slack error message', async () => {
      mockConfiguration.save.rejects(new Error('arn:aws:dynamodb:us-east-1:123456789:table/Config'));

      await runBulkDisableImportAuditProcessor(message, context);

      const errorCall = mockSay.getCalls().find((c) => c.args[3].includes(':x:'));
      expect(errorCall).to.exist;
      expect(errorCall.args[3]).to.not.include('arn:aws');
    });
  });

  describe('slack notifications', () => {
    it('does not send summary message when no sites succeeded', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);

      await runBulkDisableImportAuditProcessor(message, context);

      const summaryCall = mockSay.getCalls().find((c) => c.args[3].includes(':broom:'));
      expect(summaryCall).to.not.exist;
    });

    it('passes slackContext from taskContext to say()', async () => {
      await runBulkDisableImportAuditProcessor(message, context);

      const summaryCall = mockSay.getCalls().find((c) => c.args[3].includes(':broom:'));
      expect(summaryCall.args[2]).to.deep.equal({ channelId: 'C1', threadTs: 'ts1' });
    });

    it('logs error but does not throw when slack summary say() fails', async () => {
      mockSay.onFirstCall().rejects(new Error('Slack API unavailable'));

      const result = await runBulkDisableImportAuditProcessor(message, context);

      expect(context.log.error).to.have.been.calledWithMatch(/Failed to send Slack summary/);
      // All data was already written — result is still 200
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.message).to.equal('Bulk disable import and audit processor completed');
    });
  });
});
