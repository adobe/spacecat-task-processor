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
// Import the module directly and test the pure functions
import {
  extractFromSitemap,
  extractProducts,
  formatProductsForPrompt,
  createProductExtractorService,
} from '../../../../src/agents/brand-profile/services/product-extractor.js';

use(sinonChai);
use(chaiAsPromised);

// --- helpers for the entity-bound extractProducts flow (LLMO-6580) -----------

const searchResp = (ids) => ({
  ok: true,
  json: () => Promise.resolve({ search: ids.map((id) => ({ id })) }),
});

const entityResp = (id, { label, enwikiTitle, hosts = [] }) => ({
  ok: true,
  json: () => Promise.resolve({
    entities: {
      [id]: {
        labels: label ? { en: { value: label } } : {},
        sitelinks: enwikiTitle ? { enwiki: { title: enwikiTitle } } : {},
        claims: hosts.length
          ? { P856: hosts.map((h) => ({ mainsnak: { datavalue: { value: `https://${h}` } } })) }
          : {},
      },
    },
  }),
});

const sparqlResp = (bindings) => ({
  ok: true,
  json: () => Promise.resolve({ results: { bindings } }),
});

const extractResp = (extract) => ({
  ok: true,
  json: () => Promise.resolve({ query: { pages: { 42: { extract } } } }),
});

const llmResp = (payload) => ({
  choices: [{ message: { content: JSON.stringify(payload) } }],
});

const noOpenSearchIssued = (fetchStub) => fetchStub.getCalls().every(
  (c) => !String(c.args[0]).includes('opensearch'),
);

describe('services/product-extractor', () => {
  let sandbox;
  let log;
  let gpt;
  let fetchStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    gpt = {
      fetchChatCompletion: sandbox.stub(),
    };
    fetchStub = sandbox.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('extractFromSitemap', () => {
    it('extracts products from sitemap URLs using LLM', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget-pro</loc></url>
            <url><loc>https://example.com/products/widget-lite</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [
          { name: 'Widget Pro', category: 'Software', variants: [] },
          { name: 'Widget Lite', category: 'Software', variants: [] },
        ],
        services: [],
        sub_brands: [],
        discontinued: [],
        confidence: 'high',
        notes: 'Extracted from product URLs',
      }));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.have.length(2);
      expect(result.products[0].name).to.equal('Widget Pro');
      expect(result.metadata.source).to.equal('sitemap');
      expect(result.metadata.confidence).to.equal('high');
    });

    it('returns error metadata when sitemap fetch fails', async () => {
      fetchStub.rejects(new Error('Network error'));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('sitemap_failed');
      expect(result.metadata.error).to.include('Network error');
    });

    it('returns empty result when sitemap has no URLs', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('<urlset></urlset>'),
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('sitemap_empty');
    });

    it('handles sitemap with no product-relevant URLs', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/about/</loc></url>
            <url><loc>https://example.com/contact/</loc></url>
          </urlset>
        `),
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('sitemap_no_products');
    });

    it('returns error metadata when sitemap response not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('sitemap_failed');
    });

    it('returns error metadata when LLM extraction fails', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.rejects(new Error('LLM error'));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('sitemap_llm_failed');
      expect(result.metadata.error).to.include('LLM error');
    });

    it('normalizes string products from LLM response', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: ['Widget Pro', 'Widget Lite'],
        services: ['Support Service'],
        sub_brands: [],
        discontinued: ['Old Widget'],
      }));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.have.length(2);
      expect(result.products[0].name).to.equal('Widget Pro');
      expect(result.discontinued).to.have.length(1);
    });

    it('handles LLM response with empty choices array', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves({ choices: [] });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.deep.equal([]);
      expect(result.metadata.confidence).to.equal('unknown');
    });

    it('handles LLM response with null message content', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: null } }],
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.deep.equal([]);
    });

    it('handles LLM response with missing optional fields', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'Widget' }],
      }));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.have.length(1);
      expect(result.sub_brands).to.deep.equal([]);
      expect(result.metadata.confidence).to.equal('unknown');
      expect(result.metadata.notes).to.equal('');
    });
  });

  describe('extractProducts (entity-bound, P856-only)', () => {
    it('returns validated Wikidata products (happy path, P856 match)', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['www.dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([
        { itemLabel: { value: 'Express' }, item: { value: 'http://wikidata.org/Q11' }, typeLabel: { value: 'service' } },
        { itemLabel: { value: 'Freight' }, item: { value: 'http://wikidata.org/Q12' }, typeLabel: { value: 'service' } },
        { itemLabel: { value: 'Parcel' }, item: { value: 'http://wikidata.org/Q13' }, typeLabel: { value: 'service' } },
      ]));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(3);
      expect(result.metadata.source).to.equal('wikidata');
      expect(result.metadata.brand_wikidata_id).to.equal('Q1');
      expect(result.metadata.validation).to.equal('p856');
      expect(noOpenSearchIssued(fetchStub)).to.equal(true);
    });

    it('REGRESSION: d*->D-Company yields NO products and NO by-name opensearch', async () => {
      // Search returns a same-initials article that does NOT own dnp.co.jp.
      fetchStub.onCall(0).resolves(searchResp(['Q111']));
      fetchStub.onCall(1).resolves(entityResp('Q111', {
        label: 'D-Company', enwikiTitle: 'D-Company', hosts: [],
      }));

      const result = await extractProducts(
        { brandName: 'Dnp', registrableDomain: 'dnp.co.jp' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(0);
      expect(result.metadata.source).to.equal('none');
      // The decoupled `opensearch "Dnp company"` fetch must never be issued.
      expect(noOpenSearchIssued(fetchStub)).to.equal(true);
      expect(gpt.fetchChatCompletion).to.not.have.been.called;
    });

    it('REGRESSION: e*->E-Company yields NO products and NO by-name opensearch', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q222']));
      fetchStub.onCall(1).resolves(entityResp('Q222', {
        label: 'E Company, 506th Infantry Regiment', enwikiTitle: 'E Company', hosts: [],
      }));

      const result = await extractProducts(
        { brandName: 'Edb', registrableDomain: 'edb.gov.sg' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(0);
      expect(result.metadata.source).to.equal('none');
      expect(noOpenSearchIssued(fetchStub)).to.equal(true);
    });

    it('returns source none when a candidate has a non-matching P856 host', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q9']));
      fetchStub.onCall(1).resolves(entityResp('Q9', { label: 'Totally Different', hosts: ['other.example'] }));

      const result = await extractProducts(
        { brandName: 'Amrize', registrableDomain: 'amrize.com' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(0);
      expect(result.metadata.source).to.equal('none');
      expect(result.metadata.brand_wikidata_id).to.be.null;
    });

    it('uses the validated entity enwiki title (sitelink, not a by-name search) for the fallback', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL Group', hosts: ['www.dhl.com'] }));
      // SPARQL below threshold -> triggers entity-bound Wikipedia fallback.
      fetchStub.onCall(2).resolves(sparqlResp([
        { itemLabel: { value: 'Express' }, item: { value: 'http://wikidata.org/Q11' } },
      ]));
      fetchStub.onCall(3).resolves(extractResp('DHL Group is a logistics company making Freight and Parcel.'));

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'Freight' }, { name: 'Parcel' }],
        services: [],
        sub_brands: ['DHL Express'],
        discontinued: [],
      }));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('hybrid');
      // The extract call used the sitelink title, not a by-name search.
      const extractUrl = fetchStub.getCall(3).args[0];
      expect(extractUrl).to.include('titles=DHL+Group');
      expect(noOpenSearchIssued(fetchStub)).to.equal(true);
      expect(result.products.length).to.be.greaterThan(1);
    });

    it('produces a wikipedia_llm result when SPARQL is empty but the entity validates (P856)', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'Amrize', enwikiTitle: 'Amrize', hosts: ['amrize.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([]));
      fetchStub.onCall(3).resolves(extractResp('Amrize makes Cement and Aggregates.'));

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'Cement' }, { name: 'Aggregates' }],
        services: [],
        sub_brands: [],
        discontinued: [],
      }));

      const result = await extractProducts(
        { brandName: 'Amrize', registrableDomain: 'amrize.com' },
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('wikipedia_llm');
      expect(result.metadata.validation).to.equal('p856');
      expect(result.products).to.have.length(2);
    });

    it('skips the text fallback when the validated entity has no enwiki article', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: null, hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([
        { itemLabel: { value: 'Express' }, item: { value: 'http://wikidata.org/Q11' } },
      ]));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      // SPARQL-only result stands; no LLM call because there is no fallback text.
      expect(result.products).to.have.length(1);
      expect(gpt.fetchChatCompletion).to.not.have.been.called;
      expect(result.metadata.source).to.equal('wikidata');
    });

    it('accepts a provided wikipediaSummary without re-fetching the article', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'Amrize', enwikiTitle: 'Amrize', hosts: ['amrize.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([]));

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'ProvidedProduct' }],
        services: [],
        sub_brands: [],
        discontinued: [],
      }));

      const result = await extractProducts(
        {
          brandName: 'Amrize',
          registrableDomain: 'amrize.com',
          wikipediaSummary: 'Amrize makes ProvidedProduct.',
        },
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('wikipedia_llm');
      expect(result.products).to.have.length(1);
      // Only search + entity + SPARQL fetches; NO extract-by-title fetch.
      expect(fetchStub.callCount).to.equal(3);
    });

    it('merges hybrid results and de-duplicates overlaps', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([
        { itemLabel: { value: 'Product1' }, item: { value: 'http://wikidata.org/Q11' } },
      ]));
      fetchStub.onCall(3).resolves(extractResp('DHL info'));

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [
          { name: 'Product1' }, // duplicate
          { name: 'Product2' },
          { name: '' }, // filtered
        ],
        services: [
          { name: 'Service1' },
          { name: '' },
        ],
        sub_brands: ['SubBrand1'],
        discontinued: [
          { name: 'OldProduct' },
          { name: '' },
        ],
      }));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products.filter((p) => p.name === 'Product1')).to.have.length(1);
      expect(result.products.find((p) => p.name === '')).to.be.undefined;
      expect(result.services.find((s) => s.name === '')).to.be.undefined;
    });

    it('handles a SPARQL query failure gracefully via the fallback', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves({ ok: false, status: 500 });
      fetchStub.onCall(3).resolves(extractResp('DHL info'));

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'FallbackProduct' }],
        services: [],
        sub_brands: [],
        discontinued: [],
      }));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result).to.have.property('products');
      expect(result.metadata.source).to.equal('wikipedia_llm');
    });

    it('handles a Wikipedia LLM extraction error gracefully', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([]));
      fetchStub.onCall(3).resolves(extractResp('DHL info'));

      gpt.fetchChatCompletion.rejects(new Error('LLM failed'));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(0);
    });

    it('truncates a long fallback article before the LLM call', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([]));
      fetchStub.onCall(3).resolves(extractResp('A'.repeat(9000)));

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'FromLongText' }],
        services: [],
        sub_brands: [],
        discontinued: [],
      }));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      // The 9000-char extract must be truncated to 8000 chars + ellipsis before the LLM
      // sees it. Assert on the rendered prompt so removing the truncation fails the test.
      const prompt = gpt.fetchChatCompletion.firstCall.args[0];
      expect(prompt).to.include('...');
      expect(prompt).to.include('A'.repeat(8000));
      expect(prompt).to.not.include('A'.repeat(9000));
      expect(result.products).to.have.length(1);
    });

    it('handles an empty-choices LLM response in the fallback (\'{}\' fallback)', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([]));
      fetchStub.onCall(3).resolves(extractResp('DHL info'));

      gpt.fetchChatCompletion.resolves({ choices: [] });

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(0);
      expect(result.services).to.have.length(0);
    });

    it('skips Wikidata IDs that appear as labels', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([
        { itemLabel: { value: 'Q99999' }, item: { value: 'http://wikidata.org/Q99999' } },
        { itemLabel: { value: 'ValidProduct' }, item: { value: 'http://wikidata.org/Q1a' } },
        { itemLabel: { value: 'ValidProduct' }, item: { value: 'http://wikidata.org/Q2a' } },
        { itemLabel: { value: 'Product3' }, item: { value: 'http://wikidata.org/Q3a' } },
      ]));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products.find((p) => p.name === 'Q99999')).to.be.undefined;
    });

    it('handles wikidata returning discontinued products', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([
        {
          itemLabel: { value: 'CurrentProduct' },
          item: { value: 'http://wikidata.org/Q11' },
          inception: { value: '2020-01-01T00:00:00Z' },
        },
        {
          itemLabel: { value: 'OldProduct' },
          item: { value: 'http://wikidata.org/Q12' },
          inception: { value: '1990-01-01T00:00:00Z' },
          discontinued: { value: '2010-01-01T00:00:00Z' },
        },
        {
          itemLabel: { value: 'Product3' },
          item: { value: 'http://wikidata.org/Q13' },
          typeLabel: { value: 'software_product' },
        },
      ]));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(3);
      const discontinued = result.products.find((p) => p.name === 'OldProduct');
      expect(discontinued.status).to.equal('discontinued');
    });

    it('parses inception dates (with and without T, empty, missing)', async () => {
      fetchStub.onCall(0).resolves(searchResp(['Q1']));
      fetchStub.onCall(1).resolves(entityResp('Q1', { label: 'DHL', enwikiTitle: 'DHL', hosts: ['dhl.com'] }));
      fetchStub.onCall(2).resolves(sparqlResp([
        { itemLabel: { value: 'P1' }, item: { value: 'http://wikidata.org/Q11' }, inception: { value: '1995' } },
        { itemLabel: { value: 'P2' }, item: { value: 'http://wikidata.org/Q12' }, inception: { value: '' } },
        { itemLabel: { value: 'P3' }, item: { value: 'http://wikidata.org/Q13' } },
        { itemLabel: { value: 'P4' }, item: { value: 'http://wikidata.org/Q14' }, inception: { value: '2020-05-15T00:00:00Z' } },
        { itemLabel: { value: 'P5' }, item: { value: 'http://wikidata.org/Q15' }, inception: null },
      ]));

      const result = await extractProducts(
        { brandName: 'DHL', registrableDomain: 'dhl.com' },
        gpt,
        log,
      );

      expect(result.products).to.have.length(5);
      expect(result.products[0].inception_year).to.equal(1995);
      expect(result.products[3].inception_year).to.equal(2020);
      expect(result.products[2].inception_year).to.be.null;
    });
  });

  describe('formatProductsForPrompt', () => {
    it('formats products grouped by category', () => {
      const result = formatProductsForPrompt({
        products: [
          { name: 'Photoshop', category: 'Creative' },
          { name: 'Illustrator', category: 'Creative' },
          { name: 'Acrobat', category: 'Document' },
        ],
        services: [{ name: 'Creative Cloud' }],
        sub_brands: ['Behance'],
      });

      expect(result).to.include('Creative: Photoshop, Illustrator');
      expect(result).to.include('Document: Acrobat');
      expect(result).to.include('Services: Creative Cloud');
      expect(result).to.include('Sub-brands: Behance');
    });

    it('returns default message for empty result', () => {
      const result = formatProductsForPrompt({
        products: [],
        services: [],
        sub_brands: [],
      });

      expect(result).to.equal('No product catalogue available.');
    });

    it('truncates long category lists', () => {
      const result = formatProductsForPrompt({
        products: [
          { name: 'Product1', category: 'Software' },
          { name: 'Product2', category: 'Software' },
          { name: 'Product3', category: 'Software' },
          { name: 'Product4', category: 'Software' },
          { name: 'Product5', category: 'Software' },
          { name: 'Product6', category: 'Software' },
          { name: 'Product7', category: 'Software' },
        ],
        services: [],
        sub_brands: [],
      });

      expect(result).to.include('...');
    });
  });

  describe('createProductExtractorService', () => {
    const env = {
      AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
      AZURE_OPENAI_KEY: 'test-key',
      AZURE_API_VERSION: '2023-05-15',
      AZURE_COMPLETION_DEPLOYMENT: 'gpt-4',
    };

    it('creates service with bound methods', () => {
      const service = createProductExtractorService(env, log);

      expect(service).to.have.property('extractFromSitemap');
      expect(service).to.have.property('extractProducts');
      expect(service).to.have.property('formatProductsForPrompt');
    });

    it('extractFromSitemap service method can be called', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('<urlset></urlset>'),
      });

      const service = createProductExtractorService(env, log);
      const result = await service.extractFromSitemap('https://example.com/sitemap.xml', 'Test');
      expect(result).to.have.property('metadata');
    });

    it('extractProducts service method forwards the options object', async () => {
      // No candidates -> no validated entity -> source none
      fetchStub.resolves({ ok: true, json: () => Promise.resolve({ search: [] }) });

      const service = createProductExtractorService(env, log);
      const result = await service.extractProducts({ brandName: 'TestBrand', registrableDomain: 'test.com' });
      expect(result).to.have.property('metadata');
      expect(result.metadata.source).to.equal('none');
    });
  });

  describe('formatProductsForPrompt edge cases', () => {
    it('handles products without category', () => {
      const result = formatProductsForPrompt({
        products: [{ name: 'Widget' }],
        services: [],
        sub_brands: [],
      });

      expect(result).to.include('Other: Widget');
    });

    it('handles undefined arrays', () => {
      const result = formatProductsForPrompt({});

      expect(result).to.equal('No product catalogue available.');
    });
  });

  describe('extractFromSitemap URL filtering', () => {
    it('includes URLs matching product name pattern', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/widget-pro</loc></url>
            <url><loc>https://example.com/some-product-123/</loc></url>
            <url><loc>https://example.com/about/</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [{ name: 'Widget Pro' }],
        services: [],
        sub_brands: [],
        discontinued: [],
      }));

      await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      // A product-name-pattern URL is kept while an excluded section is dropped: assert on
      // the rendered prompt so a broken filterProductUrls would fail the test.
      const prompt = gpt.fetchChatCompletion.firstCall.args[0];
      expect(prompt).to.include('example.com/widget-pro');
      expect(prompt).to.not.include('example.com/about');
    });
  });

  describe('extractFromSitemap edge cases', () => {
    it('handles LLM returning non-array products', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: null,
        services: 'not-an-array',
        sub_brands: [],
        discontinued: undefined,
      }));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.deep.equal([]);
      expect(result.services).to.deep.equal([]);
    });

    it('handles products with duplicate names (deduplication)', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [
          { name: 'Widget' },
          { name: 'widget' },
          { name: 'WIDGET' },
          { name: 'Other Product' },
        ],
        services: [
          { name: 'Service' },
          { name: 'service' },
        ],
        sub_brands: [],
        discontinued: [],
      }));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.have.length(2);
      expect(result.services).to.have.length(1);
    });

    it('handles products with empty names', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget</loc></url>
          </urlset>
        `),
      });

      gpt.fetchChatCompletion.resolves(llmResp({
        products: [
          { name: '' },
          { name: 'Valid Product' },
          { name: null },
        ],
        services: [{ name: '' }],
        sub_brands: [],
        discontinued: [],
      }));

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      expect(result.products).to.have.length(1);
      expect(result.products[0].name).to.equal('Valid Product');
      expect(result.services).to.have.length(0);
    });
  });
});
