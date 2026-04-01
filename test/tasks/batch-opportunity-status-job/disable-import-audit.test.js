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
import esmock from 'esmock';
import { MockContextBuilder } from '../../shared.js';

const SITE_ID_1 = 'site-id-1';
const SITE_ID_2 = 'site-id-2';
const BASE_URL_1 = 'https://site1.com';
const BASE_URL_2 = 'https://site2.com';

function makeSiteResult(siteId, baseUrl) {
  return {
    result: {
      siteId, baseUrl, found: [], notFound: [], dataSources: {},
    },
  };
}

function createMockSite(sandbox) {
  const siteConfig = {
    disableImport: sandbox.stub(),
  };
  return {
    getConfig: sandbox.stub().returns(siteConfig),
    setConfig: sandbox.stub(),
    save: sandbox.stub().resolves(),
    siteConfig,
  };
}

function createMockConfiguration(sandbox) {
  return {
    disableHandlerForSite: sandbox.stub(),
    save: sandbox.stub().resolves(),
  };
}

const BASE_TASK_CONTEXT = {
  importTypes: ['ahrefs-organic-keywords'],
  auditTypes: ['cwv'],
  scheduledRun: false,
};

describe('Batch Disable Import Audit Job', () => {
  let sandbox;
  let mockContext;
  let mockSite1;
  let mockSite2;
  let mockConfiguration;
  let ConfigMock;
  let runBatchDisableImportAuditJob;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    mockSite1 = createMockSite(sandbox);
    mockSite2 = createMockSite(sandbox);
    mockConfiguration = createMockConfiguration(sandbox);
    ConfigMock = { toDynamoItem: sandbox.stub().returns({}) };

    mockContext = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Site: { findById: sandbox.stub() },
        Configuration: { findLatest: sandbox.stub().resolves(mockConfiguration) },
      })
      .build();

    runBatchDisableImportAuditJob = (await esmock(
      '../../../src/tasks/batch-opportunity-status-job/disable-import-audit.js',
      {
        '@adobe/spacecat-shared-data-access': { Config: ConfigMock },
      },
    )).runBatchDisableImportAuditJob;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('scheduledRun flag', () => {
    it('skips all disabling when scheduledRun is true', async () => {
      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: { ...BASE_TASK_CONTEXT, scheduledRun: true },
        },
        mockContext,
      );
      const body = await result.json();

      expect(mockContext.dataAccess.Site.findById.called).to.be.false;
      expect(body.message).to.include('Scheduled run');
      expect(body.disableResults).to.deep.equal([]);
      expect(body.siteResults).to.have.length(1);
    });
  });

  describe('nothing to disable', () => {
    it('skips processing when both importTypes and auditTypes are empty', async () => {
      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: { importTypes: [], auditTypes: [], scheduledRun: false },
        },
        mockContext,
      );
      const body = await result.json();

      expect(mockContext.dataAccess.Site.findById.called).to.be.false;
      expect(body.message).to.include('Nothing to disable');
      expect(body.disableResults).to.deep.equal([]);
    });
  });

  describe('happy path', () => {
    it('disables imports and audits for a single site', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite1);

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(mockSite1.siteConfig.disableImport.calledWith('ahrefs-organic-keywords')).to.be.true;
      expect(mockConfiguration.disableHandlerForSite.calledWith('cwv', mockSite1)).to.be.true;
      expect(mockSite1.save.calledOnce).to.be.true;
      expect(mockConfiguration.save.calledOnce).to.be.true;
      expect(body.disableResults).to.have.length(1);
      expect(body.disableResults[0]).to.deep.include({ siteId: SITE_ID_1, disabled: true });
    });

    it('disables imports and audits for multiple sites sequentially', async () => {
      mockContext.dataAccess.Site.findById
        .onFirstCall().resolves(mockSite1)
        .onSecondCall().resolves(mockSite2);

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [
            makeSiteResult(SITE_ID_1, BASE_URL_1),
            makeSiteResult(SITE_ID_2, BASE_URL_2),
          ],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(mockContext.dataAccess.Site.findById.calledTwice).to.be.true;
      expect(body.disableResults).to.have.length(2);
      expect(body.disableResults.every((r) => r.disabled)).to.be.true;
      expect(body.message).to.include('2 succeeded');
    });

    it('passes siteResults through unchanged for the downstream notifier', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite1);
      const siteResults = [makeSiteResult(SITE_ID_1, BASE_URL_1)];

      const result = await runBatchDisableImportAuditJob(
        { siteResults, taskContext: BASE_TASK_CONTEXT },
        mockContext,
      );
      const body = await result.json();

      expect(body.siteResults).to.deep.equal(siteResults);
    });

    it('disables multiple importTypes and auditTypes per site', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite1);

      await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: {
            importTypes: ['ahrefs-organic-keywords', 'ahrefs-organic-pages'],
            auditTypes: ['cwv', 'meta-tags'],
            scheduledRun: false,
          },
        },
        mockContext,
      );

      expect(mockSite1.siteConfig.disableImport.callCount).to.equal(2);
      expect(mockSite1.siteConfig.disableImport.calledWith('ahrefs-organic-keywords')).to.be.true;
      expect(mockSite1.siteConfig.disableImport.calledWith('ahrefs-organic-pages')).to.be.true;
      expect(mockConfiguration.disableHandlerForSite.callCount).to.equal(2);
    });
  });

  describe('error handling per site', () => {
    it('marks site as not disabled when Site.findById returns null', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults[0]).to.deep.include({ siteId: SITE_ID_1, disabled: false });
      expect(body.disableResults[0].reason).to.equal('site not found');
      expect(body.message).to.include('0 succeeded, 1 failed');
    });

    it('marks site as not disabled when Site.findById throws', async () => {
      mockContext.dataAccess.Site.findById.rejects(new Error('DB timeout'));

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults[0]).to.deep.include({ siteId: SITE_ID_1, disabled: false });
      expect(body.disableResults[0].reason).to.include('DB timeout');
    });

    it('marks site as not disabled when site.save() throws', async () => {
      mockSite1.save.rejects(new Error('Save failed'));
      mockContext.dataAccess.Site.findById.resolves(mockSite1);

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults[0]).to.deep.include({ siteId: SITE_ID_1, disabled: false });
      expect(body.disableResults[0].reason).to.include('Save failed');
    });

    it('marks site as not disabled when Configuration.findLatest throws', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite1);
      mockContext.dataAccess.Configuration.findLatest.rejects(new Error('Config unavailable'));

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [makeSiteResult(SITE_ID_1, BASE_URL_1)],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults[0]).to.deep.include({ siteId: SITE_ID_1, disabled: false });
    });

    it('continues processing remaining sites when one fails', async () => {
      mockContext.dataAccess.Site.findById
        .onFirstCall().rejects(new Error('DB error'))
        .onSecondCall().resolves(mockSite2);

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [
            makeSiteResult(SITE_ID_1, BASE_URL_1),
            makeSiteResult(SITE_ID_2, BASE_URL_2),
          ],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults).to.have.length(2);
      expect(body.disableResults[0].disabled).to.be.false;
      expect(body.disableResults[1].disabled).to.be.true;
      expect(body.message).to.include('1 succeeded, 1 failed');
    });
  });

  describe('edge cases', () => {
    it('handles empty siteResults array gracefully', async () => {
      const result = await runBatchDisableImportAuditJob(
        { siteResults: [], taskContext: BASE_TASK_CONTEXT },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults).to.deep.equal([]);
      expect(body.message).to.include('0 succeeded, 0 failed');
    });

    it('handles missing siteResults gracefully', async () => {
      const result = await runBatchDisableImportAuditJob(
        { taskContext: BASE_TASK_CONTEXT },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults).to.deep.equal([]);
    });

    it('filters out null/undefined results from siteResults', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite1);

      const result = await runBatchDisableImportAuditJob(
        {
          siteResults: [
            { result: null },
            makeSiteResult(SITE_ID_1, BASE_URL_1),
            { result: undefined },
          ],
          taskContext: BASE_TASK_CONTEXT,
        },
        mockContext,
      );
      const body = await result.json();

      // Only the valid site result is processed
      expect(mockContext.dataAccess.Site.findById.calledOnce).to.be.true;
      expect(body.disableResults).to.have.length(1);
    });

    it('handles non-array siteResults gracefully', async () => {
      const result = await runBatchDisableImportAuditJob(
        { siteResults: 'not-an-array', taskContext: BASE_TASK_CONTEXT },
        mockContext,
      );
      const body = await result.json();

      expect(body.disableResults).to.deep.equal([]);
    });

    it('defaults taskContext fields when taskContext is absent', async () => {
      const result = await runBatchDisableImportAuditJob(
        { siteResults: [] },
        mockContext,
      );
      const body = await result.json();

      // importTypes and auditTypes default to [], so "Nothing to disable" path
      expect(body.message).to.include('Nothing to disable');
    });
  });
});
