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

const importMod = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

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

      const mod = await importMod();
      const entity = await mod.getWikidataEntity('Q489815', log);

      expect(entity.id).to.equal('Q489815');
      expect(entity.label).to.equal('DHL');
      expect(entity.enwikiTitle).to.equal('DHL');
      expect(entity.officialWebsiteHosts).to.deep.equal(['www.dhl.com']);
      // Aliases are no longer parsed (P856-only design).
      expect(entity).to.not.have.property('aliases');
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

      expect(entity.label).to.equal('NoWiki');
      expect(entity.enwikiTitle).to.be.null;
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
      expect(entity.enwikiTitle).to.be.null;
      expect(entity.officialWebsiteHosts).to.deep.equal([]);
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

  describe('validateEntityAgainstSite (P856-only)', () => {
    it('accepts a P856 host whose registrable domain matches the site (co.jp)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Dai Nippon Printing', officialWebsiteHosts: ['www.dnp.co.jp'] },
        registrableDomain: 'dnp.co.jp',
      });
      expect(result.ok).to.equal(true);
      expect(result.method).to.equal('p856');
    });

    it('rejects a P856 host on a different registrable domain (dnb.de vs dnb.com)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'German National Library', officialWebsiteHosts: ['www.dnb.de'] },
        registrableDomain: 'dnb.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.method).to.be.null;
      expect(result.reason).to.equal('no_match');
    });

    it('rejects an entity with no P856 host (no by-name / label fallback)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Dun & Bradstreet Inc', officialWebsiteHosts: [] },
        registrableDomain: 'dnb.com',
      });
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal('no_match');
    });

    it('rejects a P856 match when the site registrable domain is a bare public suffix', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Some Foreign Org', officialWebsiteHosts: ['co.uk'] },
        registrableDomain: 'co.uk',
      });
      expect(result.ok).to.equal(false);
      expect(result.method).to.be.null;
    });

    it('rejects a generalized <generic>.<ccTLD> bare public suffix (com.my)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'Some Foreign Org', officialWebsiteHosts: ['com.my'] },
        registrableDomain: 'com.my',
      });
      expect(result.ok).to.equal(false);
      expect(result.method).to.be.null;
    });

    it('rejects a single-label / empty registrable domain (bare suffix guard)', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: { label: 'X', officialWebsiteHosts: ['x.com'] },
        registrableDomain: 'localhost',
      });
      expect(result.ok).to.equal(false);
    });

    it('returns false for a null entity', async () => {
      const mod = await importMod();
      const result = mod.validateEntityAgainstSite({
        entity: null, registrableDomain: 'x.com',
      });
      expect(result).to.deep.equal({ ok: false, method: null, reason: 'no_entity' });
    });

    it('tolerates an entity with no officialWebsiteHosts key', async () => {
      const mod = await importMod();
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

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'DHL', registrableDomain: 'dhl.com',
      }, log);

      expect(entity.id).to.equal('Q2');
      expect(entity.validation).to.equal('p856');
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

      const mod = await importMod();
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

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'Amrize', registrableDomain: 'somethingelse.com',
      }, log);

      expect(entity).to.be.null;
    });

    it('returns null when there are no candidates', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });
      const mod = await importMod();
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

      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
    });

    it('returns null when the candidate search request is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 503 });
      const mod = await importMod();
      const entity = await mod.findValidatedWikidataEntity({
        brandName: 'X', registrableDomain: 'x.com',
      }, log);
      expect(entity).to.be.null;
      expect(log.error).to.have.been.calledWithMatch('Error searching Wikidata candidates');
    });

    it('treats a search response without a search array as no candidates', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({}) });
      const mod = await importMod();
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

      const mod = await importMod();
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
      const mod = await importMod();
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
      const mod = await importMod();
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

      const mod = await importMod();
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

      const mod = await importMod();
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

      const mod = await importMod();
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

      const mod = await importMod();
      const result = await mod.fetchValidatedSummary({
        brandName: 'DHL', registrableDomain: 'dhl.com',
      }, log);
      expect(result).to.deep.equal({ title: 'DHL', summary: '', entityId: 'Q2' });
    });
  });

  describe('createWikipediaService', () => {
    it('exposes only entity-bound methods (no by-name lookups)', async () => {
      const mod = await importMod();
      const service = mod.createWikipediaService(log);

      expect(service).to.have.property('getWikidataEntity');
      expect(service).to.have.property('findValidatedWikidataEntity');
      expect(service).to.have.property('fetchExtractByTitle');
      expect(service).to.have.property('fetchValidatedSummary');
      // Deprecated by-name methods must not be exposed.
      expect(service).to.not.have.property('fetchSummary');
      expect(service).to.not.have.property('fetchFullText');
      expect(service).to.not.have.property('findWikidataId');
    });

    it('binds the logger to service methods', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });

      const mod = await importMod();
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

      const mod = await importMod();
      const service = mod.createWikipediaService(log);
      const text = await service.fetchExtractByTitle('DHL', 100);
      expect(text).to.equal('bound');
    });

    it('getWikidataEntity service method forwards the id', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: { Q7: { labels: { en: { value: 'Bound' } }, claims: {} } } }),
      });

      const mod = await importMod();
      const service = mod.createWikipediaService(log);
      const entity = await service.getWikidataEntity('Q7');
      expect(entity.id).to.equal('Q7');
    });

    it('fetchValidatedSummary service method forwards params', async () => {
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });

      const mod = await importMod();
      const service = mod.createWikipediaService(log);
      const result = await service.fetchValidatedSummary({
        brandName: 'Test', registrableDomain: 'test.com',
      });
      expect(result).to.be.null;
    });
  });
});
