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

import { GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * Retrieves an object from S3 using its key
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client - an S3 client
 * @param {string} bucketName - the name of the S3 bucket
 * @param {string} key - the key of the S3 object
 * @param {import('@azure/logger').Logger} log - a logger instance
 * @returns {Promise<Object|string|null>} - the parsed content (JSON) or raw content (string)
 */
export async function getObjectFromKey(s3Client, bucketName, key, log) {
  if (!s3Client || !bucketName || !key) {
    log.error(
      'Invalid input parameters in getObjectFromKey: ensure s3Client, bucketName, and key are provided.',
    );
    return null;
  }

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  try {
    const response = await s3Client.send(command);
    const contentType = response.ContentType;
    const body = await response.Body.transformToString();

    if (contentType && contentType.includes('application/json')) {
      try {
        return JSON.parse(body);
      } catch (parseError) {
        log.error(`Unable to parse JSON content for key ${key}`, parseError);
        return null;
      }
    }

    // Return raw body for non-JSON content types
    return body;
  } catch (err) {
    log.error(
      `Error while fetching S3 object from bucket ${bucketName} using key ${key}`,
      err,
    );
    return null;
  }
}
