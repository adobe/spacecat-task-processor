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
import sinon from 'sinon';
import { MockContextBuilder } from '../../shared.js';

// Dynamic import for ES modules
let runDemoUrlProcessor;

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

    // Mock context
    context = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Organization: {
          findById: sandbox.stub().resolves({
            name: 'Adobe Sites Engineering',
            tenantId: 'adobe-sites-engineering',
            imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
          }),
        },
      })
      .build();

    // Add imsClient to context
    context.imsClient = {
      getImsOrganizationDetails: sandbox.stub().resolves({
        tenantId: 'ims-tenant-id',
      }),
    };

    // Mock message
    message = {
      siteId: 'test-site-id',
      siteUrl: 'example.com',
      imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
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

  describe('runDemoUrlProcessor', () => {
    it('should process demo URL successfully', async () => {
      // Set up the IMS_ORG_TENANT_ID_MAPPINGS secret in context
      context.env.IMS_ORG_TENANT_ID_MAPPINGS = JSON.stringify({
        '8C6043F15F43B6390A49401A@AdobeOrg': 'aem-sites-engineering',
      });

      await runDemoUrlProcessor(message, context);
      expect(context.log.info.calledWith('Processing demo url for site:', {
        taskType: 'demo-url-processor',
        siteId: 'test-site-id',
        siteUrl: 'example.com',
        imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
        experienceUrl: 'https://example.com',
        organizationId: 'test-org-id',
      })).to.be.true;
      const expectedDemoUrl = 'https://example.com?organizationId=test-org-id#/@adobe-sites-engineering/sites-optimizer/sites/test-site-id/home';
      expect(context.log.info.calledWith(`Onboarding setup completed successfully for the site example.com! Access your environment here: ${expectedDemoUrl}`)).to.be.true;
    });

    it('should handle organization not found error', async () => {
      // Mock Organization.findById to return null
      context.dataAccess.Organization.findById.resolves(null);

      await runDemoUrlProcessor(message, context);

      // Should log error and return early
      expect(context.log.error.calledWith('Organization not found for organizationId: test-org-id')).to.be.true;
      // Should not log the success message
      expect(context.log.info.calledWithMatch(sinon.match('Onboarding setup completed successfully for the site example.com!'))).to.be.false;
    });

    it('should use tenantId when available (highest priority)', async () => {
      // Mock Organization.findById to return organization with tenantId
      context.dataAccess.Organization.findById.resolves({
        name: 'Adobe Sites Engineering',
        tenantId: 'adobe-sites-engineering',
        imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
      });

      await runDemoUrlProcessor(message, context);

      // Should use the tenantId (highest priority)
      const expectedDemoUrl = 'https://example.com?organizationId=test-org-id#/@adobe-sites-engineering/sites-optimizer/sites/test-site-id/home';
      expect(context.log.info.calledWith(`Onboarding setup completed successfully for the site example.com! Access your environment here: ${expectedDemoUrl}`)).to.be.true;
    });

    it('should fallback to name when tenantId is missing (backward compatibility)', async () => {
      // Mock Organization.findById to return organization with name but no tenantId
      context.dataAccess.Organization.findById.resolves({
        name: 'Adobe Sites Engineering',
        imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
        // tenantId property is missing
      });

      // Mock imsClient to fail so it falls back to name
      context.imsClient.getImsOrganizationDetails.rejects(new Error('IMS API error'));

      await runDemoUrlProcessor(message, context);

      // Should use the name-based tenant (lowercase, no spaces) as fallback
      const expectedDemoUrl = 'https://example.com?organizationId=test-org-id#/@adobesitesengineering/sites-optimizer/sites/test-site-id/home';
      expect(context.log.info.calledWith(`Onboarding setup completed successfully for the site example.com! Access your environment here: ${expectedDemoUrl}`)).to.be.true;
    });

    it('should fallback to DEFAULT_TENANT_ID when both name and tenantId are missing', async () => {
      // Mock Organization.findById to return organization without name and tenantId
      context.dataAccess.Organization.findById.resolves({
        imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
        // name and tenantId properties are missing
      });

      // Mock imsClient to fail so it falls back to DEFAULT_TENANT_ID
      context.imsClient.getImsOrganizationDetails.rejects(new Error('IMS API error'));

      // Set default tenant ID
      context.env.DEFAULT_TENANT_ID = 'default-tenant';

      await runDemoUrlProcessor(message, context);

      // Should log error about using default tenant ID
      expect(context.log.error.calledWith('Using default tenant ID')).to.be.true;
      const expectedDemoUrl = 'https://example.com?organizationId=test-org-id#/@default-tenant/sites-optimizer/sites/test-site-id/home';
      expect(context.log.info.calledWith(`Onboarding setup completed successfully for the site example.com! Access your environment here: ${expectedDemoUrl}`)).to.be.true;
    });

    it('should return success message when processing completes', async () => {
      // Set up the IMS_ORG_TENANT_ID_MAPPINGS secret in context
      context.env.IMS_ORG_TENANT_ID_MAPPINGS = JSON.stringify({
        '8C6043F15F43B6390A49401A@AdobeOrg': 'aem-sites-engineering',
      });

      // The function should complete without throwing an error
      await runDemoUrlProcessor(message, context);

      // Verify that the success message was logged
      expect(context.log.info.calledWithMatch(sinon.match('Onboarding setup completed successfully for the site example.com!'))).to.be.true;
    });

    it('should handle error when Organization.findById throws an exception', async () => {
      // Set up the IMS_ORG_TENANT_ID_MAPPINGS secret in context
      context.env.IMS_ORG_TENANT_ID_MAPPINGS = JSON.stringify({
        '8C6043F15F43B6390A49401A@AdobeOrg': 'aem-sites-engineering',
      });

      // Mock Organization.findById to throw an error
      context.dataAccess.Organization.findById.rejects(new Error('Database connection failed'));

      // The function should handle the error gracefully without throwing
      await runDemoUrlProcessor(message, context);

      // Verify that the error was logged
      expect(context.log.error.calledWith('Error finding organization for organizationId: test-org-id', sinon.match.any)).to.be.true;

      // Note: The current implementation continues execution even after errors,
      // so the success message will still be logged. This test verifies that
      // the error handling works and the function completes successfully.

      // Verify that the success message was still logged (since the function continues)
      expect(context.log.info.calledWithMatch(sinon.match('Onboarding setup completed successfully for the site example.com!'))).to.be.true;

      // Verify that the processing log was recorded
      expect(context.log.info.calledWith('Processing demo url for site:', {
        taskType: 'demo-url-processor',
        siteId: 'test-site-id',
        siteUrl: 'example.com',
        imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
        experienceUrl: 'https://example.com',
        organizationId: 'test-org-id',
      })).to.be.true;
    });
  });
});
