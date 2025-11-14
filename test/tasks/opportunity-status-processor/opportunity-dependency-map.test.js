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
      expect(OPPORTUNITY_DEPENDENCY_MAP['broken-internal-links']).to.deep.equal(['RUM', 'AHREFSImport']);
      expect(OPPORTUNITY_DEPENDENCY_MAP['meta-tags']).to.deep.equal(['AHREFSImport']);
      expect(OPPORTUNITY_DEPENDENCY_MAP['broken-backlinks']).to.deep.equal(['AHREFSImport']);
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
      expect(dependencies).to.include('AHREFSImport');
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
});
