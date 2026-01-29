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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);
use(chaiAsPromised);

describe('services/wikipedia', () => {
  let sandbox;
  let log;
  let fetchStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    fetchStub = sandbox.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('fetchWikipediaSummary', () => {
    it('fetches and returns Wikipedia summary', async () => {
      // Mock search response
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve([
          'Swiss Life',
          ['Swiss Life'],
          [''],
          ['https://en.wikipedia.org/wiki/Swiss_Life'],
        ]),
      });

      // Mock summary response
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: {
                title: 'Swiss Life',
                extract: 'Swiss Life is a Swiss insurance company...',
                pageprops: { wikibase_item: 'Q680290' },
              },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Swiss Life company', log);

      expect(result.title).to.equal('Swiss Life');
      expect(result.summary).to.include('Swiss insurance company');
      expect(result.wikidataId).to.equal('Q680290');
    });

    it('returns null when no search results', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Swiss Life', [], [], []]),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Unknown Company', log);

      expect(result).to.be.null;
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('Network error'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.called;
    });

    it('throws when search response is not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikipedia search failed');
    });

    it('throws when summary response is not ok', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: false,
        status: 503,
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikipedia summary fetch failed');
    });

    it('returns null when page not found (pageId is -1)', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              '-1': { missing: true },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result).to.be.null;
    });
  });

  describe('fetchWikipediaFullText', () => {
    it('fetches full Wikipedia article text', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Swiss Life', ['Swiss Life'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: {
                extract: 'Full article content...',
              },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Swiss Life company', 12000, log);

      expect(result).to.equal('Full article content...');
    });

    it('truncates content to maxChars', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test'], [], []]),
      });

      const longText = 'A'.repeat(20000);
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: {
                extract: longText,
              },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 1000, log);

      expect(result.length).to.equal(1000);
    });

    it('returns null when no search results', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Test', [], [], []]),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Unknown', 12000, log);

      expect(result).to.be.null;
    });

    it('returns null when search response not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikipedia search failed');
    });

    it('returns null when content response not ok', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: false,
        status: 503,
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikipedia content fetch failed');
    });

    it('returns null when page not found (pageId is -1)', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              '-1': { missing: true },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.be.null;
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('Network error'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.called;
    });

    it('uses default maxChars when not provided', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: {
                extract: 'Short content',
              },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', null, log);

      expect(result).to.equal('Short content');
    });
  });

  describe('findWikidataId', () => {
    it('finds Wikidata ID for a brand', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [
            { id: 'Q12345', description: 'American technology company' },
            { id: 'Q67890', description: 'unrelated' },
          ],
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('Adobe', log);

      expect(result).to.equal('Q12345');
    });

    it('returns first result if no company match', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [
            { id: 'Q99999', description: 'Something else' },
          ],
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('Unknown', log);

      expect(result).to.equal('Q99999');
    });

    it('returns null when no results', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('NonexistentBrand', log);

      expect(result).to.be.null;
    });

    it('returns null when response not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikidata search failed');
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('Network error'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.called;
    });

    it('handles entity with no description', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [
            { id: 'Q11111' },
          ],
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.equal('Q11111');
    });
  });

  describe('createWikipediaService', () => {
    it('creates service with bound methods', async () => {
      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const service = mod.createWikipediaService(log);

      expect(service).to.have.property('fetchSummary');
      expect(service).to.have.property('fetchFullText');
      expect(service).to.have.property('findWikidataId');
    });

    it('service methods can be called', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Test', [], [], []]),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const service = mod.createWikipediaService(log);
      const result = await service.fetchSummary('Test');

      expect(result).to.be.null;
    });
  });

  describe('edge cases', () => {
    it('fetchWikipediaSummary handles page without wikibase_item', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: {
                title: 'Test Title',
                extract: 'Summary text',
                pageprops: {},
              },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result.title).to.equal('Test Title');
      expect(result.wikidataId).to.be.null;
    });

    it('fetchWikipediaFullText handles page with empty extract', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: { extract: '' },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.equal('');
    });

    it('fetchWikipediaSummary handles page without extract', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: {
                title: 'Test Title',
                // No extract field at all
                pageprops: { wikibase_item: 'Q12345' },
              },
            },
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result.title).to.equal('Test Title');
      expect(result.summary).to.equal('');
    });

    it('fetchWikipediaFullText handles missing searchData[1] (titles)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Test']), // Missing titles array at index 1
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.be.null;
    });

    it('fetchWikipediaFullText handles missing query.pages', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            // No pages field
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      // Should return null because pageId would be undefined
      expect(result).to.be.null;
    });

    it('findWikidataId handles missing search array in response', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          // No search field
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.be.null;
    });

    it('fetchWikipediaSummary handles missing searchData[1] (titles)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Search']), // Missing titles array at index 1
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result).to.be.null;
    });

    it('fetchWikipediaSummary handles missing query.pages in summary response', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            // No pages field - should use fallback {}
          },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      // Should return null because pageId would be undefined
      expect(result).to.be.null;
    });

    it('fetchWikipediaSummary handles missing query entirely in response', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Test', ['Test Title'], [], []]),
      });

      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          // No query field at all
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const result = await mod.fetchWikipediaSummary('Test', log);

      // Should return null because pages would be {}
      expect(result).to.be.null;
    });
  });
});
