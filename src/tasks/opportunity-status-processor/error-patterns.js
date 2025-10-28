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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// eslint-disable-next-line no-underscore-dangle
const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(__filename);

// Load error categories from JSON file
let errorCategories = null;

function loadErrorCategories() {
  if (!errorCategories) {
    const errorCategoriesPath = path.resolve(__dirname, '../../../static/errors/ALL-ERRORS-CATEGORIZED.json');
    const rawData = fs.readFileSync(errorCategoriesPath, 'utf8');
    errorCategories = JSON.parse(rawData);
  }
  return errorCategories;
}

/**
 * Get error categories by main type
 * @param {string} mainType - The main type (Import, Scraper, Audit, API, Task, Auth, etc.)
 * @returns {Array} Array of error categories for the given type
 */
export function getErrorCategoriesByType(mainType) {
  const data = loadErrorCategories();
  const categories = [];

  Object.entries(data.categories).forEach(([categoryName, categoryData]) => {
    if (categoryData.mainType === mainType) {
      categories.push({
        name: categoryName,
        count: categoryData.count,
        percentage: categoryData.percentage,
        subCategories: Object.entries(categoryData.subCategories).map(([subName, subData]) => ({
          name: subName,
          count: subData.count,
          examples: subData.examples,
        })),
      });
    }
  });

  return categories.sort((a, b) => b.count - a.count);
}

/**
 * Build search patterns for CloudWatch log searches
 * @param {string} mainType - The main type (Import, Scraper, Audit)
 * @returns {Array} Array of search patterns with keywords
 */
export function buildSearchPatterns(mainType) {
  const categories = getErrorCategoriesByType(mainType);
  const patterns = [];

  categories.forEach((category) => {
    category.subCategories.forEach((subCategory) => {
      // Extract key error patterns from examples
      const errorKeywords = new Set();

      subCategory.examples.forEach((example) => {
        const message = example.message.toLowerCase();

        // Extract meaningful error keywords
        if (message.includes('timeout')) errorKeywords.add('timeout');
        if (message.includes('timed out')) errorKeywords.add('timed out');
        if (message.includes('403')) errorKeywords.add('403');
        if (message.includes('404')) errorKeywords.add('404');
        if (message.includes('401')) errorKeywords.add('401');
        if (message.includes('enotfound')) errorKeywords.add('ENOTFOUND');
        if (message.includes('etimedout')) errorKeywords.add('ETIMEDOUT');
        if (message.includes('econnrefused')) errorKeywords.add('ECONNREFUSED');
        if (message.includes('nghttp2')) errorKeywords.add('NGHTTP2');
        if (message.includes('net::err')) errorKeywords.add('net::ERR');
        if (message.includes('failed')) errorKeywords.add('failed');
        if (message.includes('error')) errorKeywords.add('error');
      });

      if (errorKeywords.size > 0) {
        patterns.push({
          category: category.name,
          subCategory: subCategory.name,
          keywords: Array.from(errorKeywords),
          examples: subCategory.examples.slice(0, 2), // Keep up to 2 examples for reference
        });
      }
    });
  });

  return patterns;
}

/**
 * Get recommendations based on error category and subcategory
 * @param {string} category - The error category
 * @param {string} subCategory - The error subcategory
 * @returns {Array<string>} Array of recommendations
 */
export function getRecommendations(category, subCategory) {
  const recommendations = [];

  // Import-specific recommendations
  if (category.startsWith('Import:')) {
    if (subCategory.includes('404') || subCategory.includes('not found')) {
      recommendations.push('Verify the data source URL is correct and accessible');
      recommendations.push('Check if the resource has been moved or deleted');
      recommendations.push('Review data source configuration');
    } else if (subCategory.includes('401') || subCategory.includes('auth')) {
      recommendations.push('Verify API credentials and tokens');
      recommendations.push('Check if authentication has expired');
      recommendations.push('Update API keys in configuration');
    } else if (subCategory.includes('timeout')) {
      recommendations.push('Increase timeout configuration for data imports');
      recommendations.push('Check network connectivity to data source');
      recommendations.push('Verify data source is responding within expected time');
    } else if (subCategory.includes('rate limit')) {
      recommendations.push('Implement exponential backoff for retries');
      recommendations.push('Reduce import frequency');
      recommendations.push('Contact data source provider for rate limit increase');
    } else {
      recommendations.push('Review import logs for detailed error messages');
      recommendations.push('Verify data source configuration');
      recommendations.push('Check data source availability and status');
    }
  } else if (category.startsWith('Scraper:')) {
    // Scraper-specific recommendations
    if (subCategory.includes('timeout') || subCategory.includes('timed out')) {
      recommendations.push('Check target website response times');
      recommendations.push('Consider increasing scraper timeout configuration');
      recommendations.push('Verify network connectivity to target site');
    } else if (subCategory.includes('ERR_BLOCKED_BY_CLIENT') || subCategory.includes('blocked')) {
      recommendations.push('Disable ad blockers or content blocking extensions');
      recommendations.push('Review scraper user agent configuration');
      recommendations.push('Check if site has anti-bot protection');
    } else if (subCategory.includes('403') || subCategory.includes('forbidden')) {
      recommendations.push('Verify site allows automated crawling (check robots.txt)');
      recommendations.push('Check if IP is blocked or rate limited');
      recommendations.push('Review authentication requirements');
    } else if (subCategory.includes('404')) {
      recommendations.push('Verify the URL exists and is accessible');
      recommendations.push('Check for URL changes or redirects');
      recommendations.push('Update site configuration if URL has changed');
    } else if (subCategory.includes('ENOSPC') || subCategory.includes('space')) {
      recommendations.push('Clear temporary storage and caches');
      recommendations.push('Increase available disk space');
      recommendations.push('Review log rotation policies');
    } else if (subCategory.includes('Protocol error')) {
      recommendations.push('Check browser compatibility settings');
      recommendations.push('Verify Puppeteer/browser version');
      recommendations.push('Review network protocol configuration');
    } else {
      recommendations.push('Review scraper logs for detailed error traces');
      recommendations.push('Check target site availability');
      recommendations.push('Verify scraper configuration');
    }
  } else if (category.startsWith('Audit:')) {
    // Audit-specific recommendations
    if (category.includes('preflight')) {
      if (subCategory.includes('unsupported protocol')) {
        recommendations.push('Verify site URL uses HTTP or HTTPS protocol');
        recommendations.push('Check for URL typos or malformed URLs');
        recommendations.push('Update site configuration with correct protocol');
      } else if (subCategory.includes('NGHTTP2')) {
        recommendations.push('Check server HTTP/2 configuration');
        recommendations.push('Verify network connectivity');
        recommendations.push('Contact site infrastructure team');
      } else if (subCategory.includes('timeout')) {
        recommendations.push('Check site server response times');
        recommendations.push('Verify site is accessible from audit infrastructure');
        recommendations.push('Consider increasing preflight timeout');
      }
    } else if (category.includes('Configuration fetch error')) {
      if (subCategory.includes('404')) {
        recommendations.push('Verify fstab.yaml or hlx config exists in repository');
        recommendations.push('Check repository and branch names are correct');
        recommendations.push('Ensure configuration files are properly committed');
      } else if (subCategory.includes('401')) {
        recommendations.push('Verify GitHub authentication credentials');
        recommendations.push('Check repository access permissions');
        recommendations.push('Update GitHub tokens if expired');
      }
    } else if (category.includes('RUM domain key error')) {
      recommendations.push('Verify RUM is configured for the domain');
      recommendations.push('Check domain key exists in RUM system');
      recommendations.push('Contact RUM team for domain configuration');
    } else if (category.includes('Canonical tag validation error')) {
      recommendations.push('Verify site has proper canonical tags');
      recommendations.push('Check for canonical tag syntax errors');
      recommendations.push('Review SEO configuration');
    } else if (category.includes('Entitlement validation error')) {
      recommendations.push('Verify site has valid entitlements');
      recommendations.push('Check entitlement configuration');
      recommendations.push('Contact account team for entitlement issues');
    } else if (category.includes('API call error - Genvar API')) {
      recommendations.push('Check Genvar API service status');
      recommendations.push('Verify API credentials and configuration');
      recommendations.push('Review Genvar API logs for errors');
    } else {
      recommendations.push('Review audit logs for specific error details');
      recommendations.push('Check audit configuration and prerequisites');
      recommendations.push('Verify site meets audit requirements');
    }
  } else if (category.startsWith('API:')) {
    // API-specific recommendations
    if (subCategory.includes('404') || subCategory.includes('not found')) {
      recommendations.push('Verify API endpoint URL is correct');
      recommendations.push('Check if endpoint exists and is accessible');
      recommendations.push('Review API documentation for changes');
    } else if (subCategory.includes('timeout')) {
      recommendations.push('Check API server response times');
      recommendations.push('Increase API timeout configuration');
      recommendations.push('Verify network connectivity to API');
    } else {
      recommendations.push('Review API service logs');
      recommendations.push('Check API service health and status');
      recommendations.push('Verify API configuration');
    }
  }

  // Default recommendations if none matched
  if (recommendations.length === 0) {
    recommendations.push('Review CloudWatch logs for detailed error information');
    recommendations.push('Check service configuration and health');
    recommendations.push('Contact support team if issue persists');
  }

  return recommendations;
}

/**
 * Categorize a log message based on error patterns
 * @param {string} message - The log message to categorize
 * @param {string} mainType - The main type context (Import, Scraper, Audit)
 * @returns {object} Object with category, subCategory, and confidence
 */
export function categorizeLogMessage(message, mainType) {
  const categories = getErrorCategoriesByType(mainType);
  const messageLower = message.toLowerCase();

  let bestMatch = {
    category: 'Unknown',
    subCategory: 'Uncategorized error',
    confidence: 0,
  };

  categories.forEach((category) => {
    category.subCategories.forEach((subCategory) => {
      let matchScore = 0;

      // Check examples for similarity
      subCategory.examples.forEach((example) => {
        const exampleLower = example.message.toLowerCase();

        // Extract key terms and check for matches
        const keyTerms = subCategory.name.toLowerCase().split(/[\s:()]+/);
        keyTerms.forEach((term) => {
          if (term.length > 3 && messageLower.includes(term)) {
            matchScore += 1;
          }
        });

        // Check for specific error codes/patterns
        if (exampleLower.includes('404') && messageLower.includes('404')) matchScore += 2;
        if (exampleLower.includes('403') && messageLower.includes('403')) matchScore += 2;
        if (exampleLower.includes('401') && messageLower.includes('401')) matchScore += 2;
        if (exampleLower.includes('timeout') && messageLower.includes('timeout')) matchScore += 2;
        if (exampleLower.includes('nghttp2') && messageLower.includes('nghttp2')) matchScore += 2;
        if (exampleLower.includes('enotfound') && messageLower.includes('enotfound')) matchScore += 2;
      });

      if (matchScore > bestMatch.confidence) {
        bestMatch = {
          category: category.name,
          subCategory: subCategory.name,
          confidence: matchScore,
        };
      }
    });
  });

  return bestMatch;
}

export default {
  getErrorCategoriesByType,
  buildSearchPatterns,
  getRecommendations,
  categorizeLogMessage,
};
