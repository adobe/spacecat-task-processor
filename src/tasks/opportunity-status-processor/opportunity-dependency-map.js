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
 * Dependencies can be data sources (RUM, AHREFS, GSC) or services (top-pages, scraping)
 *
 * Key: Opportunity type
 * Value: Array of required dependencies for this opportunity to be generated
 */
export const OPPORTUNITY_DEPENDENCY_MAP = {
  cwv: ['RUM'],
  'high-organic-low-ctr': ['RUM'],
  'broken-internal-links': ['RUM', 'top-pages'],
  'meta-tags': ['top-pages'],
  'broken-backlinks': ['top-pages'],
};

/**
 * Dependency type mappings
 * Maps dependency names to their corresponding service check results
 */
export const DEPENDENCY_SERVICE_MAP = {
  RUM: 'rum',
  AHREFS: 'ahrefs',
  GSC: 'gsc',
  'top-pages': 'import',
  scraping: 'scraping',
};

/**
 * Gets all dependencies for a given opportunity type
 * @param {string} opportunityType - The opportunity type
 * @returns {Array<string>} Array of dependency names, or empty array if no dependencies
 */
export function getDependenciesForOpportunity(opportunityType) {
  return OPPORTUNITY_DEPENDENCY_MAP[opportunityType] || [];
}

/**
 * Checks if all dependencies are met for a given opportunity type
 * @param {string} opportunityType - The opportunity type
 * @param {object} serviceStatus - Object with service statuses (rum, ahrefs, gsc, import, scraping)
 * @returns {boolean} True if all dependencies are met, false otherwise
 */
export function areDependenciesMet(opportunityType, serviceStatus) {
  const dependencies = getDependenciesForOpportunity(opportunityType);

  // If no dependencies defined, assume they are met
  if (dependencies.length === 0) {
    return true;
  }

  // Check if all dependencies are available
  return dependencies.every((dependency) => {
    const serviceName = DEPENDENCY_SERVICE_MAP[dependency];
    return serviceName && serviceStatus[serviceName] === true;
  });
}

/**
 * Gets all opportunity types that have unmet dependencies
 * @param {Array<string>} opportunityTypes - Array of opportunity types to check
 * @param {object} serviceStatus - Object with service statuses
 * @returns {Array<{opportunity: string, missingDependencies: Array<string>}>}
 *   Array of opportunities with unmet dependencies
 */
export function getOpportunitiesWithUnmetDependencies(opportunityTypes, serviceStatus) {
  return opportunityTypes
    .map((opportunityType) => {
      const dependencies = getDependenciesForOpportunity(opportunityType);
      const missingDependencies = dependencies.filter((dependency) => {
        const serviceName = DEPENDENCY_SERVICE_MAP[dependency];
        return !serviceName || serviceStatus[serviceName] !== true;
      });

      return {
        opportunity: opportunityType,
        dependencies,
        missingDependencies,
      };
    })
    .filter((item) => item.missingDependencies.length > 0);
}
