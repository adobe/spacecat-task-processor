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
 * Runs the demo url processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runDemoUrlProcessor(message, context) {
  const { log, env } = context;
  const { siteId, organizationId, taskContext } = message;
  const {
    siteUrl, slackContext,
  } = taskContext;

  log.info('Processing demo url for site:', {
    taskType: TASK_TYPE,
    siteId,
    siteUrl,
    organizationId,
  });

  const demoUrl = `${siteUrl}?organizationId=${organizationId}#/@aemrefdemoshared/sites-optimizer/sites/${siteId}/home`;
  const slackMessage = `:white_check_mark: Setup complete! Access your demo environment here: ${demoUrl}`;
  await say(env, log, slackContext, slackMessage);
  log.info(`Setup complete! Access your demo environment here: ${demoUrl}`);

  return ok({ message: 'Demo URL processor completed' });
}

export default runDemoUrlProcessor;
