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
import {
  internalServerError,
  notFound,
  ok,
  badRequest,
} from '@adobe/spacecat-shared-http-utils';
import { imsClientWrapper } from '@adobe/spacecat-shared-ims-client';
import { isNonEmptyObject, sqsEventAdapter } from '@adobe/spacecat-shared-utils';

import { runOpportunityStatusProcessor as opportunityStatusProcessor } from './tasks/opportunity-status-processor/handler.js';
import { runDisableImportAuditProcessor as disableImportAuditProcessor } from './tasks/disable-import-audit-processor/handler.js';
import { runDemoUrlProcessor as demoUrlProcessor } from './tasks/demo-url-processor/handler.js';
import { runCwvDemoSuggestionsProcessor as cwvDemoSuggestionsProcessor } from './tasks/cwv-demo-suggestions-processor/handler.js';
import { runAgentExecutor as agentExecutor } from './tasks/agent-executor/handler.js';
import { runSlackNotify as slackNotify } from './tasks/slack-notify/handler.js';

const HANDLERS = {
  'opportunity-status-processor': opportunityStatusProcessor,
  'disable-import-audit-processor': disableImportAuditProcessor,
  'demo-url-processor': demoUrlProcessor,
  'agent-executor': agentExecutor,
  'slack-notify': slackNotify,
  'cwv-demo-suggestions-processor': cwvDemoSuggestionsProcessor,
  dummy: (message) => ok(message), // for tests
};

// Custom secret name resolver to use the correct secret path
function getSecretName() {
  return '/helix-deploy/spacecat-services/task-manager/latest';
}

// Export for testing
export { getSecretName };

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
async function processTask(message, context) {
  const { log } = context;
  const { type, siteId } = message;

  // Debug: Log the message structure
  log.info('processTask() received:', {
    messageKeys: Object.keys(message || {}),
    type,
    siteId,
    agentId: message?.agentId,
    hasTaskContext: !!message?.taskContext,
    hasSlackContext: !!message?.taskContext?.slackContext || !!message?.slackContext,
  });

  log.info(`Received message with type: ${type} for site: ${siteId}`);

  const handler = HANDLERS[type];
  if (!handler) {
    const msg = `no such task type: ${type}`;
    log.error(msg);
    return notFound();
  }
  log.info(`Found task handler for type: ${type}`);

  const startTime = process.hrtime();

  try {
    const result = await handler(message, context);
    log.info(`${type} task for ${siteId} completed in ${getElapsedSeconds(startTime)} seconds`);
    return result;
  } catch (e) {
    log.error(`${type} task for ${siteId} failed after ${getElapsedSeconds(startTime)} seconds. `, e);
    return internalServerError();
  }
}

const runSQS = wrap(processTask)
  .with(dataAccess)
  .with(imsClientWrapper)
  .with(secrets, { name: getSecretName })
  .with(helixStatus)
  .with(sqsEventAdapter);

const runDirect = wrap(processTask)
  .with(dataAccess)
  .with(imsClientWrapper)
  .with(secrets, { name: getSecretName })
  .with(helixStatus);

function isSqsEvent(event, context) {
  // Check top-level Records (unwrapped SQS events)
  if (Array.isArray(event?.Records)) {
    return true;
  }

  // Check context.invocation.event.Records (wrapped SQS events)
  // SQS Records have a messageId field, direct invocations have a type field
  const invocationEvent = context?.invocation?.event;
  if (Array.isArray(invocationEvent?.Records) && invocationEvent.Records[0]?.messageId) {
    return true; // It's an SQS event
  }

  // If invocationEvent has a 'type' field, it's a direct invocation, not SQS
  if (invocationEvent?.type) {
    return false;
  }

  return false;
}

export const main = async (event, context) => {
  // Debug: Log what we're receiving
  const invocationEvent = context?.invocation?.event;
  context?.log?.info?.('main() invoked:', {
    eventKeys: Object.keys(event || {}),
    hasRecordsInEvent: !!event?.Records,
    invocationEventKeys: invocationEvent ? Object.keys(invocationEvent) : [],
    invocationEventType: invocationEvent?.type,
    invocationEventAgentId: invocationEvent?.agentId,
    hasMessageId: !!invocationEvent?.Records?.[0]?.messageId,
    isSqsDetected: isSqsEvent(event, context),
  });

  if (isSqsEvent(event, context)) {
    context?.log?.info?.('Routing to runSQS (SQS event detected)');
    return runSQS(event, context);
  }

  context?.log?.info?.('Routing to runDirect (direct invocation detected)');
  const payload = context?.invocation?.event;
  if (!isNonEmptyObject(payload)) {
    context?.log?.warn?.('Direct invocation missing payload');
    return badRequest('Event does not contain a valid message body');
  }

  context?.log?.info?.('runDirect payload:', {
    payloadKeys: Object.keys(payload),
    type: payload.type,
    agentId: payload.agentId,
  });

  return runDirect(payload, context);
};
