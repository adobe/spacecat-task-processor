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

      expect(service).to.have.property('findWikidataId');
      expect(service).to.have.property('resolveBrand');
    });

    it('service methods can be called', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const service = mod.createWikipediaService(log);
      const result = await service.findWikidataId('Test');

      expect(result).to.be.null;
    });
  });

  describe('edge cases', () => {
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
  });

  describe('fetchWikidataSitelinkTitle', () => {
    it('returns the enwiki title for a QID', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({
          entities: { Q6690181: { sitelinks: { enwiki: { title: 'Lovesac' } } } },
        }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const title = await mod.fetchWikidataSitelinkTitle('Q6690181', log);

      expect(title).to.equal('Lovesac');
      const calledUrl = fetchStub.firstCall.args[0];
      expect(calledUrl).to.include('action=wbgetentities');
      expect(calledUrl).to.include('sitefilter=enwiki');
      expect(calledUrl).to.include('Q6690181');
    });

    it('returns null when the entity has no enwiki sitelink', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ entities: { Q6690181: { sitelinks: {} } } }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      expect(await mod.fetchWikidataSitelinkTitle('Q6690181', log)).to.equal(null);
    });

    it('returns null on a non-ok response', async () => {
      fetchStub.resolves({ ok: false, status: 500 });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      expect(await mod.fetchWikidataSitelinkTitle('Q6690181', log)).to.equal(null);
      expect(log.error).to.have.been.called;
    });

    it('returns null when fetch rejects', async () => {
      fetchStub.rejects(new Error('network'));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      expect(await mod.fetchWikidataSitelinkTitle('Q6690181', log)).to.equal(null);
    });
  });

  describe('fetchWikipediaArticleByTitle', () => {
    const pageResp = (over = {}) => ({
      ok: true,
      json: () => Promise.resolve({
        query: {
          pages: {
            123: {
              title: 'Lovesac',
              extract: 'Lovesac is a furniture company.\n\nIt makes modular couches.',
              pageprops: { wikibase_item: 'Q6690181' },
              ...over,
            },
          },
        },
      }),
    });

    it('fetches extract + wikibase_item in one call and requests redirects=1', async () => {
      fetchStub.resolves(pageResp());

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const res = await mod.fetchWikipediaArticleByTitle('Lovesac', 12000, log);

      expect(res).to.deep.include({ title: 'Lovesac', wikidataId: 'Q6690181' });
      expect(res.fullText).to.include('modular couches');
      expect(res.summary).to.equal('Lovesac is a furniture company.');
      const url = fetchStub.firstCall.args[0];
      expect(url).to.include('prop=extracts');
      expect(url).to.include('pageprops');
      expect(url).to.include('redirects=1');
      expect(url).to.not.include('action=opensearch');
    });

    it('truncates fullText to maxChars', async () => {
      fetchStub.resolves(pageResp({ extract: 'x'.repeat(50) }));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const res = await mod.fetchWikipediaArticleByTitle('Lovesac', 10, log);
      expect(res.fullText).to.have.length(10);
    });

    it('returns wikidataId null when the page has no wikibase_item', async () => {
      fetchStub.resolves(pageResp({ pageprops: {} }));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const res = await mod.fetchWikipediaArticleByTitle('Lovesac', 12000, log);
      expect(res.wikidataId).to.equal(null);
    });

    it('returns null for a missing page (-1)', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ query: { pages: { '-1': {} } } }),
      });

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      expect(await mod.fetchWikipediaArticleByTitle('Nope', 12000, log)).to.equal(null);
    });

    it('returns null on non-ok and on reject', async () => {
      fetchStub.resolves({ ok: false, status: 500 });

      let mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );
      expect(await mod.fetchWikipediaArticleByTitle('Lovesac', 12000, log)).to.equal(null);

      fetchStub.rejects(new Error('network'));
      mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );
      expect(await mod.fetchWikipediaArticleByTitle('Lovesac', 12000, log)).to.equal(null);
    });

    it('uses a default maxChars when not provided', async () => {
      fetchStub.resolves(pageResp({ extract: 'y'.repeat(20000) }));

      const mod = await esmock(
        '../../../../src/agents/brand-profile/services/wikipedia.js',
        {},
      );

      const res = await mod.fetchWikipediaArticleByTitle('Lovesac', undefined, log);
      expect(res.fullText).to.have.length(12000);
    });
  });

  describe('resolveBrandWikipedia', () => {
    const ok = (body) => ({ ok: true, json: () => Promise.resolve(body) });
    const searchHit = (id) => ok({ search: [{ id, description: 'furniture company' }] });
    const sitelink = (title) => ok({
      entities: { Q6690181: { sitelinks: { enwiki: { title } } } },
    });
    const article = (wb) => ok({
      query: {
        pages: {
          1: {
            title: 'Lovesac',
            extract: 'Lovesac is furniture.\n\nMore.',
            pageprops: wb === undefined ? {} : { wikibase_item: wb },
          },
        },
      },
    });
    const route = ({ search, title, art }) => fetchStub.callsFake((url) => {
      if (url.includes('wbsearchentities')) return Promise.resolve(search || searchHit('Q6690181'));
      if (url.includes('wbgetentities')) return Promise.resolve(title || sitelink('Lovesac'));
      return Promise.resolve(art || article('Q6690181'));
    });
    const load = () => esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});

    it('resolves and verifies when the article wikibase_item matches the QID', async () => {
      route({});
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
      expect(res).to.include({
        verified: true, wikidataId: 'Q6690181', title: 'Lovesac', discardReason: null,
      });
      expect(res.fullText).to.include('furniture');
      const urls = fetchStub.getCalls().map((c) => c.args[0]);
      expect(urls.some((u) => u.includes('wbsearchentities'))).to.equal(false);
    });

    it('re-resolves the QID from brandName when none is passed', async () => {
      route({});
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', {}, log);
      expect(res.verified).to.equal(true);
      const urls = fetchStub.getCalls().map((c) => c.args[0]);
      expect(urls.some((u) => u.includes('wbsearchentities'))).to.equal(true);
    });

    it('discards on guard mismatch and warns with diagnostics', async () => {
      route({ title: sitelink('Lovisa'), art: article('Q1141985') });
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
      expect(res).to.include({
        verified: false, discardReason: 'guard-mismatch', fullText: '', summary: '',
      });
      expect(log.warn).to.have.been.called;
      const msg = log.warn.firstCall.args[0];
      expect(msg).to.include('Q6690181');
      expect(msg).to.include('Q1141985');
    });

    it('discards when the page has no wikibase_item (distinct from mismatch)', async () => {
      route({ art: article(undefined) });
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
      expect(res).to.include({ verified: false, discardReason: 'guard-mismatch' });
    });

    it('returns no-qid when the QID cannot be resolved', async () => {
      route({ search: ok({ search: [] }) });
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Nope', {}, log);
      expect(res).to.include({ verified: false, discardReason: 'no-qid' });
    });

    it('returns no-sitelink when the entity has no enwiki article', async () => {
      route({ title: ok({ entities: { Q6690181: { sitelinks: {} } } }) });
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
      expect(res).to.include({ verified: false, discardReason: 'no-sitelink', wikidataId: 'Q6690181' });
    });

    it('returns fetch-error when the article fetch fails', async () => {
      route({ art: { ok: false, status: 500 } });
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
      expect(res).to.include({ verified: false, discardReason: 'fetch-error' });
    });

    it('does exact-string QID comparison (no normalization)', async () => {
      route({ art: article('q6690181') });
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, log);
      expect(res.verified).to.equal(false);
    });

    it('never throws: degrades to fetch-error if an unexpected error escapes', async () => {
      // Reach the guard-mismatch branch, then make its logging throw so the
      // failure escapes the inner helpers into the outer catch.
      route({ title: sitelink('Lovisa'), art: article('Q1141985') });
      const throwingLog = { ...log, warn: sandbox.stub().throws(new Error('logger down')) };
      const mod = await load();
      const res = await mod.resolveBrandWikipedia('Lovesac', { wikidataId: 'Q6690181' }, throwingLog);
      expect(res).to.include({ verified: false, discardReason: 'fetch-error' });
      expect(throwingLog.error).to.have.been.called;
    });
  });

  describe('createWikipediaService.resolveBrand', () => {
    it('exposes resolveBrand as a bound function', async () => {
      const mod = await esmock('../../../../src/agents/brand-profile/services/wikipedia.js', {});
      const svc = mod.createWikipediaService(log);
      expect(svc).to.have.property('resolveBrand').that.is.a('function');
    });
  });
});
