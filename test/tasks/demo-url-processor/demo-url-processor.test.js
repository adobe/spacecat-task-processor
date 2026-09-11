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

import { expect } from 'chai';
import sinon from 'sinon';
import { MockContextBuilder } from '../../shared.js';

// Dynamic import for ES modules
let runDemoUrlProcessor;

const IMS_ORG_ID = '8C6043F15F43B6390A49401A@AdobeOrg';

describe('Demo URL Processor', () => {
  let context;
  let message;

  beforeEach(async () => {
    // Dynamic import
    const handlerModule = await import('../../../src/tasks/demo-url-processor/handler.js');
    runDemoUrlProcessor = handlerModule.runDemoUrlProcessor;

    // Reset all stubs
    sinon.restore();

    // Create sandbox
    const sandbox = sinon.createSandbox();

    // Mock context. The Organization record carries the customer brand name
    // ("Dave and Busters"); it must NOT be slugified into the tenant slug.
    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Organization: {
          findById: sandbox.stub().resolves({
            name: 'Dave and Busters',
            imsOrgId: IMS_ORG_ID,
          }),
        },
      })
      .build();

    // Add imsClient to context
    context.imsClient = {
      getImsOrganizationDetails: sandbox.stub().resolves({
        tenantId: 'sitesinternal',
      }),
    };

    context.env.DEFAULT_TENANT_ID = 'sitesinternal';

    // Mock message
    message = {
      siteId: 'test-site-id',
      siteUrl: 'example.com',
      imsOrgId: IMS_ORG_ID,
      organizationId: 'test-org-id',
      taskContext: {
        experienceUrl: 'https://example.com',
        slackContext: {
          channelId: 'test-channel',
          threadTs: 'test-thread',
        },
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  const expectDemoUrl = (tenant) => `https://example.com?organizationId=test-org-id#/@${tenant}/sites-optimizer/sites/test-site-id/home`;

  describe('runDemoUrlProcessor', () => {
    it('logs the processing context', async () => {
      await runDemoUrlProcessor(message, context);
      expect(context.log.info.calledWith('Processing demo url for site:', {
        taskType: 'demo-url-processor',
        siteId: 'test-site-id',
        siteUrl: 'example.com',
        imsOrgId: IMS_ORG_ID,
        experienceUrl: 'https://example.com',
        organizationId: 'test-org-id',
      })).to.be.true;
    });

    it('uses the IMS_ORG_TENANT_ID_MAPPINGS override when present (highest priority)', async () => {
      context.env.IMS_ORG_TENANT_ID_MAPPINGS = JSON.stringify({
        [IMS_ORG_ID]: 'sitesinternal',
      });
      // Even if the IMS lookup would return something else, the mapping wins.
      context.imsClient.getImsOrganizationDetails.resolves({ tenantId: 'some-other-tenant' });

      await runDemoUrlProcessor(message, context);

      expect(context.imsClient.getImsOrganizationDetails.called).to.be.false;
      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('sitesinternal')}`,
      )).to.be.true;
    });

    it('falls back to the IMS org tenantId when no mapping is present', async () => {
      context.imsClient.getImsOrganizationDetails.resolves({ tenantId: 'sitesinternal' });

      await runDemoUrlProcessor(message, context);

      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('sitesinternal')}`,
      )).to.be.true;
    });

    it('ignores a malformed IMS_ORG_TENANT_ID_MAPPINGS and falls back to the IMS org tenantId', async () => {
      context.env.IMS_ORG_TENANT_ID_MAPPINGS = '{ not valid json';
      context.imsClient.getImsOrganizationDetails.resolves({ tenantId: 'sitesinternal' });

      await runDemoUrlProcessor(message, context);

      expect(context.log.error.calledWithMatch(sinon.match('Failed to parse IMS_ORG_TENANT_ID_MAPPINGS'))).to.be.true;
      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('sitesinternal')}`,
      )).to.be.true;
    });

    it('never derives the tenant from the org name: uses DEFAULT_TENANT_ID when the IMS lookup throws', async () => {
      context.imsClient.getImsOrganizationDetails.rejects(new Error('IMS API error'));

      await runDemoUrlProcessor(message, context);

      // The brand name "Dave and Busters" must NOT become the tenant slug.
      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('daveandbusters')}`,
      )).to.be.false;
      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('sitesinternal')}`,
      )).to.be.true;
    });

    it('uses DEFAULT_TENANT_ID when the IMS lookup returns no tenantId', async () => {
      context.imsClient.getImsOrganizationDetails.resolves({});

      await runDemoUrlProcessor(message, context);

      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('sitesinternal')}`,
      )).to.be.true;
    });

    it('handles organization not found', async () => {
      context.dataAccess.Organization.findById.resolves(null);

      await runDemoUrlProcessor(message, context);

      expect(context.log.error.calledWith('Organization not found for organizationId: test-org-id')).to.be.true;
      expect(context.log.info.calledWithMatch(sinon.match('Onboarding setup completed for the site example.com!'))).to.be.false;
    });

    it('continues and still builds the URL when Organization.findById throws', async () => {
      context.env.IMS_ORG_TENANT_ID_MAPPINGS = JSON.stringify({
        [IMS_ORG_ID]: 'sitesinternal',
      });
      context.dataAccess.Organization.findById.rejects(new Error('Database connection failed'));

      await runDemoUrlProcessor(message, context);

      expect(context.log.error.calledWith('Error finding organization for organizationId: test-org-id', sinon.match.any)).to.be.true;
      expect(context.log.info.calledWith(
        `Onboarding setup completed for the site example.com! Access your environment here: ${expectDemoUrl('sitesinternal')}`,
      )).to.be.true;
    });

    it('returns a success result', async () => {
      const result = await runDemoUrlProcessor(message, context);
      expect(result).to.exist;
      expect(result.status).to.equal(200);
      expect(context.log.info.calledWithMatch(sinon.match('Onboarding setup completed for the site example.com!'))).to.be.true;
    });
  });
});
