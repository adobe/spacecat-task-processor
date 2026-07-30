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

import { expect } from 'chai';
import { isOpportunityApplicableForDeliveryType } from '../../../src/tasks/opportunity-status-processor/handler.js';

describe('isOpportunityApplicableForDeliveryType', () => {
  it('excludes security-vulnerabilities for aem_edge sites (audit only runs on AEM_CS)', () => {
    expect(isOpportunityApplicableForDeliveryType('security-vulnerabilities', 'aem_edge'))
      .to.equal(false);
  });

  it('includes security-vulnerabilities for aem_cs sites', () => {
    expect(isOpportunityApplicableForDeliveryType('security-vulnerabilities', 'aem_cs'))
      .to.equal(true);
  });

  it('treats unrestricted opportunities as applicable for any delivery type', () => {
    expect(isOpportunityApplicableForDeliveryType('meta-tags', 'aem_edge')).to.equal(true);
    expect(isOpportunityApplicableForDeliveryType('cwv', 'other')).to.equal(true);
  });

  it('is applicable when delivery type is unknown/undefined (avoid hiding opportunities)', () => {
    expect(isOpportunityApplicableForDeliveryType('meta-tags', undefined)).to.equal(true);
  });
});
