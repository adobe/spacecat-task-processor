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
import { analyzeMissingOpportunities } from '../../../src/tasks/opportunity-status-processor/handler.js';

describe('analyzeMissingOpportunities (DB-driven, no CloudWatch)', () => {
  it('reports a missing opportunity as in-progress when its audit has not completed yet', () => {
    const results = analyzeMissingOpportunities(
      ['meta-tags'],
      ['meta-tags'],
      [], // no audits completed yet
      { rum: true, seoImport: true, scraping: true },
    );

    expect(results).to.deep.equal([{
      opportunity: 'meta-tags',
      audit: 'meta-tags',
      reason: 'meta-tags audit is still in progress',
      inProgress: true,
    }]);
  });

  it('reports unmet dependencies when the audit completed but a data source is missing', () => {
    const results = analyzeMissingOpportunities(
      ['meta-tags'],
      ['meta-tags'],
      ['meta-tags'], // completed
      { rum: true, seoImport: true, scraping: false }, // scraping missing
    );

    expect(results).to.deep.equal([{
      opportunity: 'meta-tags',
      audit: 'meta-tags',
      reason: 'Missing dependencies: Scraping',
    }]);
  });

  it('reports the SEO Import dependency by name when it is the missing source', () => {
    const results = analyzeMissingOpportunities(
      ['meta-tags'],
      ['meta-tags'],
      ['meta-tags'], // completed
      { rum: true, seoImport: false, scraping: true }, // SEO import missing
    );

    expect(results).to.deep.equal([{
      opportunity: 'meta-tags',
      audit: 'meta-tags',
      reason: 'Missing dependencies: SEO Import',
    }]);
  });

  it('reports "found no issues" when the audit completed with all dependencies met', () => {
    const results = analyzeMissingOpportunities(
      ['cwv'],
      ['cwv'],
      ['cwv'], // completed
      { rum: true, seoImport: true, scraping: true },
    );

    expect(results).to.deep.equal([{
      opportunity: 'cwv',
      audit: 'cwv',
      reason: 'Audit executed successfully, found no issues to report (no opportunities created)',
    }]);
  });

  it('skips opportunities that have no related audit in the profile', () => {
    const results = analyzeMissingOpportunities(
      ['meta-tags'],
      ['cwv'], // meta-tags not produced by any configured audit
      ['cwv'],
      { rum: true, seoImport: true, scraping: true },
    );

    expect(results).to.deep.equal([]);
  });

  it('never claims an audit "has not been executed" (that was the CloudWatch false-negative)', () => {
    const results = analyzeMissingOpportunities(
      ['meta-tags'],
      ['meta-tags'],
      [],
      { rum: true, seoImport: true, scraping: true },
    );

    for (const r of results) {
      expect(r.reason).to.not.match(/has not been executed/);
    }
  });
});
