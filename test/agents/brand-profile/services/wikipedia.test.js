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

const WIKI_PATH = '../../../../src/agents/brand-profile/services/wikipedia.js';
const importWiki = () => esmock(WIKI_PATH, {});

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.fetchWikipediaSummary('Unknown Company', log);

      expect(result).to.be.null;
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('Network error'));

      const mod = await importWiki();

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.called;
    });

    it('throws when search response is not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.fetchWikipediaFullText('Test', 1000, log);

      expect(result.length).to.equal(1000);
    });

    it('returns null when no search results', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Test', [], [], []]),
      });

      const mod = await importWiki();

      const result = await mod.fetchWikipediaFullText('Unknown', 12000, log);

      expect(result).to.be.null;
    });

    it('returns null when search response not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.fetchWikipediaFullText('Test', 12000, log);

      expect(result).to.be.null;
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('Network error'));

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.findWikidataId('Unknown', log);

      expect(result).to.equal('Q99999');
    });

    it('returns null when no results', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      const mod = await importWiki();

      const result = await mod.findWikidataId('NonexistentBrand', log);

      expect(result).to.be.null;
    });

    it('returns null when response not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const mod = await importWiki();

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikidata search failed');
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('Network error'));

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.equal('Q11111');
    });
  });

  describe('getWikidataEntity', () => {
    it('parses label, enwiki title and P856 hosts', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q489815: {
              labels: { en: { value: 'DHL' } },
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

      const mod = await importWiki();
      const entity = await mod.getWikidataEntity('Q489815', log);

      expect(entity.id).to.equal('Q489815');
      expect(entity.label).to.equal('DHL');
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

      const mod = await importWiki();
      const entity = await mod.getWikidataEntity('Q1', log);

      expect(entity.label).to.equal('NoWiki');
      expect(entity.enwikiTitle).to.be.null;
      expect(entity.officialWebsiteHosts).to.deep.equal([]);
    });

    it('returns null when the entity is absent from the response', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: {} }),
      });

      const mod = await importWiki();
      const entity = await mod.getWikidataEntity('Q404', log);
      expect(entity).to.be.null;
    });

    it('handles an entity with no labels (label null)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: { Q1: { claims: {} } } }),
      });

      const mod = await importWiki();
      const entity = await mod.getWikidataEntity('Q1', log);
      expect(entity.label).to.be.null;
      expect(entity.enwikiTitle).to.be.null;
      expect(entity.officialWebsiteHosts).to.deep.equal([]);
    });

    it('returns null when response is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 500 });
      const mod = await importWiki();
      const entity = await mod.getWikidataEntity('Q1', log);
      expect(entity).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Wikidata entity fetch failed');
    });

    it('returns null on fetch error', async () => {
      fetchStub.rejects(new Error('boom'));
      const mod = await importWiki();
      const entity = await mod.getWikidataEntity('Q1', log);
      expect(entity).to.be.null;
    });
  });

  describe('validateEntityAgainstSite (P856-only)', () => {
    it('accepts a P856 host whose registrable domain matches the site (co.jp)', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Dai Nippon Printing', officialWebsiteHosts: ['www.dnp.co.jp'] },
        registrableDomain: 'dnp.co.jp',
      });
      expect(result.ok).to.equal(true);
      expect(result.method).to.equal('p856');
    });

    it('rejects a P856 host on a different registrable domain (dnb.de vs dnb.com)', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'German National Library', officialWebsiteHosts: ['www.dnb.de'] },
        registrableDomain: 'dnb.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.method).to.be.null;
      expect(result.reason).to.equal('no_match');
    });

    it('accepts a match found after a non-matching P856 host (multi-host loop)', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: {
          label: 'DHL',
          officialWebsiteHosts: ['other.example', 'www.dhl.com'],
        },
        registrableDomain: 'dhl.com',
      });
      expect(result.ok).to.equal(true);
      expect(result.method).to.equal('p856');
    });

    it('rejects an entity with no P856 host (no by-name / label fallback)', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Dun & Bradstreet Inc', officialWebsiteHosts: [] },
        registrableDomain: 'dnb.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal('no_match');
    });

    it('rejects a P856 match when the site registrable domain is a bare public suffix', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Some Foreign Org', officialWebsiteHosts: ['co.uk'] },
        registrableDomain: 'co.uk',
      });
      expect(result.ok).to.equal(false);
      expect(result.method).to.be.null;
    });

    it('rejects a generalized <generic>.<ccTLD> bare public suffix (com.my)', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Some Foreign Org', officialWebsiteHosts: ['com.my'] },
        registrableDomain: 'com.my',
      });
      expect(result.ok).to.equal(false);
      expect(result.method).to.be.null;
    });

    it('rejects a single-label / empty registrable domain (bare suffix guard)', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'X', officialWebsiteHosts: ['x.com'] },
        registrableDomain: 'localhost',
      });
      expect(result.ok).to.equal(false);
    });

    it('returns false for a null entity', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: null, registrableDomain: 'x.com',
      });
      expect(result).to.deep.equal({ ok: false, method: null, reason: 'no_entity' });
    });

    it('tolerates an entity with no officialWebsiteHosts key', async () => {
      const mod = await importWiki();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Amrize' },
        registrableDomain: 'amrize.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal('no_match');
    });
  });

  describe('findValidatedWikidataEntity', () => {
    it('scans candidates and returns the first P856-validated one', async () => {
      // wbsearchentities candidates
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }, { id: 'Q2' }] }),
      });
      // getWikidataEntity Q1 -> no P856 match
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q1: { labels: { en: { value: 'Other' } }, claims: {} } },
        }),
      });
      // getWikidataEntity Q2 -> P856 match
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

      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'DHL', registrableDomain: 'dhl.com',
      }, log);

      expect(entity.id).to.equal('Q2');
      expect(entity.validation).to.equal('p856');
    });

    it('stops scanning once a candidate validates (does not fetch later candidates)', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }, { id: 'Q2' }] }),
      });
      // Q1 validates via P856 -> Q2 must never be fetched.
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: {
            Q1: {
              labels: { en: { value: 'DHL' } },
              sitelinks: { enwiki: { title: 'DHL' } },
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://www.dhl.com' } } }] },
            },
          },
        }),
      });

      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'DHL', registrableDomain: 'dhl.com',
      }, log);

      expect(entity.id).to.equal('Q1');
      // Exactly two round trips: 1 search + 1 entity fetch. Q2 was never requested.
      expect(fetchStub.callCount).to.equal(2);
    });

    it('REGRESSION: same-initials article with no P856 match returns null', async () => {
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

      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Dnp', registrableDomain: 'dnp.co.jp',
      }, log);

      expect(entity).to.be.null;
    });

    it('returns null when no candidate has a matching P856 host', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }, { id: 'Q2' }] }),
      });
      fetchStub.onCall(1).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q1: { labels: { en: { value: 'Amrize' } }, claims: {} } },
        }),
      });
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q2: { labels: { en: { value: 'Amrize Holdings' } }, claims: {} } },
        }),
      });

      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Amrize', registrableDomain: 'somethingelse.com',
      }, log);

      expect(entity).to.be.null;
    });

    it('returns null when there are no candidates', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });
      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Nope', registrableDomain: 'nope.com',
      }, log);
      expect(entity).to.be.null;
    });

    it('handles a candidate whose entity fetch fails', async () => {
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q1' }] }),
      });
      fetchStub.onCall(1).resolves({ ok: false, status: 500 });

      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
    });

    it('returns null when the candidate search request is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 503 });
      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Error searching Wikidata candidates');
    });

    it('treats a search response without a search array as no candidates', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({}) });
      const mod = await importWiki();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
    });
  });

  describe('fetchWikipediaExtractByTitle', () => {
    it('issues exactly one query with the exact title and NO opensearch', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'DHL is a logistics company.' } } } }),
      });

      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('DHL', 12000, log);

      expect(text).to.equal('DHL is a logistics company.');
      expect(fetchStub).to.have.been.calledOnce;
      const calledUrl = fetchStub.firstCall.args[0];
      expect(calledUrl).to.include('titles=DHL');
      expect(calledUrl).to.not.include('opensearch');
    });

    it('returns null for a missing title without issuing a request', async () => {
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle(null, 12000, log);
      expect(text).to.be.null;
      expect(fetchStub).to.not.have.been.called;
    });

    it('truncates to maxChars', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'A'.repeat(5000) } } } }),
      });
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('X', 100, log);
      expect(text.length).to.equal(100);
    });

    it('uses the default maxChars when not provided', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'short' } } } }),
      });
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('X', null, log);
      expect(text).to.equal('short');
    });

    it('returns null when the page is missing (-1)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { '-1': { missing: true } } } }),
      });
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.be.null;
    });

    it('returns null when the response carries no pages', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: {} }),
      });
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.be.null;
    });

    it('returns null when response is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 500 });
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Error fetching Wikipedia extract by title');
    });

    it('handles an empty extract', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: {} } } }),
      });
      const mod = await importWiki();
      const text = await mod.fetchWikipediaExtractByTitle('X', 12000, log);
      expect(text).to.equal('');
    });
  });

  describe('fetchValidatedSummary', () => {
    it('returns the intro summary of the validated entity enwiki title', async () => {
      // search
      fetchStub.onCall(0).resolves({
        ok: true,
        json: () => Promise.resolve({ search: [{ id: 'Q2' }] }),
      });
      // getWikidataEntity Q2 -> P856
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

      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', registrableDomain: 'dhl.com',
      }, log);

      expect(result).to.deep.equal({ title: 'DHL', summary: 'DHL intro.', entityId: 'Q2' });
      const introUrl = fetchStub.getCall(2).args[0];
      expect(introUrl).to.include('exintro=true');
      expect(introUrl).to.not.include('opensearch');
    });

    it('returns null when no validated entity', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });
      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'X', registrableDomain: 'x.com',
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
      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'X', registrableDomain: 'x.com',
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

      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', registrableDomain: 'dhl.com',
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

      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', registrableDomain: 'dhl.com',
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

      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', registrableDomain: 'dhl.com',
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

      const mod = await importWiki();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', registrableDomain: 'dhl.com',
      }, log);
      expect(result).to.deep.equal({ title: 'DHL', summary: '', entityId: 'Q2' });
    });
  });

  describe('splitHost', () => {
    it('returns the registrable domain for a plain apex', async () => {
      const mod = await importWiki();
      expect(mod.splitHost('dhl.com')).to.deep.equal({
        subdomainLabels: [], apexLabel: 'dhl', registrableDomain: 'dhl.com',
      });
    });

    it('strips a subdomain label', async () => {
      const mod = await importWiki();
      const r = mod.splitHost('dev.amrize.com');
      expect(r.registrableDomain).to.equal('amrize.com');
      expect(r.subdomainLabels).to.deep.equal(['dev']);
    });

    it('honours a multi-part TLD (co.jp)', async () => {
      const mod = await importWiki();
      expect(mod.splitHost('dnp.co.jp').registrableDomain).to.equal('dnp.co.jp');
    });

    it('honours a generalized <generic>.<ccTLD> suffix (com.my)', async () => {
      const mod = await importWiki();
      expect(mod.splitHost('shop.company.com.my').registrableDomain).to.equal('company.com.my');
    });

    it('does not treat a non-generic 2-char ccTLD second level as a suffix (sony.jp)', async () => {
      const mod = await importWiki();
      expect(mod.splitHost('shop.sony.jp').registrableDomain).to.equal('sony.jp');
    });

    it('returns a single label unchanged', async () => {
      const mod = await importWiki();
      expect(mod.splitHost('localhost')).to.deep.equal({
        subdomainLabels: [], apexLabel: 'localhost', registrableDomain: 'localhost',
      });
    });

    it('handles an empty hostname', async () => {
      const mod = await importWiki();
      expect(mod.splitHost('')).to.deep.equal({
        subdomainLabels: [], apexLabel: '', registrableDomain: '',
      });
    });
  });

  describe('createWikipediaService', () => {
    it('creates service with bound methods', async () => {
      const mod = await importWiki();

      const service = mod.createWikipediaService(log);

      expect(service).to.have.property('fetchSummary');
      expect(service).to.have.property('fetchFullText');
      expect(service).to.have.property('findWikidataId');
    });

    it('exposes the entity-binding methods as well', async () => {
      const mod = await importWiki();
      const service = mod.createWikipediaService(log);

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

      const mod = await importWiki();

      const service = mod.createWikipediaService(log);
      expect(await service.fetchSummary('Test')).to.be.null;
      expect(await service.fetchFullText('Test')).to.be.null;
    });

    it('findWikidataId service method forwards the brand name', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });
      const mod = await importWiki();
      const service = mod.createWikipediaService(log);
      expect(await service.findWikidataId('Test')).to.be.null;
    });

    it('getWikidataEntity service method forwards the id', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: { Q7: { labels: { en: { value: 'Bound' } }, claims: {} } } }),
      });

      const mod = await importWiki();
      const service = mod.createWikipediaService(log);
      const entity = await service.getWikidataEntity('Q7');
      expect(entity.id).to.equal('Q7');
    });

    it('findValidatedWikidataEntity service method binds the logger', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });

      const mod = await importWiki();
      const service = mod.createWikipediaService(log);
      const result = await service.findValidatedWikidataEntity({
        brandName: 'Test', registrableDomain: 'test.com',
      });
      expect(result).to.be.null;
    });

    it('fetchExtractByTitle service method forwards title and maxChars', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { 42: { extract: 'bound' } } } }),
      });

      const mod = await importWiki();
      const service = mod.createWikipediaService(log);
      const text = await service.fetchExtractByTitle('DHL', 100);
      expect(text).to.equal('bound');
    });

    it('fetchValidatedSummary service method forwards params', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });

      const mod = await importWiki();
      const service = mod.createWikipediaService(log);
      const result = await service.fetchValidatedSummary({
        brandName: 'Test', registrableDomain: 'test.com',
      });
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

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.fetchWikipediaSummary('Test', log);

      expect(result.title).to.equal('Test Title');
      expect(result.summary).to.equal('');
    });

    it('fetchWikipediaFullText handles missing searchData[1] (titles)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Test']), // Missing titles array at index 1
      });

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.findWikidataId('Test', log);

      expect(result).to.be.null;
    });

    it('fetchWikipediaSummary handles missing searchData[1] (titles)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve(['Search']), // Missing titles array at index 1
      });

      const mod = await importWiki();

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

      const mod = await importWiki();

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

      const mod = await importWiki();

      const result = await mod.fetchWikipediaSummary('Test', log);

      // Should return null because pages would be {}
      expect(result).to.be.null;
    });
  });
});
