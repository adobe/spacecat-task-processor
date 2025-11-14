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
 * Maps audit types to their corresponding opportunity types
 * This represents the superset of opportunities that can be generated from each audit
 *
 * Key: Audit type
 * Value: Array of opportunity types that can be generated from this audit
 */
export const AUDIT_OPPORTUNITY_MAP = {
  cwv: ['cwv'],
  'forms-opportunities': ['form-accessibility', 'forms-opportunities'],
  'meta-tags': ['meta-tags'],
  'experimentation-opportunities': ['high-organic-low-ctr'],
  'broken-backlinks': ['broken-backlinks'],
  'broken-internal-links': ['broken-internal-links'],
  sitemap: ['sitemap'],
  'alt-text': ['alt-text'],
  accessibility: ['accessibility'],
};

/**
 * Gets all opportunity types for a given audit type
 * @param {string} auditType - The audit type
 * @returns {Array<string>} Array of opportunity types, or empty array if audit type not found
 */
export function getOpportunitiesForAudit(auditType) {
  return AUDIT_OPPORTUNITY_MAP[auditType] || [];
}

/**
 * Gets all audit types that can generate a specific opportunity type
 * @param {string} opportunityType - The opportunity type
 * @returns {Array<string>} Array of audit types that can generate this opportunity
 */
export function getAuditsForOpportunity(opportunityType) {
  return Object.entries(AUDIT_OPPORTUNITY_MAP)
    .filter(([, opportunities]) => opportunities.includes(opportunityType))
    .map(([auditType]) => auditType);
}

/**
 * Gets all unique opportunity types across all audits
 * @returns {Array<string>} Array of all unique opportunity types
 */
export function getAllOpportunityTypes() {
  const allOpportunities = Object.values(AUDIT_OPPORTUNITY_MAP).flat();
  return [...new Set(allOpportunities)];
}

/**
 * Gets all audit types defined in the map
 * @returns {Array<string>} Array of all audit types
 */
export function getAllAuditTypes() {
  return Object.keys(AUDIT_OPPORTUNITY_MAP);
}
