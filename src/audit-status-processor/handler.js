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

import { say } from '../utils/slack-utils.js';

const TASK_TYPE = 'audit-status-processor';

/**
 * Runs the audit status processor
 * @param {object} auditStatusMessage - The auditStatusMessage object
 * @param {object} context - The context object
 * @returns {Promise<object>} The audit result
 */
export async function runAuditStatusProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Site } = dataAccess;
  log.info('Running audit status processor');
  const { siteId, organizationId, taskContext } = message;
  const {
    auditTypes, slackContext,
  } = taskContext;

  log.info('Processing audit status for site:', {
    siteId,
    organizationId,
    taskType: TASK_TYPE,
    auditTypes,
  });

  await say(env, log, slackContext, 'Checking audit status');
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

    // Check opportunities for each audit type
    const auditStatusPromises = auditTypes.map(async (auditType) => {
      const opportunitiesForType = opportunities.filter((opp) => opp.getType() === auditType);
      log.info(`Found ${opportunitiesForType.length} opportunities for audit type ${auditType}`);

      if (opportunitiesForType.length > 0) {
        // Get the latest opportunity for this audit type
        const latestOpportunity = opportunitiesForType.sort(
          (a, b) => new Date(b.getCreatedAt()) - new Date(a.getCreatedAt()),
        )[0];

        log.info(`Latest opportunity for site ${siteId} and audit type ${auditType}: ${JSON.stringify(latestOpportunity)}`);

        const opportunityData = latestOpportunity.getData();
        if (opportunityData && opportunityData.success) {
          log.info(`Latest opportunity for site ${siteId} was successful for audit type ${auditType}`);
          const slackMessage = `:check_mark: Latest opportunity for site ${siteId} was successful for audit type ${auditType}`;
          return say(env, log, slackContext, slackMessage);
        } else {
          const error = opportunityData?.error || 'Unknown error';
          log.warn(`Latest opportunity for site ${siteId} failed for audit type ${auditType}: ${error}`);
          const slackMessage = `:x: Latest opportunity for site ${siteId} failed for audit type ${auditType}: ${error}`;
          return say(env, log, slackContext, slackMessage);
        }
      } else {
        log.info(`No opportunities found for audit type ${auditType} for site ${siteId}`);
        const slackMessage = `:information_source: No opportunities found for audit type ${auditType} for site ${siteId}`;
        return say(env, log, slackContext, slackMessage);
      }
    });

    await Promise.all(auditStatusPromises);
    log.info('Audit status checking completed');
    await say(env, log, slackContext, 'Audit status checking completed');
  } catch (error) {
    log.error('Error in audit status checking:', {
      error: error.message,
      stack: error.stack,
      errorType: error.name,
    });
    await say(env, log, slackContext, `:x: Error checking site opportunities status: ${error.message}`);
  }
}

export default runAuditStatusProcessor;
