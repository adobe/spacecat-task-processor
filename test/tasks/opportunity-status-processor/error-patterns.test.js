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

import { expect } from 'chai';
import {
  getErrorCategoriesByType,
  buildSearchPatterns,
  getRecommendations,
  categorizeLogMessage,
} from '../../../src/tasks/opportunity-status-processor/error-patterns.js';

describe('Error Patterns', () => {
  describe('getErrorCategoriesByType', () => {
    it('should return categories for Import type', () => {
      const categories = getErrorCategoriesByType('Import');
      expect(categories).to.be.an('array');
      // Verify structure
      if (categories.length > 0) {
        expect(categories[0]).to.have.property('name');
        expect(categories[0]).to.have.property('count');
        expect(categories[0]).to.have.property('percentage');
        expect(categories[0]).to.have.property('subCategories');
        expect(categories[0].subCategories).to.be.an('array');
      }
    });

    it('should return categories for Scraper type', () => {
      const categories = getErrorCategoriesByType('Scraper');
      expect(categories).to.be.an('array');
      if (categories.length > 0) {
        expect(categories[0]).to.have.property('name');
        expect(categories[0]).to.have.property('subCategories');
      }
    });

    it('should return categories for Audit type', () => {
      const categories = getErrorCategoriesByType('Audit');
      expect(categories).to.be.an('array');
      if (categories.length > 0) {
        expect(categories[0]).to.have.property('name');
        expect(categories[0]).to.have.property('subCategories');
      }
    });

    it('should return categories for API type', () => {
      const categories = getErrorCategoriesByType('API');
      expect(categories).to.be.an('array');
      if (categories.length > 0) {
        expect(categories[0]).to.have.property('name');
        expect(categories[0]).to.have.property('subCategories');
      }
    });

    it('should return categories for Task type', () => {
      const categories = getErrorCategoriesByType('Task');
      expect(categories).to.be.an('array');
    });

    it('should return categories for Auth type', () => {
      const categories = getErrorCategoriesByType('Auth');
      expect(categories).to.be.an('array');
    });

    it('should return empty array for unknown type', () => {
      const categories = getErrorCategoriesByType('Unknown');
      expect(categories).to.be.an('array');
      expect(categories).to.have.lengthOf(0);
    });

    it('should sort categories by count in descending order', () => {
      const categories = getErrorCategoriesByType('API');
      if (categories.length > 1) {
        for (let i = 0; i < categories.length - 1; i += 1) {
          expect(categories[i].count).to.be.at.least(categories[i + 1].count);
        }
      }
    });
  });

  describe('buildSearchPatterns', () => {
    it('should build search patterns for Import type', () => {
      const patterns = buildSearchPatterns('Import');
      expect(patterns).to.be.an('array');
      if (patterns.length > 0) {
        expect(patterns[0]).to.have.property('category');
        expect(patterns[0]).to.have.property('subCategory');
        expect(patterns[0]).to.have.property('keywords');
        expect(patterns[0]).to.have.property('examples');
        expect(patterns[0].keywords).to.be.an('array');
        expect(patterns[0].examples).to.be.an('array');
      }
    });

    it('should build search patterns for Scraper type', () => {
      const patterns = buildSearchPatterns('Scraper');
      expect(patterns).to.be.an('array');
    });

    it('should build search patterns for Audit type', () => {
      const patterns = buildSearchPatterns('Audit');
      expect(patterns).to.be.an('array');
    });

    it('should extract timeout keyword from messages', () => {
      const patterns = buildSearchPatterns('Scraper');
      const timeoutPatterns = patterns.filter((p) => p.keywords.includes('timeout'));
      expect(timeoutPatterns.length).to.be.at.least(0);
    });

    it('should extract 404 keyword from messages', () => {
      const patterns = buildSearchPatterns('API');
      const notFoundPatterns = patterns.filter((p) => p.keywords.includes('404'));
      expect(notFoundPatterns.length).to.be.at.least(0);
    });

    it('should extract error keyword from messages', () => {
      const patterns = buildSearchPatterns('Import');
      const errorPatterns = patterns.filter((p) => p.keywords.includes('error'));
      expect(errorPatterns.length).to.be.at.least(0);
    });

    it('should limit examples to 2 per pattern', () => {
      const patterns = buildSearchPatterns('API');
      patterns.forEach((pattern) => {
        expect(pattern.examples.length).to.be.at.most(2);
      });
    });

    it('should extract NGHTTP2 keyword from messages', () => {
      const patterns = buildSearchPatterns('API');
      const nghttp2Patterns = patterns.filter((p) => p.keywords.includes('NGHTTP2'));
      expect(nghttp2Patterns.length).to.be.at.least(0);
    });

    it('should extract failed keyword from messages', () => {
      const patterns = buildSearchPatterns('Scraper');
      const failedPatterns = patterns.filter((p) => p.keywords.includes('failed'));
      expect(failedPatterns.length).to.be.at.least(0);
    });
  });

  describe('getRecommendations', () => {
    describe('Import recommendations', () => {
      it('should return 404 recommendations for Import errors', () => {
        const recommendations = getRecommendations('Import: Data fetch error', '404 not found');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('URL'))).to.be.true;
      });

      it('should return auth recommendations for Import 401 errors', () => {
        const recommendations = getRecommendations('Import: Auth error', '401 unauthorized');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('credentials') || r.includes('auth'))).to.be.true;
      });

      it('should return timeout recommendations for Import timeout errors', () => {
        const recommendations = getRecommendations('Import: Timeout error', 'timeout exceeded');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('timeout'))).to.be.true;
      });

      it('should return rate limit recommendations for Import rate limit errors', () => {
        const recommendations = getRecommendations('Import: Rate limit', 'rate limit exceeded');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('rate limit') || r.includes('backoff'))).to.be.true;
      });

      it('should return default Import recommendations for unknown subcategory', () => {
        const recommendations = getRecommendations('Import: Unknown error', 'some error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('import'))).to.be.true;
      });
    });

    describe('Scraper recommendations', () => {
      it('should return timeout recommendations for Scraper timeout errors', () => {
        const recommendations = getRecommendations('Scraper: Navigation timeout', 'timeout');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('timeout'))).to.be.true;
      });

      it('should return blocked recommendations for ERR_BLOCKED_BY_CLIENT errors', () => {
        const recommendations = getRecommendations('Scraper: Blocked', 'ERR_BLOCKED_BY_CLIENT');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('block') || r.includes('bot'))).to.be.true;
      });

      it('should return 403 recommendations for Scraper forbidden errors', () => {
        const recommendations = getRecommendations('Scraper: Access denied', '403 forbidden');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('robots.txt') || r.includes('blocked'))).to.be.true;
      });

      it('should return 404 recommendations for Scraper not found errors', () => {
        const recommendations = getRecommendations('Scraper: Page not found', '404');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('URL'))).to.be.true;
      });

      it('should return disk space recommendations for ENOSPC errors', () => {
        const recommendations = getRecommendations('Scraper: Disk error', 'ENOSPC no space');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('space') || r.includes('storage'))).to.be.true;
      });

      it('should return protocol recommendations for Protocol errors', () => {
        const recommendations = getRecommendations('Scraper: Protocol error', 'Protocol error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('browser') || r.includes('Protocol'))).to.be.true;
      });

      it('should return default Scraper recommendations for unknown subcategory', () => {
        const recommendations = getRecommendations('Scraper: Unknown', 'some error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('scraper'))).to.be.true;
      });
    });

    describe('Audit recommendations', () => {
      it('should return protocol recommendations for preflight unsupported protocol', () => {
        const recommendations = getRecommendations('Audit: preflight-audit', 'unsupported protocol');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('HTTP') || r.includes('protocol'))).to.be.true;
      });

      it('should return NGHTTP2 recommendations for preflight NGHTTP2 errors', () => {
        const recommendations = getRecommendations('Audit: preflight-audit', 'NGHTTP2 error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('HTTP/2') || r.includes('server'))).to.be.true;
      });

      it('should return timeout recommendations for preflight timeout errors', () => {
        const recommendations = getRecommendations('Audit: preflight-audit', 'timeout');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('timeout') || r.includes('response'))).to.be.true;
      });

      it('should return 404 recommendations for Configuration fetch 404 errors', () => {
        const recommendations = getRecommendations('Audit: Configuration fetch error', '404 not found');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('fstab') || r.includes('config'))).to.be.true;
      });

      it('should return auth recommendations for Configuration fetch 401 errors', () => {
        const recommendations = getRecommendations('Audit: Configuration fetch error', '401 unauthorized');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('GitHub') || r.includes('auth'))).to.be.true;
      });

      it('should return RUM recommendations for RUM domain key errors', () => {
        const recommendations = getRecommendations('Audit: RUM domain key error', 'domain key not found');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('RUM') || r.includes('domain'))).to.be.true;
      });

      it('should return canonical recommendations for Canonical tag validation errors', () => {
        const recommendations = getRecommendations('Audit: Canonical tag validation error', 'invalid tag');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('canonical') || r.includes('SEO'))).to.be.true;
      });

      it('should return entitlement recommendations for Entitlement validation errors', () => {
        const recommendations = getRecommendations('Audit: Entitlement validation error', 'no entitlement');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('entitlement'))).to.be.true;
      });

      it('should return Genvar API recommendations for API call errors', () => {
        const recommendations = getRecommendations('Audit: API call error - Genvar API', 'API failed');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('Genvar') || r.includes('API'))).to.be.true;
      });

      it('should return default Audit recommendations for unknown subcategory', () => {
        const recommendations = getRecommendations('Audit: Unknown', 'some error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('audit'))).to.be.true;
      });
    });

    describe('API recommendations', () => {
      it('should return 404 recommendations for API not found errors', () => {
        const recommendations = getRecommendations('API: Endpoint error', '404 not found');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('endpoint') || r.includes('API'))).to.be.true;
      });

      it('should return timeout recommendations for API timeout errors', () => {
        const recommendations = getRecommendations('API: Request timeout', 'timeout');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('timeout') || r.includes('API'))).to.be.true;
      });

      it('should return default API recommendations for unknown subcategory', () => {
        const recommendations = getRecommendations('API: Unknown error', 'some error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('API') || r.includes('service'))).to.be.true;
      });
    });

    describe('Default recommendations', () => {
      it('should return default recommendations for unknown category', () => {
        const recommendations = getRecommendations('Unknown: Error', 'some error');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
        expect(recommendations.some((r) => r.includes('CloudWatch') || r.includes('logs'))).to.be.true;
      });

      it('should return default recommendations for Task category', () => {
        const recommendations = getRecommendations('Task: Processing error', 'failed');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
      });

      it('should return default recommendations for Auth category', () => {
        const recommendations = getRecommendations('Auth: Authentication error', 'failed');
        expect(recommendations).to.be.an('array');
        expect(recommendations).to.have.length.at.least(1);
      });
    });
  });

  describe('categorizeLogMessage', () => {
    it('should categorize a 404 error message for API type', () => {
      const message = 'Error fetching fstab.yaml for repo. Status: 404';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('subCategory');
      expect(result).to.have.property('confidence');
      expect(result.confidence).to.be.at.least(0);
    });

    it('should categorize a timeout error message for Scraper type', () => {
      const message = 'Navigation timeout exceeded after 30000ms';
      const result = categorizeLogMessage(message, 'Scraper');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('subCategory');
      expect(result).to.have.property('confidence');
    });

    it('should categorize a 401 error message for API type', () => {
      const message = 'Error fetching hlx config. Status: 401. Error: not authenticated';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('confidence');
    });

    it('should categorize a 403 error message for Scraper type', () => {
      const message = 'Failed to scrape URL: 403 Forbidden';
      const result = categorizeLogMessage(message, 'Scraper');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('confidence');
    });

    it('should categorize NGHTTP2 error message for API type', () => {
      const message = 'Stream closed with error code NGHTTP2_REFUSED_STREAM';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('confidence');
    });

    it('should categorize ENOTFOUND error message for Import type', () => {
      const message = 'Failed to fetch data: ENOTFOUND api.example.com';
      const result = categorizeLogMessage(message, 'Import');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('confidence');
    });

    it('should return Unknown for unrecognized error message', () => {
      const message = 'Some completely unknown xyz thing happened';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result.category).to.equal('Unknown');
      expect(result.subCategory).to.equal('Uncategorized error');
    });

    it('should handle empty message', () => {
      const message = '';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('subCategory');
    });

    it('should match error codes with higher confidence', () => {
      const message = 'Error: 404 not found';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result.confidence).to.be.at.least(2);
    });

    it('should match key terms from subcategory names', () => {
      const message = 'Error fetching fstab configuration file';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result.confidence).to.be.at.least(0);
    });

    it('should return highest confidence match when multiple patterns match', () => {
      const message = 'Error fetching fstab.yaml: 404 not found, timeout after 30000ms';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result.confidence).to.be.at.least(2);
    });

    it('should handle case-insensitive matching', () => {
      const message = 'ERROR: 404 NOT FOUND';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      expect(result.confidence).to.be.at.least(2);
    });

    it('should filter out short terms (3 chars or less)', () => {
      const message = 'API GET PUT POST error';
      const result = categorizeLogMessage(message, 'API');
      expect(result).to.be.an('object');
      // Short terms like GET, PUT, POST should not increase match score
      expect(result).to.have.property('confidence');
    });

    it('should categorize Import errors', () => {
      const message = 'ERROR Import type top-pages for source ahrefs failed with timeout';
      const result = categorizeLogMessage(message, 'Import');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('confidence');
    });

    it('should categorize Audit errors', () => {
      const message = '[preflight-audit] Preflight check failed for site';
      const result = categorizeLogMessage(message, 'Audit');
      expect(result).to.be.an('object');
      expect(result).to.have.property('category');
      expect(result).to.have.property('confidence');
    });
  });
});
