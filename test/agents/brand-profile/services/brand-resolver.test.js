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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import {
  splitHost,
  isLowConfidenceLabel,
  fetchSiteName,
  resolveBrandName,
} from '../../../../src/agents/brand-profile/services/brand-resolver.js';

use(sinonChai);
use(chaiAsPromised);

const htmlResponse = (html) => ({
  ok: true,
  headers: { get: () => 'text/html; charset=utf-8' },
  text: () => Promise.resolve(html),
});

describe('services/brand-resolver', () => {
  let sandbox;
  let log;
  let fetchStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    fetchStub = sandbox.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('splitHost', () => {
    it('strips a subdomain to the apex label', () => {
      expect(splitHost('dev.amrize.com')).to.deep.equal({
        subdomainLabels: ['dev'],
        apexLabel: 'amrize',
        registrableDomain: 'amrize.com',
      });
    });

    it('handles multi-part ccTLDs (co.jp)', () => {
      expect(splitHost('dnp.co.jp')).to.deep.equal({
        subdomainLabels: [],
        apexLabel: 'dnp',
        registrableDomain: 'dnp.co.jp',
      });
    });

    it('handles multi-part ccTLDs with a subdomain (gov.sg)', () => {
      expect(splitHost('www.edb.gov.sg')).to.deep.equal({
        subdomainLabels: ['www'],
        apexLabel: 'edb',
        registrableDomain: 'edb.gov.sg',
      });
    });

    it('generalizes unlisted <generic>.<ccTLD> suffixes so they never collapse to the bare suffix (LLMO-6580)', () => {
      // None of these ccTLD second-levels are in MULTI_PART_TLDS; the generic-second-level
      // rule must still keep a registrable label in front of the suffix.
      expect(splitHost('maybank.com.my')).to.deep.equal({
        subdomainLabels: [],
        apexLabel: 'maybank',
        registrableDomain: 'maybank.com.my',
      });
      expect(splitHost('www.pttep.co.th')).to.deep.equal({
        subdomainLabels: ['www'],
        apexLabel: 'pttep',
        registrableDomain: 'pttep.co.th',
      });
      expect(splitHost('nic.gov.in')).to.deep.equal({
        subdomainLabels: [],
        apexLabel: 'nic',
        registrableDomain: 'nic.gov.in',
      });
    });

    it('does not treat a non-generic second-level before a ccTLD as multi-part (ab.co)', () => {
      // 'ab' is not a generic second-level, so 'ab.co' stays the registrable domain.
      expect(splitHost('sub.ab.co')).to.deep.equal({
        subdomainLabels: ['sub'],
        apexLabel: 'ab',
        registrableDomain: 'ab.co',
      });
    });

    it('strips a section subdomain (store)', () => {
      const { apexLabel } = splitHost('store.example.com');
      expect(apexLabel).to.equal('example');
    });

    it('handles a plain apex domain', () => {
      expect(splitHost('www.ab.co')).to.deep.equal({
        subdomainLabels: ['www'],
        apexLabel: 'ab',
        registrableDomain: 'ab.co',
      });
    });

    it('handles a single-label host', () => {
      expect(splitHost('localhost')).to.deep.equal({
        subdomainLabels: [],
        apexLabel: 'localhost',
        registrableDomain: 'localhost',
      });
    });

    it('handles an empty host', () => {
      expect(splitHost('')).to.deep.equal({
        subdomainLabels: [],
        apexLabel: '',
        registrableDomain: '',
      });
    });

    it('lowercases and trims a trailing dot', () => {
      expect(splitHost('Amrize.COM.')).to.deep.equal({
        subdomainLabels: [],
        apexLabel: 'amrize',
        registrableDomain: 'amrize.com',
      });
    });
  });

  describe('isLowConfidenceLabel', () => {
    it('flags short acronyms', () => {
      expect(isLowConfidenceLabel('dnp')).to.equal(true);
      expect(isLowConfidenceLabel('edb')).to.equal(true);
      expect(isLowConfidenceLabel('dnb')).to.equal(true);
      expect(isLowConfidenceLabel('IBM')).to.equal(true); // short: relies on P856 downstream
    });

    it('flags stop labels', () => {
      expect(isLowConfidenceLabel('dev')).to.equal(true);
      expect(isLowConfidenceLabel('www')).to.equal(true);
      expect(isLowConfidenceLabel('store')).to.equal(true);
    });

    it('accepts real multi-character brand tokens', () => {
      expect(isLowConfidenceLabel('amrize')).to.equal(false);
      expect(isLowConfidenceLabel('testcompany')).to.equal(false);
    });

    it('flags empty/nullish labels', () => {
      expect(isLowConfidenceLabel('')).to.equal(true);
      expect(isLowConfidenceLabel(null)).to.equal(true);
    });
  });

  describe('fetchSiteName', () => {
    it('returns og:site_name when present', async () => {
      fetchStub.resolves(htmlResponse('<html><head><meta property="og:site_name" content="Amrize"></head></html>'));
      const result = await fetchSiteName('https://amrize.com', log);
      expect(result).to.equal('Amrize');
    });

    it('falls back to a cleaned <title>', async () => {
      fetchStub.resolves(htmlResponse('<html><head><title>Acme Corporation | Home</title></head></html>'));
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.equal('Acme Corporation');
    });

    it('falls back to the first segment when every title segment is generic', async () => {
      fetchStub.resolves(htmlResponse('<html><head><meta property="og:site_name" content="Home | Welcome"></head></html>'));
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.equal('Home');
    });

    it('returns null when neither og:site_name nor title present', async () => {
      fetchStub.resolves(htmlResponse('<html><head></head><body>hi</body></html>'));
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.be.null;
    });

    it('returns null for non-HTML content types', async () => {
      fetchStub.resolves({
        ok: true,
        headers: { get: () => 'application/pdf' },
        text: () => Promise.resolve('%PDF-1.4'),
      });
      const result = await fetchSiteName('https://acme.com/file.pdf', log);
      expect(result).to.be.null;
    });

    it('returns null when the response is not ok', async () => {
      fetchStub.resolves({ ok: false, status: 403, headers: { get: () => 'text/html' } });
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.be.null;
    });

    it('returns null on network error (never throws)', async () => {
      fetchStub.rejects(new Error('ECONNRESET'));
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.be.null;
      expect(log.info).to.have.been.calledWithMatch('homepage fetch failed');
    });

    it('tolerates a response without a headers object', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('<html><head><meta property="og:site_name" content="NoHeaders"></head></html>'),
      });
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.equal('NoHeaders');
    });

    it('tolerates a headers object without a get method', async () => {
      fetchStub.resolves({
        ok: true,
        headers: {},
        text: () => Promise.resolve('<html><head><title>HasHeadersNoGet</title></head></html>'),
      });
      const result = await fetchSiteName('https://acme.com', log);
      expect(result).to.equal('HasHeadersNoGet');
    });
  });

  describe('resolveBrandName', () => {
    it('uses main_profile.brand_name (high confidence, no fetch)', async () => {
      const result = await resolveBrandName(
        { main_profile: { brand_name: 'Adobe' } },
        'https://adobe.com',
        log,
      );
      expect(result).to.include({
        name: 'Adobe', confidence: 'high', source: 'base_profile', registrableDomain: 'adobe.com',
      });
      expect(fetchStub).to.not.have.been.called;
    });

    it('uses competitive_context.brand_name when main_profile missing', async () => {
      const result = await resolveBrandName(
        { main_profile: {}, competitive_context: { brand_name: 'ContextBrand' } },
        'https://example.com',
        log,
      );
      expect(result).to.include({ name: 'ContextBrand', confidence: 'high', source: 'competitive_context' });
    });

    it('uses a real site title as high confidence', async () => {
      fetchStub.resolves(htmlResponse('<html><head><meta property="og:site_name" content="Amrize | Home"></head></html>'));
      const result = await resolveBrandName({ main_profile: {} }, 'https://dev.amrize.com', log);
      expect(result).to.include({ name: 'Amrize', confidence: 'high', source: 'site_title' });
    });

    it('falls back to the apex label as medium confidence', async () => {
      fetchStub.resolves({ ok: false, status: 404, headers: { get: () => 'text/html' } });
      const result = await resolveBrandName({ main_profile: {} }, 'https://testcompany.com', log);
      expect(result).to.include({ name: 'Testcompany', confidence: 'medium', source: 'apex_domain' });
    });

    it('REGRESSION: a bare acronym apex stays LOW confidence, never high', async () => {
      fetchStub.rejects(new Error('bot-blocked'));
      const result = await resolveBrandName({ main_profile: {} }, 'https://dnp.co.jp', log);
      expect(result).to.include({
        name: 'Dnp', confidence: 'low', source: 'apex_acronym', registrableDomain: 'dnp.co.jp',
      });
    });

    it('skips a low-confidence site title and falls through to apex', async () => {
      fetchStub.resolves(htmlResponse('<html><head><title>ab</title></head></html>'));
      const result = await resolveBrandName({ main_profile: {} }, 'https://amrize.com', log);
      expect(result).to.include({ name: 'Amrize', confidence: 'medium', source: 'apex_domain' });
    });

    it('returns the Unknown Brand sentinel when the URL cannot be parsed', async () => {
      fetchStub.rejects(new Error('bad url'));
      const result = await resolveBrandName({ main_profile: {} }, 'not-a-url', log);
      expect(result).to.include({
        name: 'Unknown Brand', confidence: 'low', source: 'none', siteHost: '',
      });
    });
  });
});
