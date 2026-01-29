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
  });
});
