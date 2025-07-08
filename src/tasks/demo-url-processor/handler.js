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
 * @param {object} organization - The organization object
 * @param {object} context - The context object
 * @param {object} log - The log object
 * @returns {string} The IMS tenant ID
 */
function getImsTenantId(imsOrgId, organization, context, log) {
  const { name } = organization;
  try {
    const imsOrgToTenantMapping = context.env.IMS_ORG_TENANT_ID_MAPPINGS;
    if (imsOrgToTenantMapping) {
      const mapping = JSON.parse(imsOrgToTenantMapping);
      if (mapping[imsOrgId]) {
        return mapping[imsOrgId];
      }
    }
  } catch (error) {
    log.error('Error loading IMS_ORG_TENANT_ID_MAPPINGS mapping:', error.message);
  }
  if (!name) {
    log.error('Organization name is missing, using default tenant ID');
    return context.env.DEFAULT_TENANT_ID;
  } else {
    return name.toLowerCase().replace(/\s+/g, '');
  }
}

/**
 * Runs the audit status processor
 * @param {object} demoUrlMessage - The demoUrlMessage object
 * @param {object} context - The context object
 */
export async function runDemoUrlProcessor(message, context) {
  const { log, env, dataAccess } = context;
  const { Organization } = dataAccess;
  const {
    siteId, imsOrgId, organizationId, taskContext,
  } = message;
  const {
    experienceUrl, slackContext,
  } = taskContext;

  log.info('Processing demo url for site:', {
    taskType: TASK_TYPE,
    siteId,
    experienceUrl,
    organizationId,
  });

  const organization = await Organization.findById(organizationId);
  if (!organization) {
    log.error(`Organization not found for organizationId: ${organizationId}`);
    await say(env, log, slackContext, `:x: Organization not found for organizationId: ${organizationId}`);
    return ok({ message: 'Organization not found' });
  }

  const imsTenantId = getImsTenantId(imsOrgId, organization, context, log);
  const demoUrl = `${experienceUrl}?organizationId=${organizationId}#/@${imsTenantId}/sites-optimizer/sites/${siteId}/home`;
  const slackMessage = `:white_check_mark: Setup complete! Access your demo environment here: ${demoUrl}`;
  await say(env, log, slackContext, slackMessage);
  log.info(`Setup complete! Access your demo environment here: ${demoUrl}`);

  return ok({ message: 'Demo URL processor completed' });
}

export default runDemoUrlProcessor;
