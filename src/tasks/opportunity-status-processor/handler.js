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

import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'opportunity-status-processor';

/**
 * Gets the opportunity title from the opportunity type
 * @param {string} opportunityType - The opportunity type
 * @returns {string} The opportunity title
 */
function getOpportunityTitle(opportunityType) {
  const opportunityTitles = {
    cwv: 'Core Web Vitals',
    'meta-tags': 'SEO Meta Tags',
    'broken-back-links': 'Broken Back Links',
    'broken-links': 'Broken Links',
  };

  // Check if the opportunity type exists in our map
  if (opportunityTitles[opportunityType]) {
    return opportunityTitles[opportunityType];
  }

  // Convert kebab-case to Title Case (e.g., "first-second" -> "First Second")
  return opportunityType
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Runs the opportunity status processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runOpportunityStatusProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Site } = dataAccess;
  log.info('Running opportunity status processor');
  const { siteId, organizationId, taskContext } = message;
  const {
    auditTypes, slackContext,
  } = taskContext;

  log.info('Processing opportunity status for site:', {
    siteId,
    organizationId,
    taskType: TASK_TYPE,
    auditTypes,
  });

  try {
    // Get the site and its opportunities
    const site = await Site.findById(siteId);
    if (!site) {
      log.error(`Site not found for siteId: ${siteId}`);
      await say(env, log, slackContext, `:x: Site not found for siteId: ${siteId}`);
      return;
    }

    const opportunities = await site.getOpportunities();
    log.info(`Found ${opportunities.length} opportunities for site ${siteId}`);

    // Track processed opportunity types to avoid duplicates
    const processedTypes = new Set();
    const statusMessages = [];

    // Process each opportunity
    for (const opportunity of opportunities) {
      const opportunityType = opportunity.getType();

      // Skip if we've already processed this opportunity type
      if (processedTypes.has(opportunityType)) {
        // eslint-disable-next-line no-continue
        continue;
      }

      // Mark this type as processed
      processedTypes.add(opportunityType);

      // Get suggestions for this opportunity
      // eslint-disable-next-line no-await-in-loop
      const suggestions = await opportunity.getSuggestions();

      // Get the opportunity title
      const opportunityTitle = getOpportunityTitle(opportunityType);

      // Determine status based on suggestions length
      const hasSuggestions = suggestions && suggestions.length > 0;
      const status = hasSuggestions ? ':white_check_mark:' : ':cross-x:';

      // Add to status messages array
      statusMessages.push(`${opportunityTitle} ${status}`);
    }

    // Send combined status message
    if (statusMessages.length > 0) {
      const combinedMessage = statusMessages.join('\n');
      await say(env, log, slackContext, combinedMessage);
    }

    log.info('Opportunity status checking completed');
  } catch (error) {
    log.error('Error in opportunity status checking:', {
      error: error.message,
      stack: error.stack,
      errorType: error.name,
    });
    await say(env, log, slackContext, `:x: Error checking site opportunities status: ${error.message}`);
  }
}

export default runOpportunityStatusProcessor;
