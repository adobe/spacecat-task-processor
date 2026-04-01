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

const SITE_ID = 'site-id-1';
const BASE_URL = 'https://site1.com';

function makeSiteResult(overrides = {}) {
  return {
    result: {
      siteId: SITE_ID,
      baseUrl: BASE_URL,
      found: [],
      notFound: [],
      dataSources: {
        rum: false,
        ahrefsImport: false,
        scraping: false,
        scrapingStats: null,
      },
      ...overrides,
    },
  };
}

describe('Batch Opportunity Status Notifier', () => {
  let sandbox;
  let mockContext;
  let sayStub;
  let runBatchOpportunityStatusNotifier;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockContext = new MockContextBuilder().withSandbox(sandbox).build();
    sayStub = sandbox.stub().resolves();

    runBatchOpportunityStatusNotifier = (await esmock(
      '../../../src/tasks/batch-opportunity-status-job/notifier.js',
      {
        '../../../src/utils/slack-utils.js': { say: sayStub },
      },
    )).runBatchOpportunityStatusNotifier;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('runBatchOpportunityStatusNotifier', () => {
    it('skips Slack notification when no slackContext is provided', async () => {
      const result = await runBatchOpportunityStatusNotifier(
        { siteResults: [makeSiteResult()] },
        mockContext,
      );
      const body = await result.json();

      expect(sayStub.called).to.be.false;
      expect(body.message).to.include('skipped');
    });

    it('skips Slack notification when channelId is empty', async () => {
      const result = await runBatchOpportunityStatusNotifier(
        { siteResults: [makeSiteResult()], slackContext: { channelId: '' } },
        mockContext,
      );
      const body = await result.json();

      expect(sayStub.called).to.be.false;
      expect(body.message).to.include('skipped');
    });

    it('sends Slack summary for a site with found and notFound opportunities', async () => {
      const siteResult = makeSiteResult({
        found: [{ type: 'cwv', updatedAt: '2026-04-01T00:00:00.000Z', suggestionCount: 2 }],
        notFound: [{ type: 'meta-tags' }],
        dataSources: {
          rum: true, ahrefsImport: false, scraping: true, scrapingStats: null,
        },
      });
      const slackContext = { channelId: 'C123', threadTs: '123.456' };

      const result = await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );
      const body = await result.json();

      expect(sayStub.calledOnce).to.be.true;
      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('cwv');
      expect(summaryArg).to.include('meta-tags');
      expect(summaryArg).to.include(':white_check_mark:');
      expect(summaryArg).to.include(':x:');
      expect(body.sitesReported).to.equal(1);
    });

    it('sends Slack summary and includes scraping stats when available', async () => {
      const siteResult = makeSiteResult({
        dataSources: {
          rum: false,
          ahrefsImport: false,
          scraping: true,
          scrapingStats: { completed: 9, failed: 1, total: 10 },
        },
      });
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('9 / 10');
      expect(summaryArg).to.include('1 failed');
    });

    it('formats scraping stats without failed count when failed is 0', async () => {
      const siteResult = makeSiteResult({
        dataSources: {
          rum: false,
          ahrefsImport: false,
          scraping: true,
          scrapingStats: { completed: 10, failed: 0, total: 10 },
        },
      });
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('10 / 10');
      expect(summaryArg).not.to.include('failed');
    });

    it('shows "no opportunity data" when found and notFound are both empty', async () => {
      const siteResult = makeSiteResult({ found: [], notFound: [] });
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('No opportunity data available');
    });

    it('skips items with no result (failed SFN iterations)', async () => {
      const slackContext = { channelId: 'C123' };
      const siteResults = [
        { result: null },
        makeSiteResult({ found: [{ type: 'cwv', updatedAt: '2026-04-01T00:00:00.000Z', suggestionCount: 0 }] }),
      ];

      const result = await runBatchOpportunityStatusNotifier(
        { siteResults, slackContext },
        mockContext,
      );
      const body = await result.json();

      expect(body.sitesReported).to.equal(1);
      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('cwv');
    });

    it('sends fallback message when formatSlackSummary produces no results', async () => {
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('No site results available');
    });

    it('logs error and returns ok when say() throws', async () => {
      sayStub.rejects(new Error('Slack API error'));
      const slackContext = { channelId: 'C123' };

      const result = await runBatchOpportunityStatusNotifier(
        { siteResults: [makeSiteResult()], slackContext },
        mockContext,
      );
      const body = await result.json();

      expect(mockContext.log.error.calledWith(sinon.match(/Failed to send Slack message/))).to.be.true;
      expect(body.message).to.include('notification sent');
    });

    it('sends warning summary when siteResults contains only null-result items', async () => {
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [{ result: null }, { result: undefined }], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('No site results available');
    });

    it('handles missing dataSources gracefully', async () => {
      const siteResult = makeSiteResult({ dataSources: null });
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );

      // Should not throw; Slack message should still be sent
      expect(sayStub.calledOnce).to.be.true;
    });

    it('defaults sitesReported to 0 when siteResults is not an array', async () => {
      const result = await runBatchOpportunityStatusNotifier(
        { siteResults: null },
        mockContext,
      );
      const body = await result.json();

      expect(body.sitesReported).to.equal(0);
      expect(body.message).to.include('skipped');
    });

    it('shows check mark for ahrefsImport when it is true', async () => {
      const siteResult = makeSiteResult({
        dataSources: {
          rum: false, ahrefsImport: true, scraping: false, scrapingStats: null,
        },
      });
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('AHREFS Import: :white_check_mark:');
    });

    it('defaults suggestionCount to 0 in summary when it is missing from found entry', async () => {
      const siteResult = makeSiteResult({
        found: [{ type: 'cwv', updatedAt: '2026-04-01T00:00:00.000Z' }], // no suggestionCount
        notFound: [],
      });
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [siteResult], slackContext },
        mockContext,
      );

      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('Suggestions: 0');
    });

    it('passes empty array to formatSlackSummary when siteResults is not an array', async () => {
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: 'not-an-array', slackContext },
        mockContext,
      );

      expect(sayStub.calledOnce).to.be.true;
      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('No site results available');
    });

    it('uses fallback message and logs error when formatSlackSummary throws', async () => {
      // A result whose `found` getter throws causes formatSlackSummary to throw internally
      const brokenResult = {
        get result() {
          return {
            siteId: SITE_ID,
            baseUrl: BASE_URL,
            get found() { throw new Error('boom'); },
            notFound: [],
            dataSources: null,
          };
        },
      };
      const slackContext = { channelId: 'C123' };

      await runBatchOpportunityStatusNotifier(
        { siteResults: [brokenResult], slackContext },
        mockContext,
      );

      expect(mockContext.log.error.calledWith(sinon.match(/Failed to format Slack summary/))).to.be.true;
      const summaryArg = sayStub.firstCall.args[3];
      expect(summaryArg).to.include('report formatting failed');
    });
  });
});
