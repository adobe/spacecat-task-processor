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

import { isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import { readFileSync } from 'fs';
import path from 'path';

const TASK_TYPE = 'cwv-demo-suggestions-processor';
const LCP = 'lcp';
const CLS = 'cls';
const INP = 'inp';
const DEMO = 'demo';
const STATIC_DIR = 'static';
const CWV_SUGGESTIONS_FILE_NAME = 'aem-best-practices.json';
const MAX_CWV_DEMO_SUGGESTIONS = 2;

const CWV_SUGGESTIONS_FILE_PATH = path.resolve(
  process.cwd(),
  STATIC_DIR,
  CWV_SUGGESTIONS_FILE_NAME,
);

let cwvReferenceSuggestions = {};
try {
  const jsonContent = readFileSync(CWV_SUGGESTIONS_FILE_PATH, 'utf8');
  cwvReferenceSuggestions = JSON.parse(jsonContent);
} catch {
  // Fallback to empty object if file loading fails - already initialized above
}

/**
 * CWV thresholds for determining if metrics have issues
 */
const CWV_THRESHOLDS = {
  lcp: 2500, // 2.5 seconds
  cls: 0.1, // 0.1
  inp: 200, // 200 milliseconds
};

/**
 * Gets metric issues based on CWV thresholds
 * @param {object} metrics - The metrics object
 * @returns {Array} Array of issue types
 */
function getMetricIssues(metrics) {
  const issues = [];

  if (metrics.lcp && metrics.lcp > CWV_THRESHOLDS[LCP]) {
    issues.push(LCP);
  }

  if (metrics.cls && metrics.cls > CWV_THRESHOLDS[CLS]) {
    issues.push(CLS);
  }

  if (metrics.inp && metrics.inp > CWV_THRESHOLDS[INP]) {
    issues.push(INP);
  }

  return issues;
}

/**
 * Checks if a suggestion has existing issues
 * @param {object} suggestion - The suggestion object
 * @returns {boolean} True if suggestion has existing issues
 */
function hasExistingIssues(suggestion) {
  const data = suggestion.getData();
  return data.issues && isNonEmptyArray(data.issues);
}

/**
 * Gets a random suggestion from the available suggestions for a given issue type
 * @param {string} issueType - The type of issue (lcp, cls, inp)
 * @returns {string|null} A random suggestion or null if none available
 */
function getRandomSuggestion(issueType) {
  const suggestions = cwvReferenceSuggestions[issueType];
  if (!suggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * suggestions.length);
  return suggestions[randomIndex];
}

/**
 * Updates a suggestion with generic CWV issues
 * @param {object} suggestion - The suggestion object
 * @param {Array} metricIssues - Array of metric issue types
 * @param {object} Suggestion - The Suggestion data access object
 * @param {object} logger - The logger object
 */
async function updateSuggestionWithGenericIssues(suggestion, metricIssues, Suggestion, logger) {
  try {
    const suggestionId = suggestion.getId();

    const suggestionToUpdate = await Suggestion.findById(suggestionId);
    if (!suggestionToUpdate) {
      logger.warn(`Suggestion ${suggestionId} not found, skipping update`);
      return;
    }

    const data = suggestionToUpdate.getData();

    if (!data.issues) {
      data.issues = [];
    }

    for (const issueType of metricIssues) {
      const randomSuggestion = getRandomSuggestion(issueType);
      if (randomSuggestion) {
        const genericIssue = {
          type: issueType,
          value: randomSuggestion,
        };
        data.issues.push(genericIssue);
      }
    }

    data.genericSuggestions = true;

    suggestionToUpdate.setData(data);
    suggestionToUpdate.setUpdatedBy('system');
    await suggestionToUpdate.save();

    logger.info(`Updated suggestion ${suggestionId} with generic CWV issues: ${metricIssues.join(', ')}`);
  } catch (error) {
    logger.error(`Error updating suggestion ${suggestion.getId()} with generic issues:`, error);
  }
}

/**
 * Processes a single opportunity
 * @param {object} opportunity - The opportunity object
 * @param {object} Suggestion - The Suggestion data access object
 * @param {object} logger - The logger object
 * @returns {number} Number of suggestions updated
 */
async function processCWVOpportunity(opportunity, Suggestion, logger) {
  try {
    const suggestions = await opportunity.getSuggestions();

    const hasSuggestionsWithIssues = suggestions.some(hasExistingIssues);

    if (hasSuggestionsWithIssues) {
      logger.info(`Opportunity ${opportunity.getId()} already has suggestions with issues, skipping generic suggestions`);
      return 0;
    }

    // Sort suggestions by pageviews (descending)
    const sortedSuggestions = suggestions
      .filter((suggestion) => {
        const data = suggestion.getData();
        return data.pageviews && data.pageviews > 0;
      })
      .sort((a, b) => b.getData().pageviews - a.getData().pageviews);

    // Find first 2 suggestions with CWV issues
    const suggestionsToUpdate = [];

    for (const suggestion of sortedSuggestions) {
      if (suggestionsToUpdate.length >= MAX_CWV_DEMO_SUGGESTIONS) break;

      const data = suggestion.getData();
      const metrics = data.metrics || [];

      // Check if any device metrics have CWV issues
      let hasCWVIssues = false;
      let metricIssues = [];

      for (const metric of metrics) {
        const issues = getMetricIssues(metric);
        if (issues.length > 0) {
          hasCWVIssues = true;
          metricIssues = issues;
          break;
        }
      }

      if (hasCWVIssues) {
        suggestionsToUpdate.push({ suggestion, metricIssues });
      }
    }

    // Update suggestions with generic recommendations
    const updatePromises = suggestionsToUpdate.map(
      ({ suggestion, metricIssues }) => updateSuggestionWithGenericIssues(
        suggestion,
        metricIssues,
        Suggestion,
        logger,
      ),
    );
    await Promise.all(updatePromises);

    if (suggestionsToUpdate.length > 0) {
      logger.info(`Added ${suggestionsToUpdate.length} generic suggestions to opportunity ${opportunity.getId()}`);
    }

    return suggestionsToUpdate.length;
  } catch (error) {
    logger.error(`Error processing opportunity ${opportunity.getId()}:`, error);
    return 0;
  }
}

/**
 * Runs the CWV demo suggestions processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runCwvDemoSuggestionsProcessor(message, context) {
  const { log, dataAccess } = context;
  const { Site, Suggestion } = dataAccess;
  const {
    siteId, organizationId, taskContext,
  } = message;
  const { profile } = taskContext || {};

  log.info('Processing CWV demo suggestions for site:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
    profile,
  });

  try {
    if (!profile || profile !== DEMO) {
      log.info(`Skipping CWV processing for non-demo profile. Profile: ${profile}`);
      return {
        message: 'CWV processing skipped - not a demo profile',
        reason: 'non-demo-profile',
        profile,
        suggestionsAdded: 0,
      };
    }

    log.info(`Confirmed demo profile - proceeding with CWV processing for profile: ${profile}`);

    const site = await Site.findById(siteId);
    if (!site) {
      log.error(`Site not found for siteId: ${siteId}`);
      return {
        message: 'Site not found',
        suggestionsAdded: 0,
      };
    }

    const opportunities = await site.getOpportunities();
    const cwvOpportunities = opportunities.filter((opp) => opp.getType() === 'cwv');

    if (cwvOpportunities.length === 0) {
      log.info('No CWV opportunities found for site, skipping generic suggestions');
      return {
        message: 'No CWV opportunities found',
        suggestionsAdded: 0,
      };
    }

    const suggestionsUpdated = await processCWVOpportunity(cwvOpportunities[0], Suggestion, log);

    log.info(`Processed CWV opportunity for generic suggestions. Updated ${suggestionsUpdated} suggestions.`);

    return {
      message: 'CWV demo suggestions processor completed',
      opportunitiesProcessed: 1,
      suggestionsAdded: suggestionsUpdated,
    };
  } catch (error) {
    log.error('Error in CWV demo suggestions processor:', error);
    return {
      message: 'CWV demo suggestions processor completed with errors',
      error: error.message,
      suggestionsAdded: 0,
    };
  }
}

export default runCwvDemoSuggestionsProcessor;
