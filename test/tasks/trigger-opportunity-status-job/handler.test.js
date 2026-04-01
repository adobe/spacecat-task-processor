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
import { MockContextBuilder } from '../../shared.js';
import { runTriggerOpportunityStatusJob } from '../../../src/tasks/trigger-opportunity-status-job/handler.js';

const SITE_ID = 'site-id-1';
const SITE_URL = 'https://site1.com';

// createdAt and updatedAt are the same → never updated
const CREATED_AT = '2026-04-01T10:00:00.000Z';
// updatedAt advances → updated after creation
const UPDATED_AT = '2026-04-01T12:00:00.000Z';

function createMockOpportunity(sandbox, type, {
  createdAt = CREATED_AT,
  updatedAt = CREATED_AT,
} = {}) {
  return {
    getType: sandbox.stub().returns(type),
    getCreatedAt: sandbox.stub().returns(createdAt),
    getUpdatedAt: sandbox.stub().returns(updatedAt),
  };
}

function createMockSite(sandbox) {
  return {
    getId: sandbox.stub().returns(SITE_ID),
    getBaseURL: sandbox.stub().returns(SITE_URL),
    getOpportunities: sandbox.stub().resolves([]),
  };
}

describe('Trigger Opportunity Status Job', () => {
  let sandbox;
  let mockContext;
  let mockSite;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockContext = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({ Site: { findById: sandbox.stub() } })
      .build();
    mockSite = createMockSite(sandbox);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('resolveExpectedOpportunityTypes (via handler)', () => {
    it('falls back to all known opportunity types when auditTypes is empty', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: [] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.expectedOpportunityTypes.length).to.be.greaterThan(0);
    });

    it('falls back to all known types when auditTypes contains only unknown types', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['unknown-type'] } },
        mockContext,
      );
      const body = await result.json();

      // Falls back because no known types were resolved
      expect(body.expectedOpportunityTypes.length).to.be.greaterThan(0);
    });

    it('resolves opportunity types for known auditTypes', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv', 'meta-tags'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.expectedOpportunityTypes).to.include('cwv');
      expect(body.expectedOpportunityTypes).to.include('meta-tags');
    });

    it('deduplicates opportunity types from multiple audit types', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      // 'forms-opportunities' maps to ['form-accessibility', 'forms-opportunities']
      const result = await runTriggerOpportunityStatusJob(
        {
          siteId: SITE_ID,
          siteUrl: SITE_URL,
          taskContext: { auditTypes: ['forms-opportunities', 'forms-opportunities'] },
        },
        mockContext,
      );
      const body = await result.json();

      const unique = new Set(body.expectedOpportunityTypes);
      expect(unique.size).to.equal(body.expectedOpportunityTypes.length);
    });

    it('falls back to all types when taskContext is not provided', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL },
        mockContext,
      );
      const body = await result.json();

      expect(body.expectedOpportunityTypes.length).to.be.greaterThan(0);
    });
  });

  describe('wasUpdatedByAudit (via handler)', () => {
    it('does NOT add to updatedByAudit when createdAt equals updatedAt', async () => {
      const opp = createMockOpportunity(sandbox, 'cwv', {
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT, // same → never updated
      });
      mockSite.getOpportunities.resolves([opp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.updatedByAudit).to.deep.equal([]);
    });

    it('adds to updatedByAudit when updatedAt > createdAt and no auditRunTime', async () => {
      const opp = createMockOpportunity(sandbox, 'cwv', {
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      });
      mockSite.getOpportunities.resolves([opp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.updatedByAudit).to.have.length(1);
      expect(body.updatedByAudit[0]).to.include({ type: 'cwv', siteId: SITE_ID });
    });

    it('adds to updatedByAudit when updatedAt >= onboardStartTime', async () => {
      const onboardStartTime = new Date(CREATED_AT).getTime() + 1000; // 1s after creation
      const opp = createMockOpportunity(sandbox, 'cwv', {
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT, // well after onboardStartTime
      });
      mockSite.getOpportunities.resolves([opp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'], onboardStartTime } },
        mockContext,
      );
      const body = await result.json();

      expect(body.updatedByAudit).to.have.length(1);
    });

    it('does NOT add to updatedByAudit when updatedAt < onboardStartTime', async () => {
      // onboardStartTime is set to after UPDATED_AT
      const onboardStartTime = new Date(UPDATED_AT).getTime() + 60000;
      const opp = createMockOpportunity(sandbox, 'cwv', {
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT, // before onboardStartTime
      });
      mockSite.getOpportunities.resolves([opp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'], onboardStartTime } },
        mockContext,
      );
      const body = await result.json();

      expect(body.updatedByAudit).to.deep.equal([]);
    });
  });

  describe('runTriggerOpportunityStatusJob', () => {
    it('returns site not found when Site.findById returns null', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.message).to.include('Site not found');
      expect(body.found).to.deep.equal([]);
      expect(body.notFound).to.deep.equal([]);
      expect(body.updatedByAudit).to.deep.equal([]);
    });

    it('returns empty arrays when getOpportunities throws', async () => {
      mockSite.getOpportunities.rejects(new Error('DB error'));
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.found).to.deep.equal([]);
      expect(body.notFound.map((f) => f.type)).to.include('cwv');
      expect(body.updatedByAudit).to.deep.equal([]);
    });

    it('adds type to found and notFound correctly based on presence', async () => {
      const cwvOpp = createMockOpportunity(sandbox, 'cwv');
      mockSite.getOpportunities.resolves([cwvOpp]);
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv', 'meta-tags'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body.found.map((f) => f.type)).to.include('cwv');
      expect(body.notFound.map((f) => f.type)).to.include('meta-tags');
    });

    it('returns correct response shape on success', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      const result = await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'] } },
        mockContext,
      );
      const body = await result.json();

      expect(body).to.include.keys([
        'message', 'siteId', 'baseUrl', 'expectedOpportunityTypes', 'found', 'notFound', 'updatedByAudit',
      ]);
      expect(body.siteId).to.equal(SITE_ID);
      expect(body.baseUrl).to.equal(SITE_URL);
    });

    it('logs onboardStartTime as ISO string when provided', async () => {
      const onboardStartTime = new Date(CREATED_AT).getTime();
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'], onboardStartTime } },
        mockContext,
      );

      expect(mockContext.log.info.calledWith(
        sinon.match.string,
        sinon.match((arg) => arg.onboardStartTime === new Date(onboardStartTime).toISOString()),
      )).to.be.true;
    });

    it('logs "not provided" for onboardStartTime when absent', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);

      await runTriggerOpportunityStatusJob(
        { siteId: SITE_ID, siteUrl: SITE_URL, taskContext: { auditTypes: ['cwv'] } },
        mockContext,
      );

      expect(mockContext.log.info.calledWith(
        sinon.match.string,
        sinon.match((arg) => arg.onboardStartTime === 'not provided'),
      )).to.be.true;
    });
  });
});
