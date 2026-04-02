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

/**
 * Maps opportunity types to their required dependencies
 * Dependencies can be data sources (RUM, SEOImport, GSC, scraping)
 *
 * Key: Opportunity type
 * Value: Array of required dependencies for this opportunity to be generated
 */
export const OPPORTUNITY_DEPENDENCY_MAP = {
  cwv: ['RUM'],
  'high-organic-low-ctr': ['RUM'],
  'broken-internal-links': ['RUM', 'SEOImport'],
  'meta-tags': ['SEOImport', 'scraping'], // meta-tags audit uses scraping
  'broken-backlinks': ['SEOImport', 'scraping'], // broken-backlinks audit uses scraping
  'alt-text': ['SEOImport', 'scraping'], // alt-text audit uses scraping
  'form-accessibility': ['RUM', 'scraping'], // forms audit uses scraping
  'forms-opportunities': ['RUM', 'scraping'], // forms audit uses scraping
};

/**
 * Gets all dependencies for a given opportunity type
 * @param {string} opportunityType - The opportunity type
 * @returns {Array<string>} Array of dependency names, or empty array if no dependencies
 */
export function getDependenciesForOpportunity(opportunityType) {
  return OPPORTUNITY_DEPENDENCY_MAP[opportunityType] || [];
}
