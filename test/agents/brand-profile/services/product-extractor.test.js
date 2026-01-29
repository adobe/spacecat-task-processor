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
// Import the module directly and test the pure functions
import {
  extractFromSitemap,
  extractProducts,
  formatProductsForPrompt,
  createProductExtractorService,
} from '../../../../src/agents/brand-profile/services/product-extractor.js';

use(sinonChai);
use(chaiAsPromised);

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
      // Mock sitemap fetch
      fetchStub.onFirstCall().resolves({
        ok: true,
        text: () => Promise.resolve(`
          <urlset>
            <url><loc>https://example.com/products/widget-pro</loc></url>
            <url><loc>https://example.com/products/widget-lite</loc></url>
          </urlset>
        `),
      });

      // Mock LLM response
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [
                { name: 'Widget Pro', category: 'Software', variants: [] },
                { name: 'Widget Lite', category: 'Software', variants: [] },
              ],
              services: [],
              sub_brands: [],
              discontinued: [],
              confidence: 'high',
              notes: 'Extracted from product URLs',
            }),
          },
        }],
      });

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

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: ['Widget Pro', 'Widget Lite'],
              services: ['Support Service'],
              sub_brands: [],
              discontinued: ['Old Widget'],
            }),
          },
        }],
      });

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

      gpt.fetchChatCompletion.resolves({
        choices: [], // Empty choices array
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      // Should use '{}' fallback and return empty arrays
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

      // Should use '{}' fallback
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

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [{ name: 'Widget' }],
              // Missing: sub_brands, confidence, notes
            }),
          },
        }],
      });

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

  describe('extractProducts', () => {
    it('extracts products using Wikidata when available', async () => {
      // Mock Wikidata ID search
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'American company' }],
        }),
      });

      // Mock SPARQL query
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              {
                itemLabel: { value: 'Photoshop' },
                item: { value: 'http://wikidata.org/Q34567' },
                typeLabel: { value: 'software' },
              },
              {
                itemLabel: { value: 'Illustrator' },
                item: { value: 'http://wikidata.org/Q45678' },
                typeLabel: { value: 'software' },
              },
              {
                itemLabel: { value: 'Premiere Pro' },
                item: { value: 'http://wikidata.org/Q56789' },
                typeLabel: { value: 'software' },
              },
            ],
          },
        }),
      });

      const result = await extractProducts('Adobe', null, gpt, log);

      expect(result.products).to.have.length(3);
      expect(result.metadata.source).to.equal('wikidata');
    });

    it('returns empty when wikidata has no results', async () => {
      // Mock Wikidata ID search - no results
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [],
        }),
      });

      // LLM will be called for Wikipedia fallback
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [],
              services: [],
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractProducts('UnknownBrand', null, gpt, log);

      // Should not find products from Wikidata
      expect(result.metadata.brand_wikidata_id).to.be.null;
    });

    it('uses Wikipedia fallback when wikidata returns fewer than threshold', async () => {
      // Mock Wikidata ID search
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // Mock SPARQL query - returns only 1 product (below threshold of 3)
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              { itemLabel: { value: 'Product1' }, item: { value: 'http://wikidata.org/Q1' } },
            ],
          },
        }),
      });

      // Mock Wikipedia search for fallback
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve(['Brand', ['Brand Company'], [], []]),
      });

      // Mock Wikipedia content fetch
      fetchStub.onCall(3).resolves({
        ok: true,
        json: () => Promise.resolve({
          query: {
            pages: {
              12345: { extract: 'Company makes Product2 and Product3.' },
            },
          },
        }),
      });

      // Mock LLM response for Wikipedia extraction
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [{ name: 'Product2' }, { name: 'Product3' }],
              services: [],
              sub_brands: ['SubBrand1'],
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      expect(result.metadata.source).to.equal('hybrid');
      expect(result.products.length).to.be.greaterThan(1);
    });

    it('uses provided wikipediaSummary instead of fetching', async () => {
      // Mock Wikidata ID search - no results to trigger fallback
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      // Mock LLM response
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [{ name: 'ExtractedProduct' }],
              services: [],
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractProducts(
        'TestBrand',
        'Company makes ExtractedProduct.',
        gpt,
        log,
      );

      expect(result.metadata.source).to.equal('wikipedia_llm');
      expect(result.products).to.have.length(1);
    });

    it('handles SPARQL query failure gracefully', async () => {
      // Mock Wikidata ID search
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // Mock SPARQL query failure
      fetchStub.onSecondCall().resolves({
        ok: false,
        status: 500,
      });

      // Mock Wikipedia search for fallback
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve(['Brand', ['Brand'], [], []]),
      });

      fetchStub.onCall(3).resolves({
        ok: true,
        json: () => Promise.resolve({
          query: { pages: { 123: { extract: 'Company info' } } },
        }),
      });

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [{ name: 'FallbackProduct' }],
              services: [],
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      // Should still return result via fallback
      expect(result).to.have.property('products');
    });

    it('handles Wikipedia extraction error gracefully', async () => {
      // Mock Wikidata ID search - no results
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      // Mock LLM error
      gpt.fetchChatCompletion.rejects(new Error('LLM failed'));

      const result = await extractProducts('TestBrand', 'Some text', gpt, log);

      // Should return empty result without error
      expect(result.products).to.have.length(0);
    });

    it('handles LLM response with empty choices in Wikipedia extraction', async () => {
      // Mock Wikidata ID search - no results to trigger Wikipedia fallback
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      // Mock LLM returning empty choices (triggers '{}' fallback)
      gpt.fetchChatCompletion.resolves({
        choices: [],
      });

      const result = await extractProducts('TestBrand', 'Some Wikipedia text', gpt, log);

      // Should return empty arrays from the '{}' fallback
      expect(result.products).to.have.length(0);
      expect(result.services).to.have.length(0);
    });

    it('handles LLM response with null message content in Wikipedia extraction', async () => {
      // Mock Wikidata ID search - no results to trigger Wikipedia fallback
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      // Mock LLM returning null content (triggers '{}' fallback)
      gpt.fetchChatCompletion.resolves({
        choices: [{ message: { content: null } }],
      });

      const result = await extractProducts('TestBrand', 'Some Wikipedia text', gpt, log);

      // Should return empty arrays from the '{}' fallback
      expect(result.products).to.have.length(0);
    });

    it('handles LLM response with missing sub_brands in Wikipedia extraction', async () => {
      // Mock Wikidata ID search - no results to trigger Wikipedia fallback
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      // Mock LLM returning result without sub_brands (triggers '|| []' fallback)
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [{ name: 'Product1' }],
              services: [],
              // sub_brands is missing - should fallback to []
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractProducts('TestBrand', 'Some Wikipedia text', gpt, log);

      expect(result.products).to.have.length(1);
      expect(result.sub_brands).to.deep.equal([]);
    });

    it('handles null Wikipedia text in fallback', async () => {
      // Mock Wikidata ID search - no results
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      // Mock Wikipedia search - no results
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve(['Brand', [], [], []]),
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      // Should return empty result
      expect(result.products).to.have.length(0);
      expect(gpt.fetchChatCompletion).not.to.have.been.called;
    });

    it('skips Wikidata IDs that appear as labels', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // SPARQL returns item with Q-ID as label (should be filtered)
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              { itemLabel: { value: 'Q99999' }, item: { value: 'http://wikidata.org/Q99999' } },
              { itemLabel: { value: 'ValidProduct' }, item: { value: 'http://wikidata.org/Q1' } },
              { itemLabel: { value: 'ValidProduct' }, item: { value: 'http://wikidata.org/Q2' } },
              { itemLabel: { value: 'Product3' }, item: { value: 'http://wikidata.org/Q3' } },
            ],
          },
        }),
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      // Should filter out Q99999 and dedupe ValidProduct
      expect(result.products.find((p) => p.name === 'Q99999')).to.be.undefined;
    });

    it('truncates long Wikipedia text before LLM extraction', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [],
              services: [],
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      const longText = 'A'.repeat(10000);
      await extractProducts('TestBrand', longText, gpt, log);

      // LLM should have been called with truncated text
      expect(gpt.fetchChatCompletion).to.have.been.called;
    });

    it('merges results with overlapping products (deduplication)', async () => {
      // Mock Wikidata ID search
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // Mock SPARQL - returns 1 product (below threshold)
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              { itemLabel: { value: 'Product1' }, item: { value: 'http://wikidata.org/Q1' } },
            ],
          },
        }),
      });

      // Mock Wikipedia search for fallback
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve(['Brand', ['Brand'], [], []]),
      });

      fetchStub.onCall(3).resolves({
        ok: true,
        json: () => Promise.resolve({
          query: { pages: { 123: { extract: 'Company info' } } },
        }),
      });

      // LLM returns same product + additional ones
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [
                { name: 'Product1' }, // Duplicate
                { name: 'Product2' },
                { name: '' }, // Empty name - should be filtered
              ],
              services: [
                { name: 'Service1' },
                { name: '' }, // Empty name
              ],
              sub_brands: ['SubBrand1', 'SubBrand1'], // Duplicate
              discontinued: [
                { name: 'OldProduct' },
                { name: '' }, // Empty name
              ],
            }),
          },
        }],
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      // Product1 should not be duplicated
      const product1Count = result.products.filter((p) => p.name === 'Product1').length;
      expect(product1Count).to.equal(1);

      // Empty names should be filtered
      expect(result.products.find((p) => p.name === '')).to.be.undefined;
      expect(result.services.find((s) => s.name === '')).to.be.undefined;
    });

    it('merges results with missing properties in primary', async () => {
      // Mock Wikidata ID search
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // Mock SPARQL - returns empty results (below threshold)
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: { bindings: [] },
        }),
      });

      // Mock Wikipedia search for fallback
      fetchStub.onCall(2).resolves({
        ok: true,
        json: () => Promise.resolve(['Brand', ['Brand'], [], []]),
      });

      fetchStub.onCall(3).resolves({
        ok: true,
        json: () => Promise.resolve({
          query: { pages: { 123: { extract: 'Company info' } } },
        }),
      });

      // LLM returns products with items that have missing name property
      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [
                { category: 'Software' }, // No name
                { name: null, category: 'Software' }, // Null name
                { name: 'ValidProduct' },
              ],
              services: [
                { description: 'Service description' }, // No name
              ],
              sub_brands: ['Brand1'],
              discontinued: [
                { reason: 'obsolete' }, // No name
              ],
            }),
          },
        }],
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      // Products with missing/null names should be filtered out
      expect(result.products).to.have.length(1);
      expect(result.products[0].name).to.equal('ValidProduct');
    });

    it('handles wikidata returning discontinued products', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // SPARQL returns products with discontinuation dates
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              {
                itemLabel: { value: 'CurrentProduct' },
                item: { value: 'http://wikidata.org/Q1' },
                inception: { value: '2020-01-01T00:00:00Z' },
              },
              {
                itemLabel: { value: 'OldProduct' },
                item: { value: 'http://wikidata.org/Q2' },
                inception: { value: '1990-01-01T00:00:00Z' },
                discontinued: { value: '2010-01-01T00:00:00Z' },
              },
              {
                itemLabel: { value: 'Product3' },
                item: { value: 'http://wikidata.org/Q3' },
                typeLabel: { value: 'software_product' },
              },
            ],
          },
        }),
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      expect(result.products).to.have.length(3);
      const discontinued = result.products.find((p) => p.name === 'OldProduct');
      expect(discontinued.status).to.equal('discontinued');
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
    it('creates service with bound methods', () => {
      // Provide required env vars for Azure client
      const env = {
        AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_OPENAI_KEY: 'test-key',
        AZURE_API_VERSION: '2023-05-15',
        AZURE_COMPLETION_DEPLOYMENT: 'gpt-4',
      };
      const service = createProductExtractorService(env, log);

      expect(service).to.have.property('extractFromSitemap');
      expect(service).to.have.property('extractProducts');
      expect(service).to.have.property('formatProductsForPrompt');
    });

    it('service methods can be called', async () => {
      const env = {
        AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_OPENAI_KEY: 'test-key',
        AZURE_API_VERSION: '2023-05-15',
        AZURE_COMPLETION_DEPLOYMENT: 'gpt-4',
      };

      // Mock fetch for sitemap
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('<urlset></urlset>'),
      });

      const service = createProductExtractorService(env, log);

      // Call extractFromSitemap through service
      const result = await service.extractFromSitemap('https://example.com/sitemap.xml', 'Test');
      expect(result).to.have.property('metadata');
    });

    it('extractProducts service method can be called', async () => {
      const env = {
        AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
        AZURE_OPENAI_KEY: 'test-key',
        AZURE_API_VERSION: '2023-05-15',
        AZURE_COMPLETION_DEPLOYMENT: 'gpt-4',
      };

      // Mock Wikidata search - no results
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ search: [] }),
      });

      const service = createProductExtractorService(env, log);

      // Call extractProducts through service
      const result = await service.extractProducts('TestBrand', null);
      expect(result).to.have.property('metadata');
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

  describe('extractProducts date parsing', () => {
    it('handles date strings without T separator', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // SPARQL returns products with date in non-ISO format
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              {
                itemLabel: { value: 'Product1' },
                item: { value: 'http://wikidata.org/Q1' },
                inception: { value: '1995' }, // No T separator
              },
              {
                itemLabel: { value: 'Product2' },
                item: { value: 'http://wikidata.org/Q2' },
                inception: { value: '' }, // Empty
              },
              {
                itemLabel: { value: 'Product3' },
                item: { value: 'http://wikidata.org/Q3' },
                // No inception at all
              },
            ],
          },
        }),
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      expect(result.products).to.have.length(3);
      expect(result.products[0].inception_year).to.equal(1995);
    });

    it('handles non-string date values gracefully (error catch)', async () => {
      fetchStub.onFirstCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          search: [{ id: 'Q12345', description: 'company' }],
        }),
      });

      // SPARQL returns products with inception as a non-standard value
      // The .value is what the code extracts - simulating edge case where type is wrong
      fetchStub.onSecondCall().resolves({
        ok: true,
        json: () => Promise.resolve({
          results: {
            bindings: [
              {
                itemLabel: { value: 'Product1' },
                item: { value: 'http://wikidata.org/Q1' },
                inception: { value: '2020-05-15T00:00:00Z' }, // Normal date with T
              },
              {
                itemLabel: { value: 'Product2' },
                item: { value: 'http://wikidata.org/Q2' },
                // inception is completely missing (undefined)
              },
              {
                itemLabel: { value: 'Product3' },
                item: { value: 'http://wikidata.org/Q3' },
                inception: null, // inception object is null
              },
            ],
          },
        }),
      });

      const result = await extractProducts('TestBrand', null, gpt, log);

      expect(result.products).to.have.length(3);
      expect(result.products[0].inception_year).to.equal(2020);
      expect(result.products[1].inception_year).to.be.null;
      expect(result.products[2].inception_year).to.be.null;
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

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [{ name: 'Widget Pro' }],
              services: [],
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      // Should have called LLM with filtered URLs
      expect(gpt.fetchChatCompletion).to.have.been.called;
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

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: null, // Non-array
              services: 'not-an-array', // Non-array
              sub_brands: [],
              discontinued: undefined,
            }),
          },
        }],
      });

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

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [
                { name: 'Widget' },
                { name: 'widget' }, // Duplicate (case insensitive)
                { name: 'WIDGET' }, // Another duplicate
                { name: 'Other Product' },
              ],
              services: [
                { name: 'Service' },
                { name: 'service' }, // Duplicate
              ],
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      // Should deduplicate
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

      gpt.fetchChatCompletion.resolves({
        choices: [{
          message: {
            content: JSON.stringify({
              products: [
                { name: '' }, // Empty name
                { name: 'Valid Product' },
                { name: null }, // Null name
              ],
              services: [{ name: '' }], // Empty name
              sub_brands: [],
              discontinued: [],
            }),
          },
        }],
      });

      const result = await extractFromSitemap(
        'https://example.com/sitemap.xml',
        'Example Corp',
        gpt,
        log,
      );

      // Should filter out empty names
      expect(result.products).to.have.length(1);
      expect(result.products[0].name).to.equal('Valid Product');
      expect(result.services).to.have.length(0);
    });
  });
});
