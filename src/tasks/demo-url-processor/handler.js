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
 * Gets the IMS tenant ID from the organization
 * @param {string} imsOrgId - The IMS organization ID
 * @param {object} organization - The organization object
 * @param {object} context - The context object
 * @param {object} slackContext - The Slack context object
 * @returns {string} The IMS tenant ID
 */
async function getImsTenantId(imsOrgId, organization, context, slackContext) {
  // Get tenantId from organization
  const { name, tenantId } = organization;
  const { log, env, imsClient } = context;
  if (tenantId) {
    log.info(`Tenant ID found in organization: ${tenantId}`);
    return tenantId;
  } else {
    // Get tenantId from IMS org details if tenantId is not there in organization
    let imsOrgDetails;
    try {
      imsOrgDetails = await imsClient.getImsOrganizationDetails(imsOrgId);
      log.info(`IMS Org Details - tenantId: ${imsOrgDetails.tenantId}`);
      return imsOrgDetails.tenantId;
    } catch (error) {
      log.error(`Error retrieving IMS Org details: ${error.message}`);
    }
  }
  // As a fallback option, use name to generate tenant id (backward compatible for existing orgs)
  if (name) {
    log.info(`Using organization name to generate tenant ID: ${name}`);
    return name.toLowerCase().replace(/\s+/g, '');
  }
  log.error('Using default tenant ID');
  await say(env, log, slackContext, ':x: Using default tenant ID');
  return context.env.DEFAULT_TENANT_ID;
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
    experienceUrl, profile, slackContext,
  } = taskContext || {};

  log.info('Processing demo url for site:', {
    taskType: TASK_TYPE,
    siteId,
    siteUrl,
    imsOrgId,
    experienceUrl,
    organizationId,
    profile,
  });

  let imsTenantId = context.env.DEFAULT_TENANT_ID;
  try {
    const organization = await Organization.findById(organizationId);
    if (!organization) {
      log.error(`Organization not found for organizationId: ${organizationId}`);
      if (slackContext) {
        await say(env, log, slackContext, `:x: Organization not found for organizationId: ${organizationId}`);
      }
      return ok({ message: 'Organization not found' });
    }
    imsTenantId = await getImsTenantId(imsOrgId, organization, context, slackContext);
  } catch (error) {
    log.error(`Error finding organization for organizationId: ${organizationId}`, error);
  }

  const demoUrl = `${experienceUrl}?organizationId=${organizationId}#/@${imsTenantId}/sites-optimizer/sites/${siteId}/home`;
  const slackMessage = `:white_check_mark: Onboarding setup completed successfully for the site ${siteUrl}!\nAccess your environment here: ${demoUrl}`;

  if (slackContext) {
    await say(env, log, slackContext, slackMessage);
  }

  // Log onboarding completion with profile for metrics tracking
  log.info('Onboarding setup completed for site with profile:', {
    siteId,
    profile,
    organizationId,
  });

  return ok({ message: 'Demo URL processor completed' });
}

export default runDemoUrlProcessor;
