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
 * Dependency map: What additional data each audit type needs for enrichment
 *
 * This map defines what context data to load from the database to provide
 * the LLM with sufficient information for accurate business impact analysis.
 */
const AUDIT_DEPENDENCIES = {
  cwv: {
    // CWV needs top pages for traffic value and SEO context
    topPages: { source: 'ahrefs', geo: 'global', limit: 100 },
    // Could add: RUM data for real user metrics
  },
  'broken-backlinks': {
    // Broken backlinks needs top pages for link equity context
    topPages: { source: 'ahrefs', geo: 'global', limit: 50 },
  },
  'broken-internal-links': {
    // Internal links needs site topology context
    topPages: { source: 'ahrefs', geo: 'global', limit: 50 },
  },
  'meta-tags': {
    // Meta tags needs top pages for SEO priority
    topPages: { source: 'ahrefs', geo: 'global', limit: 100 },
  },
  accessibility: {
    // Accessibility needs traffic context for impact sizing
    topPages: { source: 'ahrefs', geo: 'global', limit: 50 },
  },
};

/**
 * Load additional context data for a specific audit type
 *
 * @param {string} auditType - The audit type being enriched
 * @param {string} siteId - Site ID
 * @param {Array} suggestions - Existing suggestions
 * @param {object} dataAccess - Data access layer
 * @param {object} log - Logger
 * @returns {Promise<object>} Additional context data
 */
async function loadAuditContext(auditType, siteId, suggestions, dataAccess, log) {
  const dependencies = AUDIT_DEPENDENCIES[auditType];
  if (!dependencies) {
    log.info(`No additional context needed for audit type: ${auditType}`);
    return null;
  }

  const context = {};

  try {
    // Load top pages if needed
    if (dependencies.topPages) {
      const { SiteTopPage } = dataAccess;
      const { source, geo, limit } = dependencies.topPages;

      log.info(`[ENRICH] Loading top ${limit} pages for ${auditType} enrichment from siteId: ${siteId}, source: ${source}, geo: ${geo}`);
      log.info(`[ENRICH] SiteTopPage type: ${typeof SiteTopPage}, has allBySiteIdAndSourceAndGeo: ${typeof SiteTopPage?.allBySiteIdAndSourceAndGeo}`);

      const topPages = await SiteTopPage.allBySiteIdAndSourceAndGeo(siteId, source, geo);

      log.info(`[ENRICH] Query returned ${topPages ? topPages.length : 0} top pages from DynamoDB`);

      if (topPages && topPages.length > 0) {
        log.info(`[ENRICH] First page URL: ${topPages[0].getUrl ? topPages[0].getUrl() : 'N/A'}`);
      }

      if (!topPages || topPages.length === 0) {
        log.warn(`[ENRICH] No top pages found in database for siteId: ${siteId}. Import may not have run yet.`);
        return null; // Return null if no data, not empty context
      }

      // Limit to requested count and map to plain objects with available fields
      context.topPages = topPages.slice(0, limit).map((page, index) => ({
        url: page.getUrl(),
        traffic: page.getTraffic(),
        topKeyword: page.getTopKeyword(),
        source: page.getSource(),
        rank: index + 1, // Position in top pages list (1-indexed)
      }));

      log.info(`[ENRICH] Successfully loaded ${context.topPages.length} top pages for context`);
    }

    // Future: Add other dependency types here
    // if (dependencies.rumData) { ... }
    // if (dependencies.gscData) { ... }

    // Only return context if it has data
    return Object.keys(context).length > 0 ? context : null;
  } catch (error) {
    log.error(`[ENRICH] Failed to load audit context for ${auditType}: ${error.message}`, error);
    log.error(`[ENRICH] Error stack: ${error.stack}`);
    // Don't fail enrichment if context loading fails
    return null;
  }
}

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

    // Step 3.5: Load additional context data based on audit type
    const additionalContext = await loadAuditContext(
      auditType,
      siteId,
      suggestions,
      dataAccess,
      log,
    );

    if (additionalContext) {
      log.info(`[${requestId}] Loaded additional context: ${Object.keys(additionalContext).join(', ')}`);
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
      // Additional context based on audit type (e.g., top pages for traffic value)
      additionalContext,
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
