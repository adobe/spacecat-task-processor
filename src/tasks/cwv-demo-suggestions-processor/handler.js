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
import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'cwv-demo-suggestions-processor';
const LCP = 'lcp';
const CLS = 'cls';
const INP = 'inp';
const DEMO = 'demo';
const MAX_CWV_DEMO_SUGGESTIONS = 2;

// CWV reference suggestions defined as global variable to avoid file loading issues
const cwvReferenceSuggestions = {
  lcp: [
    '## **Optimize Image Delivery:**\n• Use next-gen formats (WebP, AVIF)\n• Implement lazy loading\n• Compress images appropriately\n• Use responsive images with srcset\n• Consider image sprites for icons\n• Preload critical above-the-fold images',
    '## **Optimize CSS Loading:**\n• Inline critical CSS\n• Defer non-critical CSS\n• Use media queries conditionally\n• Minify CSS files\n• Consider CSS-in-JS for dynamic styling\n• Implement CSS containment',
    '## **Optimize Server & Network:**\n• Use CDN for global distribution\n• Enable GZIP/Brotli compression\n• Implement HTTP/2 or HTTP/3\n• Use edge caching strategies\n• Consider service workers\n• Use resource hints (preconnect, dns-prefetch)',
  ],
  cls: [
    '## **Prevent Layout Shifts:**\n• Set explicit width/height on images/videos\n• Use aspect-ratio CSS property\n• Implement skeleton screens\n• Reserve space for dynamic content\n• Avoid inserting content above existing content\n• Use CSS Grid/Flexbox for predictable layouts',
    '## **Optimize Animations:**\n• Use CSS transforms and opacity\n• Implement will-change property\n• Use transform3d for stacking context\n• Avoid changing layout properties during animations\n• Use requestAnimationFrame for smooth animations\n• Consider CSS transitions over JavaScript animations',
    '## **Maintain Visual Stability:**\n• Implement skeleton screens\n• Reserve space for dynamic content\n• Use content-visibility CSS property\n• Implement CSS containment\n• Use CSS Grid and Flexbox\n• Avoid cumulative layout shifts',
  ],
  inp: [
    '## **Break Up JavaScript Tasks:**\n• Use setTimeout or requestIdleCallback\n• Implement web workers for CPU-intensive operations\n• Use requestAnimationFrame for visual updates\n• Consider Intersection Observer API\n• Implement virtual scrolling for long lists\n• Use microtasks and macrotasks appropriately',
    '## **Optimize Event Handling:**\n• Debounce input events\n• Use passive event listeners\n• Implement event delegation\n• Use AbortController to cancel operations\n• Consider ResizeObserver and MutationObserver\n• Optimize event listener registration',
    '## **Optimize DOM Manipulation:**\n• Implement virtual scrolling\n• Use DocumentFragment for batch updates\n• Implement object pooling\n• Use Web Components for encapsulation\n• Implement progressive enhancement\n• Minimize DOM queries and mutations',
  ],
};

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
 * Gets a random suggestion from the available suggestions for a given issue type
 * @param {string} issueType - The type of issue (lcp, cls, inp)
 * @returns {string|null} A random suggestion or null if none available
 */
function getRandomSuggestion(issueType) {
  const suggestions = cwvReferenceSuggestions[issueType];
  if (!isNonEmptyArray(suggestions)) {
    return null;
  }

  const randomIndex = Math.floor(Math.random() * suggestions.length);
  return suggestions[randomIndex];
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
) {
  let issuesAdded = 0;

  try {
    const data = suggestion.getData();

    if (!data.issues) {
      data.issues = [];
    }

    for (const issueType of metricIssues) {
      const randomSuggestion = getRandomSuggestion(issueType, cwvReferenceSuggestions);
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
  }

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
      );
      return issuesAdded;
    });

    const issuesAddedResults = await Promise.all(updatePromises);
    const totalIssuesAdded = issuesAddedResults.reduce((sum, issuesAdded) => sum + issuesAdded, 0);

    if (suggestionsToUpdate.length > 0) {
      logger.info(`Added ${totalIssuesAdded} generic CWV suggestions for opportunity ${opportunity.getId()}`);
      await say(env, logger, slackContext, `🎯 Added ${totalIssuesAdded} generic CWV suggestions for opportunity ${opportunity.getId()}`);
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
