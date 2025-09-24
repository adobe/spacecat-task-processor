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
 * Maps metric types to their corresponding text files
 */
const METRIC_FILES = {
  lcp: ['lcp1.txt', 'lcp2.txt', 'lcp3.txt'],
  cls: ['cls1.txt', 'cls2.txt'],
  inp: ['inp1.txt'],
};

/**
 * Loads content from a text file following the spacecat-api-service pattern
 * @param {string} fileName - The name of the file to load
 * @returns {string} The file content
 * @throws {Error} If the file cannot be read
 */
const loadSuggestionContent = (fileName) => {
  try {
    const filePath = path.resolve(process.cwd(), 'static', fileName);
    const data = fs.readFileSync(filePath, 'utf-8');
    return data;
  } catch (error) {
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
  const files = METRIC_FILES[issueType];
  if (!isNonEmptyArray(files)) {
    await say(env, logger, slackContext, `getRandomSuggestion: No files found for issue type: ${issueType} and files: ${files}`);
    return null;
  }

  const randomIndex = Math.floor(Math.random() * files.length);
  const fileName = files[randomIndex];

  try {
    logger.info(`Getting random suggestion for issue type: ${issueType} from file: ${fileName}`);
    const content = loadSuggestionContent(fileName);
    await say(env, logger, slackContext, `loadSuggestionContent: Random suggestion for issue type: ${issueType} is ${content}`);
    logger.info(`✅ Successfully loaded suggestion for ${issueType} (${content.length} chars)`);
    return content;
  } catch (error) {
    logger.error(`Failed to get random suggestion for ${issueType}: ${error.message}`);
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
 * Checks if a suggestion has existing non-generic CWV issues
 * @param {object} suggestion - The suggestion object
 * @returns {boolean} True if suggestion has existing non-generic issues
 */
function hasExistingIssues(suggestion) {
  const data = suggestion.getData() || {};

  if (!Array.isArray(data.issues) || data.issues.length === 0) {
    return false; // no issues at all
  }

  // Only consider an issue as “existing non-generic” if it has a type and is explicitly not generic
  return data.issues.some(
    (issue) => issue && typeof issue === 'object' && issue.type && !issue.generic,
  );
}

/**
 * Updates a suggestion with generic CWV issues
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
    logger.info('Loading CWV suggestions from markdown files');
    await say(env, logger, slackContext, 'Loaded CWV suggestions from markdown files');

    const data = suggestion.getData();

    if (!data.issues) {
      data.issues = [];
    }

    // Process all issue types in parallel to avoid await in loop
    const suggestionPromises = metricIssues.map(async (issueType) => {
      logger.info(`Getting random suggestion for issue type: ${issueType}`);
      const randomSuggestion = await getRandomSuggestion(issueType, logger, env, slackContext);
      await say(env, logger, slackContext, `getRandomSuggestion: Random suggestion for issue type: ${issueType} is ${randomSuggestion}`);
      return { issueType, randomSuggestion };
    });

    const suggestions = await Promise.all(suggestionPromises);

    for (const { issueType, randomSuggestion } of suggestions) {
      if (randomSuggestion) {
        logger.info(`Random suggestion found for issue type: ${issueType}`);
        logger.info(`Suggestion content length: ${randomSuggestion.length}`);
        logger.info(`Suggestion content preview: ${randomSuggestion.substring(0, 100)}...`);

        const genericIssue = {
          type: issueType,
          value: randomSuggestion,
          generic: true,
        };

        logger.info(`Adding generic issue: ${JSON.stringify(genericIssue, null, 2)}`);
        data.issues.push(genericIssue);
        data.genericSuggestions = true;
        issuesAdded += 1;

        logger.info(`Issues array now has ${data.issues.length} items`);
      } else {
        logger.warn(`No random suggestion found for issue type: ${issueType}`);
      }
    }

    logger.info(`Final data before saving: ${JSON.stringify(data, null, 2)}`);
    suggestion.setData(data);
    suggestion.setUpdatedBy('system');
    await suggestion.save();

    logger.info(`Suggestion saved successfully. Final issues count: ${data.issues.length}`);

    logger.info(`Updated suggestion ${suggestion.getId()} with ${issuesAdded} generic CWV issues: ${metricIssues.join(', ')}`);
  } catch (error) {
    logger.error(`Error updating suggestion ${suggestion.getId()} with generic issues:`, error);
  }
  logger.info(`Issues added: ${issuesAdded}`);
  return issuesAdded;
}

/**
 * Processes a single opportunity
 * @param {object} opportunity - The opportunity object
 * @param {object} logger - The logger object
 * @param {object} env - The environment object
 * @param {object} slackContext - The Slack context object
 * @returns {number} Number of suggestions updated
 */
async function processCWVOpportunity(opportunity, logger, env, slackContext) {
  try {
    const suggestions = await opportunity.getSuggestions();

    // Debug logging to see what suggestions exist
    logger.info(`Opportunity ${opportunity.getId()} has ${suggestions.length} suggestions`);
    await say(env, logger, slackContext, `🔍 DEBUG: Opportunity ${opportunity.getId()} has ${suggestions.length} suggestions`);

    // Process all suggestions in parallel to avoid await in loop
    const debugPromises = suggestions.map(async (suggestion) => {
      const data = suggestion.getData();
      logger.info(`Suggestion ${suggestion.getId()}: issues=${data.issues?.length || 0}, genericSuggestions=${data.genericSuggestions || false}`);
      await say(env, logger, slackContext, `🔍 DEBUG: Suggestion ${suggestion.getId()}: issues=${data.issues?.length || 0}, genericSuggestions=${data.genericSuggestions || false}`);

      if (data.issues && data.issues.length > 0) {
        const issueSummary = data.issues.map((issue) => `${issue.type}(${issue.generic ? 'generic' : 'regular'})`).join(', ');
        logger.info(`Issues in suggestion ${suggestion.getId()}: ${issueSummary}`);
        await say(env, logger, slackContext, `🔍 DEBUG: Issues in suggestion ${suggestion.getId()}: ${issueSummary}`);
      }
    });

    await Promise.all(debugPromises);

    const hasSuggestionsWithIssues = suggestions.some(hasExistingIssues);
    logger.info(`Has suggestions with non-generic issues: ${hasSuggestionsWithIssues}`);
    await say(env, logger, slackContext, `🔍 DEBUG: Has suggestions with non-generic issues: ${hasSuggestionsWithIssues}`);

    if (hasSuggestionsWithIssues) {
      logger.info(`Opportunity ${opportunity.getId()} already has suggestions with issues, skipping generic suggestions`);
      await say(env, logger, slackContext, `ℹ️ CWV suggestions already exist for opportunity ${opportunity.getId()}, skipping demo suggestions`);
      return 0;
    }

    // Sort suggestions by pageviews (descending)
    const sortedSuggestions = suggestions
      .filter((suggestion) => {
        const data = suggestion.getData();
        return data?.pageviews > 0;
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
    const updatePromises = suggestionsToUpdate.map(async ({ suggestion, metricIssues }) => {
      const issuesAdded = await updateSuggestionWithGenericIssues(
        suggestion,
        metricIssues,
        logger,
        env,
        slackContext,
      );
      return issuesAdded;
    });

    const issuesAddedResults = await Promise.all(updatePromises);
    logger.info(`Issues added results: ${issuesAddedResults}`);
    const totalIssuesAdded = issuesAddedResults.reduce((sum, count) => sum + count, 0);
    logger.info(`Total issues added: ${totalIssuesAdded}`);

    if (totalIssuesAdded > 0) {
      // Create generic suggestions at the opportunity level
      const allMetricIssues = [
        ...new Set(suggestionsToUpdate.flatMap(({ metricIssues }) => metricIssues)),
      ];
      logger.info(
        `Creating generic suggestions for opportunity ${opportunity.getId()} with metric issues: ${allMetricIssues.join(', ')}`,
      );

      // Process all issue types in parallel to avoid await in loop
      const genericSuggestionPromises = allMetricIssues.map(async (issueType) => {
        logger.info(`Creating generic suggestion for issue type: ${issueType}`);
        const randomSuggestion = await getRandomSuggestion(issueType, logger, env, slackContext);

        if (randomSuggestion) {
          logger.info(`Creating opportunity-level generic suggestion for ${issueType}`);

          // Create a new suggestion at the opportunity level
          const genericSuggestion = {
            type: issueType,
            value: randomSuggestion,
            generic: true,
            createdBy: 'system',
            createdAt: new Date().toISOString(),
          };

          logger.info(`Adding generic suggestion to opportunity: ${JSON.stringify(genericSuggestion, null, 2)}`);
          return genericSuggestion;
        }
        return null;
      });

      const genericSuggestions = await Promise.all(genericSuggestionPromises);
      const validGenericSuggestions = genericSuggestions.filter(Boolean);

      if (validGenericSuggestions.length > 0) {
        // Add to opportunity's suggestions array
        const opportunityData = opportunity.getData();
        if (!opportunityData.suggestions) {
          opportunityData.suggestions = [];
        }
        opportunityData.suggestions.push(...validGenericSuggestions);
        opportunity.setData(opportunityData);
        await opportunity.save();

        logger.info(`Added ${validGenericSuggestions.length} generic suggestions to opportunity ${opportunity.getId()}`);
      }

      logger.info(`Added ${totalIssuesAdded} demo CWV suggestions for opportunity ${opportunity.getId()} (regular CWV suggestions were not present)`);
      await say(env, logger, slackContext, `✅ Added ${totalIssuesAdded} demo CWV suggestions for opportunity ${opportunity.getId()} (regular CWV suggestions were not present)`);
    } else {
      await say(env, logger, slackContext, `:x: No generic CWV suggestions added for opportunity ${opportunity.getId()} as total issues added is ${totalIssuesAdded}`);
      logger.info(`No generic CWV suggestions added for opportunity ${opportunity.getId()}`);
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

    const suggestionsUpdated = await processCWVOpportunity(
      cwvOpportunities[0],
      log,
      env,
      slackContext,
    );

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
