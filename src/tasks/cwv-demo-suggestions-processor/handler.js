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
 * Reads content from a static text file
 * @param {string} fileName - The name of the file to read
 * @param {object} logger - The logger object for error logging
 * @returns {string|null} The file content or null if file doesn't exist
 */
function readStaticFile(fileName, logger) {
  try {
    logger.info(`Reading static file ${fileName}`);

    // Try multiple possible paths since process.cwd() is /var/task but handler is elsewhere
    const possiblePaths = [
      // Path relative to handler.js location (most likely to work)
      path.resolve(path.dirname(new URL(import.meta.url).pathname), fileName),
      // Path from process.cwd() (Lambda runtime directory)
      path.resolve(process.cwd(), 'src', 'tasks', 'cwv-demo-suggestions-processor', fileName),
      // Direct from process.cwd()
      path.resolve(process.cwd(), fileName),
    ];

    for (const filePath of possiblePaths) {
      logger.info(`Trying path: ${filePath}`);
      if (fs.existsSync(filePath)) {
        logger.info(`Found file at: ${filePath}`);
        const content = fs.readFileSync(filePath, 'utf8');
        logger.info(`Static file content length: ${content ? content.length : 'null'}`);
        return content;
      }
    }

    logger.error(`File ${fileName} not found in any of the expected locations`);
    return null;
  } catch (error) {
    logger.error(`Failed to read static file ${fileName}:`, error.message);
    return null;
  }
}

/**
 * Gets a random suggestion from text files for the given issue type
 * @param {string} issueType - The type of issue (lcp, cls, inp)
 * @param {object} logger - The logger object for error logging
 * @returns {string|null} The entire text file content or null if none available
 */
function getRandomSuggestion(issueType, logger) {
  const files = METRIC_FILES[issueType];
  if (!isNonEmptyArray(files)) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * files.length);
  const fileName = files[randomIndex];
  const content = readStaticFile(fileName, logger);

  if (!content) {
    return null;
  }

  // Return the entire markdown file content as the suggestion
  return content;
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
  return data.issues && isNonEmptyArray(data.issues);
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

    for (const issueType of metricIssues) {
      logger.info(`Getting random suggestion for issue type: ${issueType}`);
      const randomSuggestion = getRandomSuggestion(issueType, logger);
      if (randomSuggestion) {
        logger.info(`Random suggestion found for issue type: ${issueType}`);
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

    const hasSuggestionsWithIssues = suggestions.some(hasExistingIssues);

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
