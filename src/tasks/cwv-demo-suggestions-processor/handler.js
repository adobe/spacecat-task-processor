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
 * @param {object} logger - The logger object
 * @param {object} env - The environment object
 * @param {object} slackContext - The Slack context object
 * @returns {string} The file content
 * @throws {Error} If the file cannot be read
 */
const loadSuggestionContent = async (fileName, logger, env, slackContext) => {
  try {
    const filePath = path.resolve(process.cwd(), 'static', fileName);
    logger.info(`Loading file: ${fileName} from path: ${filePath}`);
    await say(env, logger, slackContext, `📁 Loading file: ${fileName} from path: ${filePath}`);

    const data = fs.readFileSync(filePath, 'utf-8');
    logger.info(`Successfully loaded ${fileName}: ${data.length} characters`);
    await say(env, logger, slackContext, `✅ Successfully loaded ${fileName}: ${data.length} characters`);
    await say(env, logger, slackContext, `📄 Content preview (first 100 chars): ${data.substring(0, 100)}...`);

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
  const files = METRIC_FILES[issueType];
  if (!isNonEmptyArray(files)) {
    await say(env, logger, slackContext, `getRandomSuggestion: No files found for issue type: ${issueType} and files: ${files}`);
    return null;
  }

  const randomIndex = Math.floor(Math.random() * files.length);
  const fileName = files[randomIndex];

  try {
    const content = await loadSuggestionContent(fileName, logger, env, slackContext);
    await say(env, logger, slackContext, `✅ Successfully loaded suggestion for ${issueType} (${content.length} chars)`);
    logger.info(`✅ Successfully loaded suggestion for ${issueType} (${content.length} chars)`);
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
  return data.issues && Array.isArray(data.issues) && data.issues.length > 0;
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
    await say(env, logger, slackContext, `📊 Current suggestion data: ${JSON.stringify(data, null, 2)}`);

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

    logger.info(`Updated suggestion ${suggestion.getId()} with ${issuesAdded} generic CWV issues: ${metricIssues.join(', ')}`);
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

    logger.info(`Processing opportunity ${opportunity.getId()} with ${suggestions.length} new suggestions (filtered from ${allSuggestions.length} total)`);
    await say(env, logger, slackContext, `🔍 Processing opportunity ${opportunity.getId()} with ${suggestions.length} new suggestions (filtered from ${allSuggestions.length} total)`);
    await say(env, logger, slackContext, `📋 Available CWV files: ${JSON.stringify(METRIC_FILES)}`);

    // Check if any suggestion has existing issues
    const hasSuggestionsWithIssues = suggestions.some(hasExistingIssues);
    if (hasSuggestionsWithIssues) {
      logger.info(`Opportunity ${opportunity.getId()} already has suggestions with issues, skipping generic suggestions`);
      await say(env, logger, slackContext, `ℹ️ Opportunity ${opportunity.getId()} already has suggestions with issues, skipping generic suggestions`);
      return 0;
    }

    logger.info(`Opportunity ${opportunity.getId()} has no existing suggestions with issues, adding generic suggestions`);
    await say(env, logger, slackContext, `✅ Opportunity ${opportunity.getId()} has no existing suggestions with issues, adding generic suggestions`);

    // Requirement: Sort suggestions by pageviews (descending)
    const sortedSuggestions = suggestions
      .filter((suggestion) => {
        const data = suggestion.getData();
        return data?.pageviews > 0;
      })
      .sort((a, b) => b.getData().pageviews - a.getData().pageviews);

    logger.info(`Sorted ${sortedSuggestions.length} suggestions by pageviews`);
    await say(env, logger, slackContext, `📊 Sorted ${sortedSuggestions.length} suggestions by pageviews`);

    // Requirement: Find first 2 suggestions with LCP/CLS/INP issues
    const suggestionsToUpdate = [];
    const sayPromises = [];

    for (const suggestion of sortedSuggestions) {
      if (suggestionsToUpdate.length >= MAX_CWV_DEMO_SUGGESTIONS) break;

      const data = suggestion.getData();
      const metrics = data.metrics || [];

      sayPromises.push(say(env, logger, slackContext, `🔍 Checking suggestion ${suggestion.getId()} with ${metrics.length} metrics`));

      // Check if suggestion has any LCP/CLS/INP issues
      let hasCWVIssues = false;
      let metricIssues = [];

      for (const metric of metrics) {
        const issues = getMetricIssues(metric);
        sayPromises.push(say(env, logger, slackContext, `📈 Metric ${JSON.stringify(metric)} has issues: ${issues.join(', ')}`));
        if (issues.length > 0) {
          hasCWVIssues = true;
          metricIssues = issues;
          break; // Take first set of issues found
        }
      }

      if (hasCWVIssues) {
        suggestionsToUpdate.push({ suggestion, metricIssues });
        logger.info(`Selected suggestion ${suggestion.getId()} with CWV issues: ${metricIssues.join(', ')}`);
        sayPromises.push(say(env, logger, slackContext, `✅ Selected suggestion ${suggestion.getId()} with CWV issues: ${metricIssues.join(', ')}`));
      } else {
        sayPromises.push(say(env, logger, slackContext, `❌ Suggestion ${suggestion.getId()} has no CWV issues, skipping`));
      }
    }

    // Execute all say calls in parallel
    await Promise.all(sayPromises);

    logger.info(`Found ${suggestionsToUpdate.length} suggestions to update with generic suggestions`);
    await say(env, logger, slackContext, `📝 Found ${suggestionsToUpdate.length} suggestions to update with generic suggestions`);

    if (suggestionsToUpdate.length === 0) {
      logger.info(`No suggestions with CWV issues found for opportunity ${opportunity.getId()}`);
      await say(env, logger, slackContext, `ℹ️ No suggestions with CWV issues found for opportunity ${opportunity.getId()}`);
      return 0;
    }

    // Requirement: Add generic suggestions to selected suggestions
    await say(env, logger, slackContext, `🚀 Starting to add generic suggestions to ${suggestionsToUpdate.length} suggestions`);

    const updatePromises = suggestionsToUpdate.map(async ({ suggestion, metricIssues }) => {
      await say(env, logger, slackContext, `⚙️ Processing suggestion ${suggestion.getId()} with issues: ${metricIssues.join(', ')}`);
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

    await say(env, logger, slackContext, `📊 Processing complete. Total issues added: ${totalIssuesAdded}`);

    // Requirement: Log information about generic suggestions added
    if (totalIssuesAdded > 0) {
      logger.info(`Added ${totalIssuesAdded} generic CWV suggestions for opportunity ${opportunity.getId()}`);
      await say(env, logger, slackContext, `🎯 Added ${totalIssuesAdded} generic CWV suggestions for opportunity ${opportunity.getId()}`);
    } else {
      logger.info(`No generic CWV suggestions added for opportunity ${opportunity.getId()}`);
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
      log.info(`Skipping CWV processing for non-demo profile. Profile: ${profile}`);
      await say(env, log, slackContext, `Skipping CWV processing for non-demo profile. Profile: ${profile}`);
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

    log.info(`Processed CWV opportunity for generic suggestions. Updated ${suggestionsUpdated} suggestions.`);
    await say(env, log, slackContext, `Processed CWV opportunity for generic suggestions. Updated ${suggestionsUpdated} suggestions.`);

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
