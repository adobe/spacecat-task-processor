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
  switch (opportunityType) {
    case 'cwv':
      return 'Core Web Vitals';
    case 'meta-tags':
      return 'SEO Meta Tags';
    case 'broken-back-links':
      return 'Broken Back Links';
    case 'broken-links':
      return 'Broken Links';
    default:
      // Convert kebab-case to Title Case (e.g., "first-second" -> "First Second")
      return opportunityType
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
  }
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

  await say(env, log, slackContext, 'Checking opportunity status');
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

    // Process each opportunity
    for (const opportunity of opportunities) {
      const opportunityType = opportunity.getType();
      const opportunityId = opportunity.getId();

      // Get suggestions for this opportunity
      // eslint-disable-next-line no-await-in-loop
      const suggestions = await site.getSuggestions(opportunityId);

      // Get the opportunity title
      const opportunityTitle = getOpportunityTitle(opportunityType);

      // Determine status based on suggestions length
      const hasSuggestions = suggestions && suggestions.length > 0;
      const status = hasSuggestions ? ':white_check_mark:' : ':cross_x:';

      // Send Slack message
      const slackMessage = `${opportunityTitle} ${status}`;
      // eslint-disable-next-line no-await-in-loop
      await say(env, log, slackContext, slackMessage);
    }

    log.info('Opportunity status checking completed');
    await say(env, log, slackContext, 'Opportunity status checking completed');
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
