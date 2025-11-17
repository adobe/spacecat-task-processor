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

/* eslint-env mocha */

import { expect } from 'chai';
import path from 'path';
import fs from 'fs';

import { readPromptFile, renderTemplate } from '../../src/agents/base.js';

describe('agents/base utilities', () => {
  describe('renderTemplate', () => {
    it('replaces known placeholders with provided values', () => {
      const tpl = 'Hello {{ name }}, URL={{url}}. Twice: {{name}}.';
      const out = renderTemplate(tpl, { name: 'World', url: 'https://example.com' });
      expect(out).to.equal('Hello World, URL=https://example.com. Twice: World.');
    });

    it('replaces missing placeholders with empty string', () => {
      const tpl = 'A={{a}}, B={{b}}, MISSING={{missing}}';
      const out = renderTemplate(tpl, { a: 'x', b: 'y' });
      expect(out).to.equal('A=x, B=y, MISSING=');
    });

    it('coerces non-string values via String()', () => {
      const tpl = 'N={{n}}, BOOL={{flag}}, OBJ={{obj}}';
      const out = renderTemplate(tpl, {
        n: 42,
        flag: true,
        obj: { a: 1 },
      });
      expect(out).to.equal('N=42, BOOL=true, OBJ=[object Object]');
    });
  });

  describe('readPromptFile', () => {
    const unlink = (filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch (e) { /* ignore */ }
    };

    it('reads a file via relative path against static prompt dirname', () => {
      const relName = 'tmp.prompt';
      const absPath = path.resolve(process.cwd(), 'static/prompts/', relName);
      const content = 'relative content';
      try {
        fs.writeFileSync(absPath, content, 'utf-8');
        const read = readPromptFile('./tmp.prompt');
        expect(read).to.equal(content);
      } finally {
        unlink(absPath);
      }
    });
  });
});
