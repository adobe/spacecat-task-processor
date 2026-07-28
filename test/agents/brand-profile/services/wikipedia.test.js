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
      expect(service).to.have.property('getWikidataEntity');
      expect(service).to.have.property('findValidatedWikidataEntity');
      expect(service).to.have.property('fetchExtractByTitle');
      expect(service).to.have.property('fetchValidatedSummary');
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

  describe('getWikidataEntity', () => {
    const importMod = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

    it('parses label, aliases, enwiki title and P856 hosts', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q489815: {
              labels: { en: { value: 'DHL' } },
              aliases: { en: [{ value: 'DHL Express' }] },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: {
                P856: [
                  { mainsnak: { datavalue: { value: 'https://www.dhl.com/' } } },
                ],
              },
            },
          },
        }),
      });

      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q489815', log);

      expect(entity.id).to.equal('Q489815');
      expect(entity.label).to.equal('DHL');
      expect(entity.aliases).to.deep.equal(['DHL Express']);
      expect(entity.enwikiTitle).to.equal('DHL');
      expect(entity.officialWebsiteHosts).to.deep.equal(['www.dhl.com']);
    });

    it('handles missing claims and missing sitelink and invalid P856 URLs', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q1: {
              labels: { en: { value: 'NoWiki' } },
              claims: {
                P856: [
                  { mainsnak: { datavalue: { value: 'not a url' } } },
                ],
              },
            },
          },
        }),
      });

      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q1', log);

      expect(entity.enwikiTitle).to.be.null;
      expect(entity.aliases).to.deep.equal([]);
      expect(entity.officialWebsiteHosts).to.deep.equal([]);
    });

    it('returns null when the entity is absent from the response', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: {} }),
      });

      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q404', log);
      expect(entity).to.be.null;
    });

    it('handles an entity with no labels (label null)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: { Q1: { claims: {} } } }),
      });

      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q1', log);
      expect(entity.label).to.be.null;
      expect(entity.aliases).to.deep.equal([]);
      expect(entity.enwikiTitle).to.be.null;
    });

    it('returns null when response is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 500 });
      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q1', log);
      expect(entity).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikidata entity fetch failed');
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('boom'));
      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q1', log);
      expect(entity).to.be.null;
    });
  });

  describe('validateEntityAgainstSite', () => {
    const importMod = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

    it('accepts a P856 host whose registrable domain matches the site (co.jp)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Dai Nippon Printing', aliases: [], officialWebsiteHosts: ['www.dnp.co.jp'] },
        brandName: 'Dnp',
        brandConfidence: 'low',
        registrableDomain: 'dnp.co.jp',
      });
      expect(result.ok).to.equal(true);
      expect(result.method).to.equal('p856');
    });

    it('rejects a P856 host on a different registrable domain (dnb.de vs dnb.com)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'German National Library', aliases: [], officialWebsiteHosts: ['www.dnb.de'] },
        brandName: 'Dnb',
        brandConfidence: 'low',
        registrableDomain: 'dnb.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal('low_confidence_requires_p856');
    });

    it('accepts a label token-overlap match for a high-confidence name', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Dun & Bradstreet Inc', aliases: [], officialWebsiteHosts: [] },
        brandName: 'Dun & Bradstreet',
        brandConfidence: 'high',
        registrableDomain: 'dnb.com',
      });
      expect(result.ok).to.equal(true);
      expect(result.method).to.equal('label');
    });

    it('rejects a label match for a low-confidence name (acronym safety rule)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'D-Company', aliases: [], officialWebsiteHosts: [] },
        brandName: 'Dnp',
        brandConfidence: 'low',
        registrableDomain: 'dnp.co.jp',
      });
      expect(result.ok).to.equal(false);
    });

    it('returns false for a null entity', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: null, brandName: 'X', brandConfidence: 'high', registrableDomain: 'x.com',
      });
      expect(result).to.deep.equal({ ok: false, method: null, reason: 'no_entity' });
    });

    it('returns no_match when nothing overlaps for a high-confidence name', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Totally Different Org', aliases: [], officialWebsiteHosts: ['other.example'] },
        brandName: 'Amrize',
        brandConfidence: 'medium',
        registrableDomain: 'amrize.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal('no_match');
    });

    it('tolerates an entity with no hosts/aliases keys (label match)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Amrize' },
        brandName: 'Amrize',
        brandConfidence: 'high',
        registrableDomain: 'somethingelse.com',
      });
      expect(result.ok).to.equal(true);
      expect(result.method).to.equal('label');
    });

    it('tolerates an empty brand name (no tokens to match)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Amrize' },
        brandName: '',
        brandConfidence: 'high',
        registrableDomain: 'somethingelse.com',
      });
      expect(result.ok).to.equal(false);
    });
  });

  describe('findValidatedWikidataEntity', () => {
    const importMod = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

    it('returns the first P856-validated candidate', async () => {
      // wbsearchentities candidates
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }, { id: 'Q2' }] }),
      });
      // getWikidataEntity Q1 -> no p856 match, label mismatch
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q1: { labels: { en: { value: 'Other' } }, claims: {} } },
        }),
      });
      // getWikidataEntity Q2 -> p856 match
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q2: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://www.dhl.com' } } }] },
            },
          },
        }),
      });

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'DHL', brandConfidence: 'low', registrableDomain: 'dhl.com',
      }, log);

      expect(entity.id).to.equal('Q2');
      expect(entity.validation).to.equal('p856');
    });

    it('REGRESSION: low-confidence acronym with no P856 match returns null', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q111' }] }),
      });
      // "D-Company" style article: label overlaps but no P856 to the site
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q111: {
              labels: { en: { value: 'D-Company' } },
              sitelinks: { enwiki: { title: 'D-Company' } },
              claims: {},
            },
          },
        }),
      });

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Dnp', brandConfidence: 'low', registrableDomain: 'dnp.co.jp',
      }, log);

      expect(entity).to.be.null;
    });

    it('falls back to the first label match for a non-low-confidence name', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }, { id: 'Q2' }] }),
      });
      // Q1 label match
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q1: { labels: { en: { value: 'Amrize' } }, sitelinks: { enwiki: { title: 'Amrize' } }, claims: {} } },
        }),
      });
      // Q2 also label match (second one -> rejected path)
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q2: { labels: { en: { value: 'Amrize Holdings' } }, claims: {} } },
        }),
      });

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Amrize', brandConfidence: 'medium', registrableDomain: 'somethingelse.com',
      }, log);

      expect(entity.id).to.equal('Q1');
      expect(entity.validation).to.equal('label');
    });

    it('returns null when there are no candidates', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });
      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Nope', brandConfidence: 'high', registrableDomain: 'nope.com',
      }, log);
      expect(entity).to.be.null;
    });

    it('handles a candidate whose entity fetch fails', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }] }),
      });
      fetchStub.onCall(1).resolves({ ok: false, status: 500 });

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', brandConfidence: 'high', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
    });

    it('returns [] candidates when the search request is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 503 });
      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', brandConfidence: 'high', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Error searching Wikidata candidates');
    });

    it('treats a search response without a search array as no candidates', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({}) });
      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', brandConfidence: 'high', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
    });
  });

  describe('fetchWikipediaExtractByTitle', () => {
    const importMod = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

    it('issues exactly one query with the exact title and NO opensearch', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'DHL is a logistics company.' } } } }),
      });

      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('DHL', 12000, log);

      expect(text).to.equal('DHL is a logistics company.');
      expect(fetchStub).to.have.been.calledOnce;
      const calledUrl = fetchStub.firstCall.args[0];
      expect(calledUrl).to.include('titles=DHL');
      expect(calledUrl).to.not.include('opensearch');
    });

    it('returns null for a missing title without issuing a request', async () => {
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle(null, 12000, log);
      expect(text).to.be.null;
      expect(fetchStub).to.not.have.been.called;
    });

    it('truncates to maxChars', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'A'.repeat(5000) } } } }),
      });
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('X', 100, log);
      expect(text.length).to.equal(100);
    });

    it('uses the default maxChars when not provided', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'short' } } } }),
      });
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('X', null, log);
      expect(text).to.equal('short');
    });

    it('returns null when the page is missing (-1)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { '-1': { missing: true } } } }),
      });
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.be.null;
    });

    it('returns null when the response carries no pages', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: {} }),
      });
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.be.null;
    });

    it('returns null when response is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 500 });
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Error fetching Wikipedia extract by title');
    });

    it('handles an empty extract', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: {} } } }),
      });
      const mod = await importMod();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.equal('');
    });
  });

  describe('fetchValidatedSummary', () => {
    const importMod = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

    it('returns the intro summary of the validated entity enwiki title', async () => {
      // search
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q2' }] }),
      });
      // getWikidataEntity Q2 -> p856
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q2: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://www.dhl.com' } } }] },
            },
          },
        }),
      });
      // intro extract
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'DHL intro.' } } } }),
      });

      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', brandConfidence: 'low', registrableDomain: 'dhl.com',
      }, log);

      expect(result).to.deep.equal({ title: 'DHL', summary: 'DHL intro.', entityId: 'Q2' });
      const introUrl = fetchStub.getCall(2).args[0];
      expect(introUrl).to.include('exintro=true');
      expect(introUrl).to.not.include('opensearch');
    });

    it('returns null when no validated entity', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });
      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'X', brandConfidence: 'high', registrableDomain: 'x.com',
      }, log);
      expect(result).to.be.null;
    });

    it('returns null when the validated entity has no enwiki title', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q9' }] }),
      });
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q9: {
              labels: { en: { value: 'NoWiki' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://x.com' } } }] },
            },
          },
        }),
      });
      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'X', brandConfidence: 'low', registrableDomain: 'x.com',
      }, log);
      expect(result).to.be.null;
    });

    it('returns null when the intro fetch is not ok', async () => {
      fetchStub.onCall(0).resolves({ ok: true, json: () => Promise.resolve({ search: [{ id: 'Q2' }] }) });
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q2: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://dhl.com' } } }] },
            },
          },
        }),
      });
      fetchStub.onCall(2).resolves({ ok: false, status: 500 });

      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', brandConfidence: 'low', registrableDomain: 'dhl.com',
      }, log);
      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Error fetching validated summary');
    });

    it('returns null when the intro page is missing (-1)', async () => {
      fetchStub.onCall(0).resolves({ ok: true, json: () => Promise.resolve({ search: [{ id: 'Q2' }] }) });
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q2: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://dhl.com' } } }] },
            },
          },
        }),
      });
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { '-1': {} } } }),
      });

      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', brandConfidence: 'low', registrableDomain: 'dhl.com',
      }, log);
      expect(result).to.be.null;
    });

    it('returns null when the intro response carries no pages', async () => {
      fetchStub.onCall(0).resolves({ ok: true, json: () => Promise.resolve({ search: [{ id: 'Q2' }] }) });
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q2: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://dhl.com' } } }] },
            },
          },
        }),
      });
      fetchStub.onCall(2).resolves({ ok: true, json: () => Promise.resolve({ query: {} }) });

      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', brandConfidence: 'low', registrableDomain: 'dhl.com',
      }, log);
      expect(result).to.be.null;
    });

    it('returns an empty summary when the intro page has no extract', async () => {
      fetchStub.onCall(0).resolves({ ok: true, json: () => Promise.resolve({ search: [{ id: 'Q2' }] }) });
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q2: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://dhl.com' } } }] },
            },
          },
        }),
      });
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: {} } } }),
      });

      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', brandConfidence: 'low', registrableDomain: 'dhl.com',
      }, log);
      expect(result).to.deep.equal({ title: 'DHL', summary: '', entityId: 'Q2' });
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
