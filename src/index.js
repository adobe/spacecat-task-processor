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
import wrap from '@adobe/helix-shared-wrap';
import { helixStatus } from '@adobe/helix-status';
import secrets from '@adobe/helix-shared-secrets';
import dataAccess from '@adobe/spacecat-shared-data-access';
import { sqsEventAdapter } from '@adobe/spacecat-shared-utils';
import { internalServerError, notFound, ok } from '@adobe/spacecat-shared-http-utils';

import { runOpportunityStatusProcessor as opportunityStatusProcessor } from './tasks/opportunity-status-processor/handler.js';
import { runDisableImportAuditProcessor as disableImportAuditProcessor } from './tasks/disable-import-audit-processor/handler.js';
import { runDemoUrlProcessor as demoUrlProcessor } from './tasks/demo-url-processor/handler.js';

const HANDLERS = {
  'opportunity-status-processor': opportunityStatusProcessor,
  'disable-import-audit-processor': disableImportAuditProcessor,
  'demo-url-processor': demoUrlProcessor,
  dummy: (message) => ok(message),
};

// Custom secret name resolver to use the correct secret path
function getSecretName() {
  return '/helix-deploy/spacecat-services/api-service/latest';
}

function getElapsedSeconds(startTime) {
  const endTime = process.hrtime(startTime);
  const elapsedSeconds = endTime[0] + endTime[1] / 1e9;
  return elapsedSeconds.toFixed(2);
}

/**
 * This is the main function
 * @param {object} message the message object received from SQS
 * @param {UniversalContext} context the context of the universal serverless function
 * @returns {Response} a response
 */
async function run(message, context) {
  const { log } = context;
  const { type, siteId } = message;

  log.info(`Received message with type: ${type} for site: ${siteId}`);
  log.info('Message structure:', {
    messageKeys: Object.keys(message),
    messageValues: Object.entries(message).reduce((acc, [key, value]) => {
      acc[key] = typeof value === 'object' ? JSON.stringify(value) : value;
      return acc;
    }, {}),
  });

  const handler = HANDLERS[type];
  if (!handler) {
    const msg = `no such audit type: ${type}`;
    log.error(msg);
    return notFound();
  }

  log.info(`Found handler for type: ${type}`);
  log.info('Handler details:', {
    handler,
    hasRun: typeof handler.run === 'function',
    hasExecute: typeof handler.execute === 'function',
    handlerKeys: Object.keys(handler),
    handlerType: typeof handler,
    handlerString: handler.toString(),
  });

  const startTime = process.hrtime();

  try {
    const result = await handler(message, context);
    log.info(`${type} audit for ${siteId} completed in ${getElapsedSeconds(startTime)} seconds`);
    return result;
  } catch (e) {
    log.error(`${type} audit for ${siteId} failed after ${getElapsedSeconds(startTime)} seconds. `, e);
    return internalServerError();
  }
}

export const main = wrap(run)
  .with(dataAccess)
  .with(sqsEventAdapter)
  .with(secrets, { name: getSecretName })
  .with(helixStatus);
