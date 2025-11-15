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
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

export function readPromptFile(importMetaUrl, relPath) {
  const filename = fileURLToPath(importMetaUrl);
  const dirname = path.dirname(filename);
  const fullPath = path.resolve(dirname, relPath);
  return readFileSync(fullPath, 'utf-8');
}

export function renderTemplate(template, vars = {}) {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}
