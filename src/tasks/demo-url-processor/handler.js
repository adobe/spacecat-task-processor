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

import { ok } from '@adobe/spacecat-shared-http-utils';
import { say } from '../../utils/slack-utils.js';

const TASK_TYPE = 'demo-url-processor';

/**
 * Reads the explicit IMS-org-id -> Experience Cloud tenant slug override from
 * the IMS_ORG_TENANT_ID_MAPPINGS secret (a JSON object keyed by IMS org id).
 * @param {string} imsOrgId - The IMS organization ID
 * @param {object} env - The environment object
 * @param {object} log - The logger
 * @returns {string|undefined} The mapped tenant slug, or undefined when absent/unparseable
 */
function getMappedTenantId(imsOrgId, env, log) {
  const raw = env.IMS_ORG_TENANT_ID_MAPPINGS;
  if (!raw) {
    return undefined;
  }
  try {
    const mappings = JSON.parse(raw);
    return mappings?.[imsOrgId];
  } catch (error) {
    log.error(`Failed to parse IMS_ORG_TENANT_ID_MAPPINGS: ${error.message}`);
    return undefined;
  }
}

/**
 * Resolves the Experience Cloud tenant slug for the demo URL.
 *
 * Resolution order:
 *   1. IMS_ORG_TENANT_ID_MAPPINGS[imsOrgId] - explicit, ops-curated override
 *   2. IMS product-context tenant_id (getImsOrganizationDetails)
 *   3. DEFAULT_TENANT_ID
 *
 * The SpaceCat org name is deliberately NOT slugified as a fallback: internally
 * onboarded sites live under the shared "Sites Internal" IMS org, so the org
 * name is the customer brand (e.g. "Dave and Busters") and slugifying it yields
 * a tenant that does not exist in Experience Cloud (e.g. "daveandbusters"),
 * producing a broken deep link. When the tenant cannot be determined we fall
 * back to a known-good default instead.
 *
 * @param {string} imsOrgId - The IMS organization ID
 * @param {object} context - The context object
 * @param {object} slackContext - The Slack context object
 * @returns {Promise<string>} The Experience Cloud tenant slug
 */
async function getImsTenantId(imsOrgId, context, slackContext) {
  const { log, env, imsClient } = context;

  // 1. Explicit ops-curated override (imsOrgId -> tenant slug)
  const mappedTenantId = getMappedTenantId(imsOrgId, env, log);
  if (mappedTenantId) {
    log.info(`Tenant ID resolved from IMS_ORG_TENANT_ID_MAPPINGS: ${mappedTenantId}`);
    return mappedTenantId;
  }

  // 2. IMS product-context tenant_id
  try {
    const imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgId);
    if (imsOrgDetails?.tenantId) {
      log.info(`Tenant ID resolved from IMS org details: ${imsOrgDetails.tenantId}`);
      return imsOrgDetails.tenantId;
    }
    log.warn(`IMS org details returned no tenantId for imsOrgId: ${imsOrgId}`);
  } catch (error) {
    log.error(`Error retrieving IMS Org details: ${error.message}`);
  }

  // 3. Known-good default (never the customer brand name)
  log.error('Falling back to default tenant ID');
  await say(env, log, slackContext, ':warning: Using default tenant ID for demo URL');
  return env.DEFAULT_TENANT_ID;
}

/**
 * Runs the demo URL processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runDemoUrlProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Organization } = dataAccess;
  const {
    siteId, siteUrl, imsOrgId, organizationId, taskContext,
  } = message;
  const {
    experienceUrl, slackContext,
  } = taskContext;

  log.info('Processing demo url for site:', {
    taskType: TASK_TYPE,
    siteId,
    siteUrl,
    imsOrgId,
    experienceUrl,
    organizationId,
  });

  try {
    const organization = await Organization.findById(organizationId);
    if (!organization) {
      log.error(`Organization not found for organizationId: ${organizationId}`);
      if (slackContext) {
        await say(env, log, slackContext, `:x: Organization not found for organizationId: ${organizationId}`);
      }
      return ok({ message: 'Organization not found' });
    }
  } catch (error) {
    log.error(`Error finding organization for organizationId: ${organizationId}`, error);
  }

  // Tenant resolution depends only on the IMS org id, not the org record.
  const imsTenantId = await getImsTenantId(imsOrgId, context, slackContext);

  const demoUrl = `${experienceUrl}?organizationId=${organizationId}#/@${imsTenantId}/sites-optimizer/sites/${siteId}/home`;
  const slackMessage = `:white_check_mark: Onboarding setup completed for the site ${siteUrl}!\nAccess your environment here: ${demoUrl}`;

  if (slackContext) {
    await say(env, log, slackContext, slackMessage);
  }

  log.info(`Onboarding setup completed for the site ${siteUrl}! Access your environment here: ${demoUrl}`);

  return ok({ message: 'Demo URL processor completed' });
}

export default runDemoUrlProcessor;
