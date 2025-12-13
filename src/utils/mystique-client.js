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

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

const sqsClient = new SQSClient({});

/**
 * Send enrichment request to Mystique
 *
 * @param {string} inboundQueueUrl - Mystique inbound queue URL
 * @param {object} payload - Enrichment request payload
 * @param {string} payload.requestId - Unique request ID for matching
 * @param {object} log - Logger instance
 * @returns {Promise<void>}
 */
export async function sendToMystique(inboundQueueUrl, payload, log) {
  try {
    log.info(`[${payload.requestId}] Sending enrichment request to Mystique`);

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: inboundQueueUrl,
      MessageBody: JSON.stringify(payload),
      MessageAttributes: {
        requestId: {
          DataType: 'String',
          StringValue: payload.requestId,
        },
      },
    }));

    log.info(`[${payload.requestId}] Request sent to Mystique successfully`);
  } catch (error) {
    log.error(`[${payload.requestId}] Failed to send to Mystique: ${error.message}`, error);
    throw error;
  }
}

/**
 * Poll Mystique outbound queue for response
 *
 * Uses long polling (5s wait) and checks up to 10 messages per poll.
 * Ignores non-matching messages (leaves them in queue).
 * Deletes matching message once found.
 *
 * @param {string} outboundQueueUrl - Mystique outbound queue URL
 * @param {string} requestId - Request ID to match
 * @param {object} log - Logger instance
 * @param {number} maxWaitSeconds - Maximum time to wait (default: 120 seconds)
 * @returns {Promise<object|null>} - Enriched result or null if timeout
 */
export async function pollMystiqueResponse(
  outboundQueueUrl,
  requestId,
  log,
  maxWaitSeconds = 120,
) {
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  log.info(`[${requestId}] Polling for Mystique response (max: ${maxWaitSeconds}s)`);

  let pollCount = 0;

  // eslint-disable-next-line no-await-in-loop
  while ((Date.now() - startTime) < maxWaitMs) {
    pollCount += 1;

    try {
      const receiveCommand = new ReceiveMessageCommand({
        QueueUrl: outboundQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5, // Long polling
        MessageAttributeNames: ['All'],
        AttributeNames: ['All'],
      });

      // eslint-disable-next-line no-await-in-loop
      const response = await sqsClient.send(receiveCommand);

      if (!response.Messages || response.Messages.length === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log.debug(`[${requestId}] Poll #${pollCount}: No messages (elapsed: ${elapsed}s)`);
        // eslint-disable-next-line no-continue
        continue;
      }

      log.debug(`[${requestId}] Poll #${pollCount}: Received ${response.Messages.length} messages`);

      // Check each message for our requestId
      for (const msg of response.Messages) {
        let messageBody;
        try {
          messageBody = JSON.parse(msg.Body);
        } catch (parseError) {
          log.warn(`[${requestId}] Failed to parse message: ${parseError.message}`);
          // eslint-disable-next-line no-continue
          continue;
        }

        const msgRequestId = messageBody.requestId;

        if (msgRequestId === requestId) {
          log.info(`[${requestId}] ✅ Found matching response after ${pollCount} polls`);

          // Delete the message from queue
          try {
            // eslint-disable-next-line no-await-in-loop
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: outboundQueueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }));
            log.debug(`[${requestId}] Deleted message from queue`);
          } catch (deleteError) {
            log.warn(`[${requestId}] Failed to delete message: ${deleteError.message}`);
          }

          // Check for error status
          if (messageBody.status === 'error') {
            throw new Error(`Mystique error: ${messageBody.error || 'Unknown error'}`);
          }

          return messageBody;
        }

        log.debug(`[${requestId}] Ignoring message with requestId: ${msgRequestId}`);
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log.debug(`[${requestId}] No match yet after poll #${pollCount} (elapsed: ${elapsed}s)`);
    } catch (error) {
      log.error(`[${requestId}] Error during poll #${pollCount}: ${error.message}`);
      // Continue polling even if one poll fails
    }
  }

  log.error(`[${requestId}] ⏱️ Timeout after ${pollCount} polls (${maxWaitSeconds}s). No response from Mystique`);
  return null;
}

/* c8 ignore stop */
