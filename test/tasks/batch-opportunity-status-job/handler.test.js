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
const UPDATED_AT = '2026-04-01T12:05:00.000Z';

let runBatchOpportunityStatusJob;

const createMockOpportunity = (sandbox, type, updatedAt = UPDATED_AT, suggestionCount = 0) => ({
  getType: sandbox.stub().returns(type),
  getUpdatedAt: sandbox.stub().returns(updatedAt),
  getSuggestions: sandbox.stub().resolves(Array.from({ length: suggestionCount })),
});

const createMockSite = (sandbox, baseUrl = BASE_URL) => ({
  getId: sandbox.stub().returns(SITE_ID),
  getBaseURL: sandbox.stub().returns(baseUrl),
  getOpportunities: sandbox.stub(),
});

const baseMessage = {
  siteId: SITE_ID,
  siteUrl: BASE_URL,
  taskContext: {
    opportunityTypes: ['cwv', 'meta-tags'],
  },
};

describe('Batch Opportunity Status Job', () => {
  let sandbox;
  let mockContext;
  let mockSite;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    mockContext = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Site: { findById: sandbox.stub() },
        SiteTopPage: { allBySiteIdAndSourceAndGeo: sandbox.stub().resolves([]) },
      })
      .build();

    mockSite = createMockSite(sandbox);

    // Mock data source checks to avoid real network calls
    runBatchOpportunityStatusJob = (await esmock(
      '../../../src/tasks/batch-opportunity-status-job/handler.js',
      {
        '../../../src/tasks/opportunity-status-processor/handler.js': {
          isRUMAvailable: sandbox.stub().resolves(false),
          isAHREFSImportDataAvailable: sandbox.stub().resolves(false),
          isScrapingAvailable: sandbox.stub().resolves({ available: false }),
        },
        '@adobe/spacecat-shared-utils': {
          resolveCanonicalUrl: sandbox.stub().resolves(BASE_URL),
        },
      },
    )).runBatchOpportunityStatusJob;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('runBatchOpportunityStatusJob', () => {
    it('uses explicit opportunityTypes when provided', async () => {
      const cwvOpp = createMockOpportunity(sandbox, 'cwv');
      mockSite.getOpportunities.resolves([cwvOpp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(baseMessage, mockContext);
      const body = await result.json();

      expect(body.opportunityTypesChecked).to.deep.equal(['cwv', 'meta-tags']);
      expect(body.found.map((f) => f.type)).to.include('cwv');
      expect(body.notFound.map((f) => f.type)).to.include('meta-tags');
    });

    it('falls back to getAllOpportunityTypes when opportunityTypes is absent', async () => {
      mockSite.getOpportunities.resolves([]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: BASE_URL, taskContext: {} },
        mockContext,
      );
      const body = await result.json();

      expect(body.opportunityTypesChecked.length).to.be.greaterThan(0);
    });

    it('returns site not found when Site.findById returns null', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      const result = await runBatchOpportunityStatusJob(baseMessage, mockContext);
      const body = await result.json();

      expect(body.message).to.include('Site not found');
      expect(body.found).to.deep.equal([]);
    });

    it('surfaces updatedAt and suggestionCount in found entries', async () => {
      const cwvOpp = createMockOpportunity(sandbox, 'cwv', UPDATED_AT, 3);
      mockSite.getOpportunities.resolves([cwvOpp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: BASE_URL, taskContext: { opportunityTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.found).to.have.length(1);
      expect(body.found[0]).to.deep.include({ type: 'cwv', updatedAt: UPDATED_AT, suggestionCount: 3 });
    });

    it('puts in notFound when opportunity type is missing', async () => {
      mockSite.getOpportunities.resolves([]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: BASE_URL, taskContext: { opportunityTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.notFound).to.have.length(1);
      expect(body.notFound[0]).to.deep.include({ type: 'cwv' });
    });

    it('includes dataSources in response', async () => {
      mockSite.getOpportunities.resolves([]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(baseMessage, mockContext);
      const body = await result.json();

      expect(body.dataSources).to.have.keys(['rum', 'ahrefsImport', 'scraping', 'scrapingStats']);
    });

    it('handles getOpportunities failure and reports all types as notFound', async () => {
      mockSite.getOpportunities.rejects(new Error('DB error'));
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(baseMessage, mockContext);
      const body = await result.json();

      expect(body.found).to.deep.equal([]);
      expect(body.notFound.map((f) => f.type)).to.deep.equal(['cwv', 'meta-tags']);
    });

    it('returns error response when siteId is missing', async () => {
      const result = await runBatchOpportunityStatusJob(
        { siteUrl: BASE_URL, taskContext: {} },
        mockContext,
      );
      const body = await result.json();

      expect(body.message).to.include('Missing required fields');
      expect(body.found).to.deep.equal([]);
    });

    it('returns error response when siteUrl is missing', async () => {
      const result = await runBatchOpportunityStatusJob(
        { siteId: SITE_ID, taskContext: {} },
        mockContext,
      );
      const body = await result.json();

      expect(body.message).to.include('Missing required fields');
      expect(body.found).to.deep.equal([]);
    });

    it('returns error response when Site.findById throws', async () => {
      mockContext.dataAccess.Site.findById.rejects(new Error('DB connection error'));

      const result = await runBatchOpportunityStatusJob(baseMessage, mockContext);
      const body = await result.json();

      expect(body.message).to.include('Failed to fetch site');
      expect(body.found).to.deep.equal([]);
      expect(body.notFound.map((f) => f.type)).to.deep.equal(['cwv', 'meta-tags']);
    });

    it('defaults suggestionCount to 0 when getSuggestions throws', async () => {
      const cwvOpp = createMockOpportunity(sandbox, 'cwv', UPDATED_AT);
      cwvOpp.getSuggestions.rejects(new Error('Suggestions unavailable'));
      mockSite.getOpportunities.resolves([cwvOpp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runBatchOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: BASE_URL, taskContext: { opportunityTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.found[0]).to.deep.include({ type: 'cwv', suggestionCount: 0 });
    });
  });
});
