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

/* c8 ignore start - POC code without tests */

import { randomUUID } from 'crypto';
import { sendToMystique, pollMystiqueResponse } from '../../utils/mystique-client.js';
import { say } from '../../utils/slack-utils.js';

/**
 * Post error message to Slack
 */
async function postErrorToSlack(slackContext, env, log, errorMessage) {
  try {
    await say(
      env,
      log,
      slackContext,
      `:x: *Error:* ${errorMessage}`,
    );
  } catch (error) {
    log.error(`Failed to post error to Slack: ${error.message}`, error);
  }
}

/**
 * Fallback message formatter if Mystique doesn't provide slackMessage
 */
function formatFallbackMessage(enrichedData) {
  const data = enrichedData.enrichedData || {};

  return ':robot_face: *AI-Enriched Opportunity Analysis*\n\n'
    + `:dart: **Priority:** ${data.priority || 'N/A'}\n`
    + `:chart_with_upwards_trend: **ICE Score:** ${data.ice_score || 'N/A'}/10\n\n`
    + `\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 1500)}\n\`\`\``;
}

/**
 * Enrich opportunity with AI-powered insights
 *
 * This handler:
 * 1. Loads opportunity and suggestions from DynamoDB
 * 2. Sends enrichment request to Mystique
 * 3. Polls for Mystique's response (with timeout)
 * 4. Posts enriched results to Slack
 *
 * @param {object} message - Task message
 * @param {string} message.type - 'enrich-opportunity'
 * @param {string} message.siteId - Site ID
 * @param {string} message.auditType - Audit type (cwv, accessibility, etc.)
 * @param {object} message.taskContext - Task context
 * @param {object} message.taskContext.slackContext - Slack channel/thread info
 * @param {object} context - Runtime context
 * @returns {Promise<object>} - Result status
 */
export async function runEnrichOpportunity(message, context) {
  const { log, env, dataAccess } = context;
  const { siteId, auditType, taskContext } = message;
  const { slackContext } = taskContext;

  const requestId = `enrich-${siteId}-${auditType}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  try {
    log.info(`[${requestId}] Starting AI enrichment for ${auditType} on site ${siteId}`);

    // Step 1: Load site from database
    const { Site } = dataAccess;
    const site = await Site.findById(siteId);

    if (!site) {
      await postErrorToSlack(
        slackContext,
        env,
        log,
        `Site not found: ${siteId}`,
      );
      return { status: 'error', reason: 'site-not-found' };
    }

    const siteUrl = site.getBaseURL();
    log.info(`[${requestId}] Site found: ${siteUrl}`);

    // Step 2: Load opportunities for this audit type
    const opportunities = await site.getOpportunities();

    // POC: Only enriches the FIRST opportunity for this audit type
    // This works for cwv, accessibility, broken-internal-links, broken-backlinks, meta-tags
    // as they each generate only 1 opportunity.
    // Future: For audits with multiple opportunities, use .filter() or add opportunity ID parameter
    const targetOpportunity = opportunities.find((opp) => opp.getType() === auditType);

    if (!targetOpportunity) {
      await say(
        env,
        log,
        slackContext,
        `:x: No \`${auditType}\` opportunity found for ${siteUrl}.\n`
        + `Run the audit first: \`@spacecat-dev audit ${siteUrl} ${auditType}\``,
      );
      return { status: 'no-opportunity', auditType };
    }

    log.info(`[${requestId}] Found opportunity: ${targetOpportunity.getId()}`);

    // Step 3: Load suggestions for this opportunity
    const suggestions = await targetOpportunity.getSuggestions();
    log.info(`[${requestId}] Found ${suggestions.length} suggestions`);

    if (suggestions.length === 0) {
      await say(
        env,
        log,
        slackContext,
        `:warning: Found \`${auditType}\` opportunity but no suggestions to enrich.\n`
        + 'The opportunity exists but has no actionable suggestions yet.',
      );
      return { status: 'no-suggestions', opportunityId: targetOpportunity.getId() };
    }

    // Step 4: Get audit context (latest audit results for additional context)
    const latestAudits = await site.getLatestAudits();
    const auditContext = latestAudits.find((a) => a.getAuditType() === auditType);

    // Step 5: Prepare payload for Mystique
    const mystiquePayload = {
      requestId,
      siteUrl,
      auditType,
      opportunity: {
        id: targetOpportunity.getId(),
        type: targetOpportunity.getType(),
        title: targetOpportunity.getTitle(),
        description: targetOpportunity.getDescription(),
        data: targetOpportunity.getData(),
        guidance: targetOpportunity.getGuidance ? targetOpportunity.getGuidance() : null,
        runbook: targetOpportunity.getRunbook ? targetOpportunity.getRunbook() : null,
      },
      suggestions: suggestions.map((s) => ({
        id: s.getId(),
        type: s.getType(),
        data: s.getData(),
        rank: s.getRank(),
      })),
      auditContext: auditContext ? {
        auditResult: auditContext.getAuditResult(),
        scores: auditContext.getScores ? auditContext.getScores() : null,
      } : null,
    };

    log.info(`[${requestId}] Sending enrichment request to Mystique`);

    // Step 6: Send to Mystique inbound queue
    await sendToMystique(
      env.SPACECAT_TO_MYSTIQUE_SQS_URL,
      mystiquePayload,
      log,
    );

    // Step 7: Poll Mystique outbound queue for response
    const maxWaitSeconds = 120; // 2 minutes max
    log.info(`[${requestId}] Polling for Mystique response (max ${maxWaitSeconds}s)`);

    const enrichedResult = await pollMystiqueResponse(
      env.MYSTIQUE_TO_SPACECAT_SQS_URL,
      requestId,
      log,
      maxWaitSeconds,
    );

    if (!enrichedResult) {
      throw new Error(`Timeout waiting for Mystique response (requestId: ${requestId})`);
    }

    log.info(`[${requestId}] Received enriched results from Mystique`);

    // Step 8: Post to Slack
    const slackMessage = enrichedResult.slackMessage || formatFallbackMessage(enrichedResult);

    await say(
      env,
      log,
      slackContext,
      slackMessage,
    );

    log.info(`[${requestId}] Posted AI enrichment results to Slack for ${auditType}`);

    return {
      status: 'success',
      requestId,
      siteId,
      auditType,
      opportunityId: targetOpportunity.getId(),
      suggestionCount: suggestions.length,
    };
  } catch (error) {
    log.error(`[${requestId}] Enrichment failed for ${auditType}: ${error.message}`, error);

    try {
      await say(
        env,
        log,
        slackContext,
        `:x: *AI Enrichment Failed*\n\`\`\`\n${error.message}\n\`\`\``,
      );
    } catch (slackError) {
      log.error(`[${requestId}] Failed to post error to Slack`, slackError);
    }

    return {
      status: 'error',
      requestId,
      reason: error.message,
    };
  }
}

/* c8 ignore stop */
