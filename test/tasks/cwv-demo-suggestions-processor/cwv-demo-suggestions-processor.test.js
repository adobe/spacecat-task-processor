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
let runCwvDemoSuggestionsProcessor;

describe('CWV Demo Suggestions Processor Task', () => {
  let sandbox;
  let mockContext;
  let mockSite;
  let mockOpportunity;
  let mockSuggestions;
  let mockSuggestionDataAccess;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Import the function to test
    const module = await import('../../../src/tasks/cwv-demo-suggestions-processor/handler.js');
    runCwvDemoSuggestionsProcessor = module.runCwvDemoSuggestionsProcessor;

    // Mock Suggestion data access
    mockSuggestionDataAccess = {
      findById: sandbox.stub(),
    };

    // Mock context using MockContextBuilder
    mockContext = new MockContextBuilder()
      .withSandbox(sandbox)
      .withDataAccess({
        Site: {
          findById: sandbox.stub(),
        },
        Suggestion: mockSuggestionDataAccess,
      })
      .build();

    // Mock site
    mockSite = {
      getOpportunities: sandbox.stub(),
    };

    // Mock opportunity
    mockOpportunity = {
      getId: sandbox.stub().returns('test-opportunity-id'),
      getType: sandbox.stub().returns('cwv'),
      getSuggestions: sandbox.stub(),
    };

    // Mock suggestions
    mockSuggestions = [
      {
        getId: sandbox.stub().returns('suggestion-1'),
        getData: sandbox.stub().returns({
          pageviews: 10000,
          metrics: [
            {
              deviceType: 'desktop',
              lcp: 3000, // Above threshold
              cls: 0.05, // Below threshold
              inp: 250, // Above threshold
            },
          ],
        }),
      },
      {
        getId: sandbox.stub().returns('suggestion-2'),
        getData: sandbox.stub().returns({
          pageviews: 5000,
          metrics: [
            {
              deviceType: 'mobile',
              lcp: 2000, // Below threshold
              cls: 0.15, // Above threshold
              inp: 150, // Below threshold
            },
          ],
        }),
      },
    ];

    // Mock suggestion objects returned by findById
    const mockSuggestion1 = {
      getData: sandbox.stub().returns({
        pageviews: 10000,
        metrics: [
          {
            deviceType: 'desktop',
            lcp: 3000, // Above threshold
            cls: 0.05, // Below threshold
            inp: 250, // Above threshold
          },
        ],
      }),
      setData: sandbox.stub(),
      setUpdatedBy: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    const mockSuggestion2 = {
      getData: sandbox.stub().returns({
        pageviews: 5000,
        metrics: [
          {
            deviceType: 'mobile',
            lcp: 2000, // Below threshold
            cls: 0.15, // Above threshold
            inp: 150, // Below threshold
          },
        ],
      }),
      setData: sandbox.stub(),
      setUpdatedBy: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    // Setup findById to return the appropriate mock suggestion
    mockSuggestionDataAccess.findById.withArgs('suggestion-1').resolves(mockSuggestion1);
    mockSuggestionDataAccess.findById.withArgs('suggestion-2').resolves(mockSuggestion2);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('runCwvDemoSuggestionsProcessor', () => {
    const mockMessage = {
      siteId: 'test-site-id',
      siteUrl: 'https://test.com',
      organizationId: 'test-org-id',
      taskContext: {
        auditTypes: ['cwv'],
        profile: 'demo',
      },
    };

    it('should skip processing when no CWV opportunities found', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([]);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.info.calledWith('No CWV opportunities found for site, skipping generic suggestions')).to.be.true;
      expect(result.message).to.equal('No CWV opportunities found');
    });

    it('should skip processing when opportunity already has suggestions with issues', async () => {
      const suggestionsWithIssues = [
        {
          getId: sandbox.stub().returns('suggestion-with-issues'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            issues: [{ type: 'lcp', value: 'existing issue' }],
          }),
        },
      ];

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(suggestionsWithIssues);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.info.calledWith('Opportunity test-opportunity-id already has suggestions with issues, skipping generic suggestions')).to.be.true;
      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should add generic suggestions to opportunities without issues', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      // Verify findById was called for each suggestion
      expect(mockSuggestionDataAccess.findById).to.have.been.calledWith('suggestion-1');
      expect(mockSuggestionDataAccess.findById).to.have.been.calledWith('suggestion-2');

      expect(result.message).to.include('CWV demo suggestions processor completed');
      expect(result.opportunitiesProcessed).to.equal(1);
    });

    it('should handle site not found gracefully', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.error.calledWith('Site not found for siteId: test-site-id')).to.be.true;
      expect(result.message).to.equal('Site not found');
    });

    it('should process only first 2 suggestions with CWV issues', async () => {
      const manySuggestions = [
        ...mockSuggestions,
        {
          getId: sandbox.stub().returns('suggestion-3'),
          getData: sandbox.stub().returns({
            pageviews: 3000,
            metrics: [
              {
                deviceType: 'desktop',
                lcp: 2800, // Above threshold
                cls: 0.05, // Below threshold
                inp: 180, // Below threshold
              },
            ],
          }),
        },
      ];

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(manySuggestions);

      // Mock the third suggestion for findById
      const mockSuggestion3 = {
        getData: sandbox.stub().returns({
          pageviews: 3000,
          metrics: [
            {
              deviceType: 'desktop',
              lcp: 2800, // Above threshold
              cls: 0.05, // Below threshold
              inp: 180, // Below threshold
            },
          ],
        }),
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };
      mockSuggestionDataAccess.findById.withArgs('suggestion-3').resolves(mockSuggestion3);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      // Should only process first 2 suggestions
      expect(mockSuggestionDataAccess.findById).to.have.been.calledWith('suggestion-1');
      expect(mockSuggestionDataAccess.findById).to.have.been.calledWith('suggestion-2');
      expect(mockSuggestionDataAccess.findById).to.not.have.been.calledWith('suggestion-3');

      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle suggestions with various data structures and edge cases', async () => {
      const suggestionsWithEdgeCases = [
        {
          getId: sandbox.stub().returns('no-pageviews'),
          getData: sandbox.stub().returns({
            // Missing pageviews property
            metrics: [{ deviceType: 'desktop', lcp: 3000 }],
          }),
        },
        {
          getId: sandbox.stub().returns('zero-pageviews'),
          getData: sandbox.stub().returns({
            pageviews: 0, // Zero pageviews
            metrics: [{ deviceType: 'desktop', lcp: 3000 }],
          }),
        },
        {
          getId: sandbox.stub().returns('no-metrics'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            // No metrics property
          }),
        },
        {
          getId: sandbox.stub().returns('empty-metrics'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            metrics: [], // Empty metrics array
          }),
        },
        {
          getId: sandbox.stub().returns('null-metrics'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            metrics: null, // Null metrics
          }),
        },
        {
          getId: sandbox.stub().returns('below-thresholds'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            metrics: [
              {
                deviceType: 'desktop',
                lcp: 2000, // Below threshold
                cls: 0.05, // Below threshold
                inp: 150, // Below threshold
              },
            ],
          }),
        },
      ];

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(suggestionsWithEdgeCases);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle suggestions with existing issues of various types', async () => {
      const suggestionsWithIssues = [
        {
          getId: sandbox.stub().returns('different-issue-types'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            issues: [{ type: 'accessibility', value: 'existing accessibility issue' }], // Different issue type
            metrics: [{
              deviceType: 'desktop', lcp: 3000, cls: 0.05, inp: 250,
            }],
          }),
        },
        {
          getId: sandbox.stub().returns('empty-issues'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            issues: [], // Empty issues array
            metrics: [{
              deviceType: 'desktop', lcp: 3000, cls: 0.05, inp: 250,
            }],
          }),
        },
        {
          getId: sandbox.stub().returns('non-array-issues'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            issues: 'not an array', // Non-array issues
            metrics: [{
              deviceType: 'desktop', lcp: 3000, cls: 0.05, inp: 250,
            }],
          }),
        },
        {
          getId: sandbox.stub().returns('existing-cwv-issues'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            issues: [{ type: 'lcp', value: 'existing lcp issue' }], // Same type as CWV
            metrics: [{
              deviceType: 'desktop', lcp: 3000, cls: 0.05, inp: 250,
            }],
          }),
        },
      ];

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(suggestionsWithIssues);

      // Mock the suggestion for findById
      const mockSuggestionWithExistingIssues = {
        getData: sandbox.stub().returns({
          pageviews: 10000,
          issues: [{ type: 'lcp', value: 'existing lcp issue' }],
          metrics: [{
            deviceType: 'desktop', lcp: 3000, cls: 0.05, inp: 250,
          }],
        }),
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      mockSuggestionDataAccess.findById.withArgs('existing-cwv-issues').resolves(mockSuggestionWithExistingIssues);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle suggestion not found during update', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      // Mock findById to return null for one suggestion
      mockSuggestionDataAccess.findById.withArgs('suggestion-1').resolves(null);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.warn.calledWith('Suggestion suggestion-1 not found, skipping update')).to.be.true;
      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle case when no suggestions meet CWV criteria', async () => {
      const suggestionsWithoutCWVIssues = [
        {
          getId: sandbox.stub().returns('no-cwv-issues'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            metrics: [
              {
                deviceType: 'desktop',
                lcp: 2000, // Below threshold
                cls: 0.05, // Below threshold
                inp: 150, // Below threshold
              },
            ],
          }),
        },
      ];

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(suggestionsWithoutCWVIssues);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      // Should complete successfully but not add any generic suggestions
      expect(result.message).to.include('CWV demo suggestions processor completed');
      expect(result.opportunitiesProcessed).to.equal(1);
    });

    it('should handle various taskContext configurations', async () => {
      const testCases = [
        {
          name: 'without taskContext',
          message: { siteId: 'test-site-id', organizationId: 'test-org-id' },
          expectedProfile: undefined,
        },
        {
          name: 'with empty taskContext',
          message: { siteId: 'test-site-id', organizationId: 'test-org-id', taskContext: {} },
          expectedProfile: undefined,
        },
        {
          name: 'with taskContext but no profile',
          message: {
            siteId: 'test-site-id',
            organizationId: 'test-org-id',
            taskContext: { auditTypes: ['cwv'] },
          },
          expectedProfile: undefined,
        },
        {
          name: 'with non-demo profile',
          message: {
            siteId: 'test-site-id',
            organizationId: 'test-org-id',
            taskContext: { auditTypes: ['cwv'], profile: 'default' },
          },
          expectedProfile: 'default',
        },
      ];

      const testPromises = testCases.map(async (testCase) => {
        const result = await runCwvDemoSuggestionsProcessor(testCase.message, mockContext);

        expect(mockContext.log.info.calledWith(`Skipping CWV processing for non-demo profile. Profile: ${testCase.expectedProfile}`)).to.be.true;
        expect(result.message).to.equal('CWV processing skipped - not a demo profile');
        expect(result.reason).to.equal('non-demo-profile');
        expect(result.profile).to.equal(testCase.expectedProfile);
      });

      await Promise.all(testPromises);
    });

    it('should handle error scenarios gracefully', async () => {
      const errorTestCases = [
        {
          name: 'error in updateSuggestionWithGenericIssues',
          setup: () => {
            mockContext.dataAccess.Site.findById.resolves(mockSite);
            mockSite.getOpportunities.resolves([mockOpportunity]);
            mockOpportunity.getSuggestions.resolves(mockSuggestions);
            mockSuggestionDataAccess.findById.withArgs('suggestion-1').rejects(new Error('Database error'));
          },
          expectedLog: 'Error updating suggestion suggestion-1 with generic issues:',
        },
        {
          name: 'error in processOpportunity',
          setup: () => {
            mockContext.dataAccess.Site.findById.resolves(mockSite);
            mockSite.getOpportunities.resolves([mockOpportunity]);
            mockOpportunity.getSuggestions.rejects(new Error('Failed to fetch suggestions'));
          },
          expectedLog: 'Error processing opportunity test-opportunity-id:',
        },
        {
          name: 'error in main function',
          setup: () => {
            mockContext.dataAccess.Site.findById.rejects(new Error('Site database error'));
          },
          expectedLog: 'Error in CWV demo suggestions processor:',
          expectedResult: {
            message: 'CWV demo suggestions processor completed with errors',
            error: 'Site database error',
          },
        },
        {
          name: 'error when saving suggestion fails',
          setup: () => {
            mockContext.dataAccess.Site.findById.resolves(mockSite);
            mockSite.getOpportunities.resolves([mockOpportunity]);
            mockOpportunity.getSuggestions.resolves(mockSuggestions);

            const mockSuggestionWithError = {
              getData: sandbox.stub().returns({
                pageviews: 10000,
                metrics: [{
                  deviceType: 'desktop', lcp: 3000, cls: 0.05, inp: 250,
                }],
              }),
              setData: sandbox.stub(),
              setUpdatedBy: sandbox.stub(),
              save: sandbox.stub().rejects(new Error('Save failed')),
            };

            mockSuggestionDataAccess.findById.withArgs('suggestion-1').resolves(mockSuggestionWithError);
          },
          expectedLog: 'Error updating suggestion suggestion-1 with generic issues:',
        },
      ];

      // eslint-disable-next-line no-await-in-loop
      for (const testCase of errorTestCases) {
        // Reset mocks before each test case
        sandbox.resetHistory();
        testCase.setup();

        // eslint-disable-next-line no-await-in-loop
        const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

        expect(mockContext.log.error.calledWith(testCase.expectedLog, sinon.match.any)).to.be.true;

        if (testCase.expectedResult) {
          expect(result.message).to.equal(testCase.expectedResult.message);
          expect(result.error).to.equal(testCase.expectedResult.error);
        } else {
          expect(result.message).to.include('CWV demo suggestions processor completed');
        }
      }
    });
  });
});
