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
import { isNonEmptyArray } from '@adobe/spacecat-shared-utils';

import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'cwv-demo-suggestions-processor';
const LCP = 'lcp';
const CLS = 'cls';
const INP = 'inp';
const DEMO = 'demo';
const MAX_CWV_DEMO_SUGGESTIONS = 2;

/**
 * Maps metric types to their corresponding markdown files
 */
const CWV_GENERIC_SUGGESTIONS = {
  lcp: ['lcp1.md', 'lcp2.md', 'lcp3.md'],
  cls: ['cls1.md', 'cls2.md'],
  inp: ['inp1.md'],
};

/**
 * Loads content from a markdown file following the spacecat-api-service pattern
 * @param {string} fileName - The name of the file to load
 * @param {object} logger - The logger object
 * @param {object} env - The environment object
 * @param {object} slackContext - The Slack context object
 * @returns {string} The file content
 * @throws {Error} If the file cannot be read
 */
const loadSuggestionContent = async (fileName, logger, env, slackContext) => {
  try {
    const filePath = path.resolve(process.cwd(), 'static', fileName);
    const data = fs.readFileSync(filePath, 'utf-8');
    return data;
  } catch (error) {
    logger.error(`Failed to load suggestion content from "${fileName}": ${error.message}`);
    await say(env, logger, slackContext, `❌ Failed to load suggestion content from "${fileName}": ${error.message}`);
    throw new Error(`Failed to load suggestion content from "${fileName}": ${error.message}`);
  }
};

/**
 * Gets a random suggestion for the given issue type using the spacecat-api-service pattern
 * @param {string} issueType - The type of issue (lcp, cls, inp)
 * @param {object} logger - The logger object for error logging
 * @param {object} env - The environment object
 * @param {object} slackContext - The Slack context object
 * @returns {Promise<string|null>} A random suggestion or null if none available
 */
async function getRandomSuggestion(issueType, logger, env, slackContext) {
  const files = CWV_GENERIC_SUGGESTIONS[issueType];
  /* c8 ignore start */
  // Defensive check: CWV_GENERIC_SUGGESTIONS is a hardcoded map with valid arrays.
  // This path only occurs if the map is misconfigured, which doesn't happen in production.
  if (!isNonEmptyArray(files)) {
    await say(env, logger, slackContext, `No files found for issue type: ${issueType} and files: ${files}`);
    return null;
  }
  /* c8 ignore stop */

  const randomIndex = Math.floor(Math.random() * files.length);
  const fileName = files[randomIndex];

  try {
    const content = await loadSuggestionContent(fileName, logger, env, slackContext);
    return content;
  } catch (error) {
    logger.error(`Failed to get random suggestion for ${issueType}: ${error.message}`);
    await say(env, logger, slackContext, `❌ Failed to get random suggestion for ${issueType}: ${error.message}`);
    return null;
  }
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

  if (metrics?.lcp > CWV_THRESHOLDS[LCP]) {
    issues.push(LCP);
  }

  if (metrics?.cls > CWV_THRESHOLDS[CLS]) {
    issues.push(CLS);
  }

  if (metrics?.inp > CWV_THRESHOLDS[INP]) {
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
  return (data.issues && Array.isArray(data.issues) && data.issues.length > 0)
         || data.genericSuggestions === true;
}

/**
 * Updates a suggestion with generic CWV issues (as per requirements)
 * @param {object} suggestion - The suggestion object
 * @param {Array} metricIssues - Array of metric issue types
 * @param {object} logger - The logger object
 * @param {object} env - The environment object
 * @param {object} slackContext - The Slack context object
 * @returns {number} Number of issues successfully added
 */
async function updateSuggestionWithGenericIssues(
  suggestion,
  metricIssues,
  logger,
  env,
  slackContext,
) {
  let issuesAdded = 0;

  try {
    const data = suggestion.getData();

    if (!data.issues) {
      data.issues = [];
    }

    // Process all issue types in parallel to avoid await in loop
    const suggestionPromises = metricIssues.map(async (issueType) => {
      const randomSuggestion = await getRandomSuggestion(issueType, logger, env, slackContext);
      return { issueType, randomSuggestion };
    });

    const suggestions = await Promise.all(suggestionPromises);

    for (const { issueType, randomSuggestion } of suggestions) {
      if (randomSuggestion) {
        const genericIssue = {
          type: issueType,
          value: randomSuggestion,
        };
        data.issues.push(genericIssue);
        data.genericSuggestions = true;
        issuesAdded += 1;
      }
    }

    suggestion.setData(data);
    suggestion.setUpdatedBy('system');
    await suggestion.save();
  } catch (error) {
    logger.error(`Error updating suggestion ${suggestion.getId()} with generic issues:`, error);
    await say(env, logger, slackContext, `❌ Error updating suggestion ${suggestion.getId()}: ${error.message}`);
  }
  return issuesAdded;
}

/**
 * Processes a single opportunity according to exact requirements
 * @param {object} opportunity - The opportunity object
 * @param {object} logger - The logger object
 * @param {object} env - The environment object
 * @param {object} slackContext - The Slack context object
 * @returns {number} Number of suggestions updated
 */
async function processCWVOpportunity(opportunity, logger, env, slackContext) {
  try {
    const allSuggestions = await opportunity.getSuggestions();

    // Filter to only process suggestions with "new" status
    const suggestions = allSuggestions.filter((suggestion) => suggestion.getStatus() === 'NEW');

    // Check if any suggestion has existing issues
    const hasSuggestionsWithIssues = suggestions.some(hasExistingIssues);
    if (hasSuggestionsWithIssues) {
      await say(env, logger, slackContext, `ℹ️ Opportunity ${opportunity.getId()} already has suggestions, skipping generic suggestions`);
      return 0;
    }
    await say(env, logger, slackContext, `✅ Opportunity ${opportunity.getId()} has no existing suggestions, adding generic suggestions`);

    // Sort suggestions by pageviews (descending)
    const sortedSuggestions = suggestions
      .filter((suggestion) => {
        const data = suggestion.getData();
        return data?.pageviews > 0;
      })
      .sort((a, b) => b.getData().pageviews - a.getData().pageviews);

    // Find first 2 suggestions with LCP/CLS/INP issues
    const suggestionsToUpdate = [];
    const sayPromises = [];

    for (const suggestion of sortedSuggestions) {
      if (suggestionsToUpdate.length >= MAX_CWV_DEMO_SUGGESTIONS) break;

      const data = suggestion.getData();
      const metrics = data.metrics || [];

      // Check if suggestion has any LCP/CLS/INP issues
      let hasCWVIssues = false;
      let metricIssues = [];

      for (const metric of metrics) {
        const issues = getMetricIssues(metric);
        if (issues.length > 0) {
          hasCWVIssues = true;
          metricIssues = issues;
          break; // Take first set of issues found
        }
      }

      if (hasCWVIssues) {
        suggestionsToUpdate.push({ suggestion, metricIssues });
      }
    }

    await Promise.all(sayPromises);
    if (suggestionsToUpdate.length === 0) {
      return 0;
    }

    // Add generic suggestions to selected suggestions
    const updatePromises = suggestionsToUpdate.map(async ({ suggestion, metricIssues }) => {
      const issuesAdded = await updateSuggestionWithGenericIssues(
        suggestion,
        metricIssues,
        logger,
        env,
        slackContext,
      );
      return { suggestion, issuesAdded };
    });

    const results = await Promise.all(updatePromises);
    const totalIssuesAdded = results.reduce((sum, { issuesAdded }) => sum + issuesAdded, 0);

    // Log information about generic suggestions added
    if (totalIssuesAdded > 0) {
      await say(env, logger, slackContext, `🎯 Added ${totalIssuesAdded} generic CWV suggestions for opportunity ${opportunity.getId()}`);
    } else {
      await say(env, logger, slackContext, `❌ No generic CWV suggestions added for opportunity ${opportunity.getId()}`);
    }

    return suggestionsToUpdate.length;
  } catch (error) {
    logger.error(`Error processing opportunity ${opportunity.getId()}:`, error);
    await say(env, logger, slackContext, `❌ Error processing opportunity ${opportunity.getId()}: ${error.message}`);
    return 0;
  }
}

/**
 * Runs the CWV demo suggestions processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runCwvDemoSuggestionsProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Site } = dataAccess;
  const {
    siteId, organizationId, taskContext,
  } = message;
  const { profile, slackContext } = taskContext || {};

  log.info('Processing CWV demo suggestions for site:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
    profile,
  });

  try {
    if (!profile || profile !== DEMO) {
      return {
        message: 'CWV processing skipped - not a demo profile',
        reason: 'non-demo-profile',
        profile,
        suggestionsAdded: 0,
      };
    }

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
      await say(env, log, slackContext, 'No CWV opportunities found for site, skipping generic suggestions');
      return {
        message: 'No CWV opportunities found',
        suggestionsAdded: 0,
      };
    }

    const suggestionsUpdated = await processCWVOpportunity(
      cwvOpportunities[0],
      log,
      env,
      slackContext,
    );

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
