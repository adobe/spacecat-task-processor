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
  });
});
