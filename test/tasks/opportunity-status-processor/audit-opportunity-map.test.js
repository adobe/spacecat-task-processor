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
import {
  AUDIT_OPPORTUNITY_MAP,
  getOpportunitiesForAudit,
  getAllAuditTypes,
  getAuditsForOpportunity,
  getAllOpportunityTypes,
} from '../../../src/tasks/opportunity-status-processor/audit-opportunity-map.js';

describe('Audit Opportunity Map', () => {
  describe('AUDIT_OPPORTUNITY_MAP', () => {
    it('should contain all expected audit types', () => {
      expect(AUDIT_OPPORTUNITY_MAP).to.be.an('object');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('cwv');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('forms-opportunities');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('meta-tags');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('experimentation-opportunities');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('broken-backlinks');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('broken-internal-links');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('sitemap');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('alt-text');
      expect(AUDIT_OPPORTUNITY_MAP).to.have.property('accessibility');
    });

    it('should map audits to opportunities correctly', () => {
      expect(AUDIT_OPPORTUNITY_MAP.cwv).to.deep.equal(['cwv']);
      expect(AUDIT_OPPORTUNITY_MAP['forms-opportunities']).to.deep.equal([
        'form-accessibility',
        'forms-opportunities',
      ]);
      expect(AUDIT_OPPORTUNITY_MAP['meta-tags']).to.deep.equal(['meta-tags']);
      expect(AUDIT_OPPORTUNITY_MAP['experimentation-opportunities']).to.deep.equal([
        'high-organic-low-ctr',
      ]);
    });
  });

  describe('getOpportunitiesForAudit', () => {
    it('should return opportunities for known audit type', () => {
      const opportunities = getOpportunitiesForAudit('cwv');
      expect(opportunities).to.be.an('array');
      expect(opportunities).to.deep.equal(['cwv']);
    });

    it('should return multiple opportunities for forms audit', () => {
      const opportunities = getOpportunitiesForAudit('forms-opportunities');
      expect(opportunities).to.be.an('array');
      expect(opportunities).to.have.lengthOf(2);
      expect(opportunities).to.include('form-accessibility');
      expect(opportunities).to.include('forms-opportunities');
    });

    it('should return empty array for unknown audit type', () => {
      const opportunities = getOpportunitiesForAudit('unknown-audit');
      expect(opportunities).to.be.an('array');
      expect(opportunities).to.have.lengthOf(0);
    });

    it('should return empty array for null audit type', () => {
      const opportunities = getOpportunitiesForAudit(null);
      expect(opportunities).to.be.an('array');
      expect(opportunities).to.have.lengthOf(0);
    });

    it('should return empty array for undefined audit type', () => {
      const opportunities = getOpportunitiesForAudit(undefined);
      expect(opportunities).to.be.an('array');
      expect(opportunities).to.have.lengthOf(0);
    });

    it('should handle all defined audit types', () => {
      const auditTypes = [
        'cwv',
        'forms-opportunities',
        'meta-tags',
        'experimentation-opportunities',
        'broken-backlinks',
        'broken-internal-links',
        'sitemap',
        'alt-text',
        'accessibility',
      ];

      auditTypes.forEach((auditType) => {
        const opportunities = getOpportunitiesForAudit(auditType);
        expect(opportunities).to.be.an('array');
        expect(opportunities.length).to.be.greaterThan(0);
      });
    });
  });

  describe('getAllAuditTypes', () => {
    it('should return all audit types', () => {
      const auditTypes = getAllAuditTypes();
      expect(auditTypes).to.be.an('array');
      expect(auditTypes).to.have.lengthOf(9);
    });

    it('should include all expected audit types', () => {
      const auditTypes = getAllAuditTypes();
      expect(auditTypes).to.include('cwv');
      expect(auditTypes).to.include('forms-opportunities');
      expect(auditTypes).to.include('meta-tags');
      expect(auditTypes).to.include('experimentation-opportunities');
      expect(auditTypes).to.include('broken-backlinks');
      expect(auditTypes).to.include('broken-internal-links');
      expect(auditTypes).to.include('sitemap');
      expect(auditTypes).to.include('alt-text');
      expect(auditTypes).to.include('accessibility');
    });
  });
});

describe('Audit Opportunity Map - Additional Coverage', () => {
  describe('getAuditsForOpportunity', () => {
    it('should return audits that generate cwv opportunity', () => {
      const audits = getAuditsForOpportunity('cwv');
      expect(audits).to.be.an('array');
      expect(audits).to.deep.equal(['cwv']);
    });

    it('should return multiple audits for form-accessibility opportunity', () => {
      const audits = getAuditsForOpportunity('form-accessibility');
      expect(audits).to.be.an('array');
      expect(audits).to.include('forms-opportunities');
    });

    it('should return empty array for unknown opportunity', () => {
      const audits = getAuditsForOpportunity('unknown-opportunity');
      expect(audits).to.be.an('array');
      expect(audits).to.have.lengthOf(0);
    });

    it('should return audits for high-organic-low-ctr opportunity', () => {
      const audits = getAuditsForOpportunity('high-organic-low-ctr');
      expect(audits).to.be.an('array');
      expect(audits).to.deep.equal(['experimentation-opportunities']);
    });
  });

  describe('getAllOpportunityTypes', () => {
    it('should return all unique opportunity types', () => {
      const opportunities = getAllOpportunityTypes();
      expect(opportunities).to.be.an('array');
      expect(opportunities.length).to.be.greaterThan(0);
    });

    it('should not contain duplicates', () => {
      const opportunities = getAllOpportunityTypes();
      const uniqueOpportunities = [...new Set(opportunities)];
      expect(opportunities).to.have.lengthOf(uniqueOpportunities.length);
    });

    it('should include all defined opportunity types', () => {
      const opportunities = getAllOpportunityTypes();
      expect(opportunities).to.include('cwv');
      expect(opportunities).to.include('meta-tags');
      expect(opportunities).to.include('broken-backlinks');
      expect(opportunities).to.include('high-organic-low-ctr');
    });
  });
});
