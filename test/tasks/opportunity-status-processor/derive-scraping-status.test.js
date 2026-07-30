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
import { deriveScrapingStatus } from '../../../src/tasks/opportunity-status-processor/handler.js';

describe('deriveScrapingStatus', () => {
  it('is "available" when at least one URL completed', () => {
    expect(deriveScrapingStatus({
      completed: 5, failed: 2, pending: 10, total: 17,
    }))
      .to.equal('available');
  });

  it('is "in_progress" when nothing completed but URLs are still pending/running', () => {
    // The clover case: 0 completed, 159 failed, 829 still pending out of 988.
    expect(deriveScrapingStatus({
      completed: 0, failed: 159, pending: 829, total: 988,
    }))
      .to.equal('in_progress');
  });

  it('is "failed" only when terminal with zero completions', () => {
    expect(deriveScrapingStatus({
      completed: 0, failed: 12, pending: 0, total: 12,
    }))
      .to.equal('failed');
  });

  it('is "unknown" when there are no results yet', () => {
    expect(deriveScrapingStatus({
      completed: 0, failed: 0, pending: 0, total: 0,
    }))
      .to.equal('unknown');
  });

  it('is "unknown" when no stats are available', () => {
    expect(deriveScrapingStatus(null)).to.equal('unknown');
    expect(deriveScrapingStatus(undefined)).to.equal('unknown');
  });
});
