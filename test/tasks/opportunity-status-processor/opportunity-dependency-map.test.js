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
  OPPORTUNITY_DEPENDENCY_MAP,
  getDependenciesForOpportunity,
  areDependenciesMet,
  getOpportunitiesWithUnmetDependencies,
} from '../../../src/tasks/opportunity-status-processor/opportunity-dependency-map.js';

describe('Opportunity Dependency Map', () => {
  describe('OPPORTUNITY_DEPENDENCY_MAP', () => {
    it('should contain all expected opportunity types', () => {
      expect(OPPORTUNITY_DEPENDENCY_MAP).to.be.an('object');
      expect(OPPORTUNITY_DEPENDENCY_MAP).to.have.property('cwv');
      expect(OPPORTUNITY_DEPENDENCY_MAP).to.have.property('high-organic-low-ctr');
      expect(OPPORTUNITY_DEPENDENCY_MAP).to.have.property('broken-internal-links');
      expect(OPPORTUNITY_DEPENDENCY_MAP).to.have.property('meta-tags');
      expect(OPPORTUNITY_DEPENDENCY_MAP).to.have.property('broken-backlinks');
    });

    it('should map opportunities to dependencies correctly', () => {
      expect(OPPORTUNITY_DEPENDENCY_MAP.cwv).to.deep.equal(['RUM']);
      expect(OPPORTUNITY_DEPENDENCY_MAP['high-organic-low-ctr']).to.deep.equal(['RUM']);
      expect(OPPORTUNITY_DEPENDENCY_MAP['broken-internal-links']).to.deep.equal(['RUM', 'top-pages']);
      expect(OPPORTUNITY_DEPENDENCY_MAP['meta-tags']).to.deep.equal(['top-pages']);
      expect(OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks']).to.deep.equal(['top-pages']);
    });
  });

  describe('getDependenciesForOpportunity', () => {
    it('should return dependencies for known opportunity type', () => {
      const dependencies = getDependenciesForOpportunity('cwv');
      expect(dependencies).to.be.an('array');
      expect(dependencies).to.deep.equal(['RUM']);
    });

    it('should return multiple dependencies for broken-internal-links', () => {
      const dependencies = getDependenciesForOpportunity('broken-internal-links');
      expect(dependencies).to.be.an('array');
      expect(dependencies).to.have.lengthOf(2);
      expect(dependencies).to.include('RUM');
      expect(dependencies).to.include('top-pages');
    });

    it('should return empty array for opportunity with no dependencies', () => {
      const dependencies = getDependenciesForOpportunity('accessibility');
      expect(dependencies).to.be.an('array');
      expect(dependencies).to.have.lengthOf(0);
    });

    it('should return empty array for unknown opportunity type', () => {
      const dependencies = getDependenciesForOpportunity('unknown-opportunity');
      expect(dependencies).to.be.an('array');
      expect(dependencies).to.have.lengthOf(0);
    });

    it('should return empty array for null opportunity type', () => {
      const dependencies = getDependenciesForOpportunity(null);
      expect(dependencies).to.be.an('array');
      expect(dependencies).to.have.lengthOf(0);
    });
  });

  describe('areDependenciesMet', () => {
    it('should return true when all RUM dependencies are met', () => {
      const serviceStatus = { rum: true, import: false, scraping: false };
      const result = areDependenciesMet('cwv', serviceStatus);
      expect(result).to.be.true;
    });

    it('should return false when RUM dependency is not met', () => {
      const serviceStatus = { rum: false, import: false, scraping: false };
      const result = areDependenciesMet('cwv', serviceStatus);
      expect(result).to.be.false;
    });

    it('should return true when top-pages dependency is met', () => {
      const serviceStatus = { rum: false, import: true, scraping: false };
      const result = areDependenciesMet('meta-tags', serviceStatus);
      expect(result).to.be.true;
    });

    it('should return false when top-pages dependency is not met', () => {
      const serviceStatus = { rum: false, import: false, scraping: false };
      const result = areDependenciesMet('meta-tags', serviceStatus);
      expect(result).to.be.false;
    });

    it('should return true when all multiple dependencies are met', () => {
      const serviceStatus = { rum: true, import: true, scraping: false };
      const result = areDependenciesMet('broken-internal-links', serviceStatus);
      expect(result).to.be.true;
    });

    it('should return false when some multiple dependencies are not met', () => {
      const serviceStatus = { rum: true, import: false, scraping: false };
      const result = areDependenciesMet('broken-internal-links', serviceStatus);
      expect(result).to.be.false;
    });

    it('should return true for opportunity with no dependencies', () => {
      const serviceStatus = { rum: false, import: false, scraping: false };
      const result = areDependenciesMet('accessibility', serviceStatus);
      expect(result).to.be.true;
    });

    it('should return true for unknown opportunity type', () => {
      const serviceStatus = { rum: false, import: false, scraping: false };
      const result = areDependenciesMet('unknown-opportunity', serviceStatus);
      expect(result).to.be.true;
    });
  });

  describe('getOpportunitiesWithUnmetDependencies', () => {
    it('should return empty array when all dependencies are met', () => {
      const opportunityTypes = ['cwv', 'meta-tags'];
      const serviceStatus = { rum: true, import: true, scraping: true };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(0);
    });

    it('should return opportunities with unmet RUM dependency', () => {
      const opportunityTypes = ['cwv', 'high-organic-low-ctr'];
      const serviceStatus = { rum: false, import: true, scraping: true };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(2);
      expect(result[0]).to.have.property('opportunity', 'cwv');
      expect(result[0]).to.have.property('missingDependencies');
      expect(result[0].missingDependencies).to.include('RUM');
      expect(result[1]).to.have.property('opportunity', 'high-organic-low-ctr');
    });

    it('should return opportunities with unmet top-pages dependency', () => {
      const opportunityTypes = ['meta-tags', 'broken-backlinks'];
      const serviceStatus = { rum: true, import: false, scraping: true };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(2);
      expect(result[0]).to.have.property('opportunity', 'meta-tags');
      expect(result[0].missingDependencies).to.include('top-pages');
    });

    it('should return opportunities with multiple unmet dependencies', () => {
      const opportunityTypes = ['broken-internal-links'];
      const serviceStatus = { rum: false, import: false, scraping: true };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.have.property('opportunity', 'broken-internal-links');
      expect(result[0].missingDependencies).to.have.lengthOf(2);
      expect(result[0].missingDependencies).to.include('RUM');
      expect(result[0].missingDependencies).to.include('top-pages');
    });

    it('should not return opportunities with no dependencies', () => {
      const opportunityTypes = ['accessibility', 'cwv'];
      const serviceStatus = { rum: false, import: false, scraping: false };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.have.property('opportunity', 'cwv');
    });

    it('should handle empty opportunity types array', () => {
      const opportunityTypes = [];
      const serviceStatus = { rum: true, import: true, scraping: true };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(0);
    });

    it('should handle mixed met and unmet dependencies', () => {
      const opportunityTypes = ['cwv', 'meta-tags', 'accessibility'];
      const serviceStatus = { rum: true, import: false, scraping: false };
      const result = getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus);
      expect(result).to.be.an('array');
      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.have.property('opportunity', 'meta-tags');
    });
  });
});
