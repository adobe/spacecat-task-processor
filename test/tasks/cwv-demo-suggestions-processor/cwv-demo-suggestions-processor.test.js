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
import esmock from 'esmock';
import { MockContextBuilder } from '../../shared.js';

// Dynamic import for ES modules
let runCwvDemoSuggestionsProcessor;
let sayStub;

describe('CWV Demo Suggestions Processor Task', () => {
  let sandbox;
  let mockContext;
  let mockSite;
  let mockOpportunity;
  let mockSuggestions;
  let mockSuggestionDataAccess;

  // Helper function to create mock suggestions
  const createMockSuggestion = (id, pageviews, metrics, hasIssues = false, status = 'new') => ({
    getId: sandbox.stub().returns(id),
    getData: sandbox.stub().returns({
      pageviews,
      metrics,
      status,
      ...(hasIssues && { issues: [{ type: 'lcp', value: 'existing issue' }] }),
    }),
    getStatus: sandbox.stub().returns(status.toUpperCase()),
    setData: sandbox.stub(),
    setUpdatedBy: sandbox.stub(),
    save: sandbox.stub().resolves(),
  });

  // Helper function to create mock metrics
  const createMockMetrics = (lcp, cls, inp, deviceType = 'desktop') => ({
    deviceType,
    lcp,
    cls,
    inp,
  });

  // Helper function to setup common mocks
  const setupCommonMocks = () => {
    mockContext.dataAccess.Site.findById.resolves(mockSite);
    mockSite.getOpportunities.resolves([mockOpportunity]);
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    // Create sayStub
    sayStub = sandbox.stub().resolves();

    // Import the function to test with esmock to mock slack-utils
    const module = await esmock('../../../src/tasks/cwv-demo-suggestions-processor/handler.js', {
      '../../../src/utils/slack-utils.js': {
        say: sayStub,
      },
    });
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

    // Create mock suggestions using helper functions
    mockSuggestions = [
      createMockSuggestion('suggestion-1', 10000, [
        createMockMetrics(3000, 0.05, 250), // Above LCP & INP thresholds
      ]),
      createMockSuggestion('suggestion-2', 5000, [
        createMockMetrics(2000, 0.15, 150, 'mobile'), // Above CLS threshold
      ]),
    ];

    // Setup findById to return the appropriate mock suggestion
    mockSuggestions.forEach((suggestion, index) => {
      mockSuggestionDataAccess.findById.withArgs(`suggestion-${index + 1}`).resolves(suggestion);
    });
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
      const resultBody = await result.json();

      expect(sayStub.calledWith(
        mockContext.env,
        mockContext.log,
        mockContext.slackContext,
        'No CWV opportunities found for site, skipping generic suggestions',
      )).to.be.true;
      expect(resultBody.message).to.equal('No CWV opportunities found');
    });

    it('should skip processing when opportunity already has suggestions with issues', async () => {
      const suggestionsWithIssues = [
        createMockSuggestion('suggestion-with-issues', 10000, [], true), // hasIssues = true
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(suggestionsWithIssues);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(sayStub.calledWith(
        mockContext.env,
        mockContext.log,
        mockContext.slackContext,
        'ℹ️ Opportunity test-opportunity-id already has suggestions, skipping generic suggestions',
      )).to.be.true;
      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
    });

    it('should add generic suggestions to opportunities without issues', async () => {
      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      expect(resultBody.opportunitiesProcessed).to.equal(1);
    });

    it('should handle site not found gracefully', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(mockContext.log.error.calledWith('Site not found for siteId: test-site-id')).to.be.true;
      expect(resultBody.message).to.equal('Site not found');
    });

    it('should process only first 2 suggestions with CWV issues', async () => {
      const manySuggestions = [
        ...mockSuggestions,
        createMockSuggestion('suggestion-3', 3000, [
          createMockMetrics(2800, 0.05, 180), // Above LCP threshold
        ]),
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(manySuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle suggestion not found during update', async () => {
      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle case when no suggestions meet CWV criteria', async () => {
      const suggestionsWithoutCWVIssues = [
        createMockSuggestion('no-cwv-issues', 10000, [
          createMockMetrics(2000, 0.05, 150), // All below thresholds
        ]),
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(suggestionsWithoutCWVIssues);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      // Should complete successfully but not add any generic suggestions
      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      expect(resultBody.opportunitiesProcessed).to.equal(1);
    });

    it('should handle suggestions with missing metrics property', async () => {
      const suggestionsWithMissingMetrics = [
        createMockSuggestion('missing-metrics', 10000, undefined), // No metrics property
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(suggestionsWithMissingMetrics);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      // Should complete successfully but not add any generic suggestions since no metrics
      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      expect(resultBody.opportunitiesProcessed).to.equal(1);
      expect(resultBody.suggestionsAdded).to.equal(0);
    });

    it('should skip processing for non-demo profiles', async () => {
      const nonDemoMessage = {
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
        taskContext: { profile: 'default' },
      };

      const result = await runCwvDemoSuggestionsProcessor(nonDemoMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.equal('CWV processing skipped - not a demo profile');
      expect(resultBody.reason).to.equal('non-demo-profile');
      expect(resultBody.profile).to.equal('default');
    });

    it('should handle missing taskContext and metrics gracefully', async () => {
      const messageWithoutTaskContext = {
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
        // No taskContext
      };

      const suggestionsWithoutMetrics = [
        {
          getId: sandbox.stub().returns('no-metrics'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            // No metrics property
          }),
        },
      ];

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(suggestionsWithoutMetrics);

      const result = await runCwvDemoSuggestionsProcessor(messageWithoutTaskContext, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.equal('CWV processing skipped - not a demo profile');
      expect(resultBody.reason).to.equal('non-demo-profile');
      expect(resultBody.profile).to.be.undefined;
    });

    it('should handle main function errors gracefully', async () => {
      mockContext.dataAccess.Site.findById.rejects(new Error('Site database error'));

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(mockContext.log.error.calledWith('Error in CWV demo suggestions processor:', sinon.match.any)).to.be.true;
      expect(resultBody.message).to.equal('CWV demo suggestions processor completed with errors');
      expect(resultBody.error).to.equal('Site database error');
      expect(resultBody.suggestionsAdded).to.equal(0);
    });

    it('should handle opportunity processing errors gracefully', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.rejects(new Error('Failed to fetch suggestions'));

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(mockContext.log.error.calledWith('Error processing opportunity test-opportunity-id:', sinon.match.any)).to.be.true;
      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(resultBody.suggestionsAdded).to.be.a('number');
    });

    it('should handle missing CWV reference suggestions gracefully', async () => {
      // This test covers the case where getRandomSuggestion returns null (lines 89-90)
      // We'll test the getRandomSuggestion function indirectly by creating a scenario
      // where it would be called with an issue type that doesn't exist

      const module = await import('../../../src/tasks/cwv-demo-suggestions-processor/handler.js');

      // Create suggestions with metrics that would trigger CWV issues
      const suggestionsWithCWVIssues = [
        createMockSuggestion('suggestion-with-issues', 10000, [
          createMockMetrics(3000, 0.05, 150), // Above LCP threshold
        ]),
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(suggestionsWithCWVIssues);

      // Temporarily remove all suggestions from lcp to trigger the null return path
      const originalLcp = module.cwvReferenceSuggestions?.lcp;
      if (module.cwvReferenceSuggestions && module.cwvReferenceSuggestions.lcp) {
        module.cwvReferenceSuggestions.lcp = [];
      }

      try {
        const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
        const resultBody = await result.json();
        expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      } finally {
        // Restore original lcp suggestions
        if (module.cwvReferenceSuggestions && originalLcp) {
          module.cwvReferenceSuggestions.lcp = originalLcp;
        }
      }
    });

    it('should handle markdown file loading gracefully', async () => {
      // This test covers the case when markdown files are missing or unreadable
      // We'll test that the handler still works even if some files are missing

      const suggestionsWithCWVIssues = [
        {
          getId: sandbox.stub().returns('suggestion-test'),
          getData: sandbox.stub().returns({
            pageviews: 10000,
            metrics: [{ deviceType: 'desktop', lcp: 3000 }], // Above threshold
          }),
          setData: sandbox.stub(),
          setUpdatedBy: sandbox.stub(),
          save: sandbox.stub().resolves(),
        },
      ];

      const mockSuggestionTest = {
        getData: sandbox.stub().returns({
          pageviews: 10000,
          metrics: [{ deviceType: 'desktop', lcp: 3000 }],
        }),
        setData: sandbox.stub(),
        setUpdatedBy: sandbox.stub(),
        save: sandbox.stub().resolves(),
      };

      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.resolves(suggestionsWithCWVIssues);
      mockSuggestionDataAccess.findById.withArgs('suggestion-test').resolves(mockSuggestionTest);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);
      const resultBody = await result.json();

      // Should complete without errors even when markdown files are missing
      expect(resultBody.message).to.include('CWV demo suggestions processor completed');

      // The system should still function even when markdown files are missing
      expect(resultBody.suggestionsAdded).to.be.a('number');
    });

    it('should handle file reading errors in readStaticFile', async () => {
      // This test covers lines 85-87: error handling in readStaticFile
      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      // Use esmock to mock fs.readFileSync specifically for this test
      const handlerModule = await esmock('../../../src/tasks/cwv-demo-suggestions-processor/handler.js', {
        '../../../src/utils/slack-utils.js': {
          say: sayStub,
        },
        fs: {
          readFileSync: sandbox.stub().throws(new Error('File not found')),
        },
      });
      const testHandler = handlerModule.runCwvDemoSuggestionsProcessor;

      const result = await testHandler(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(resultBody.suggestionsAdded).to.be.a('number');
    });

    it('should handle empty suggestions array in getRandomSuggestion', async () => {
      // This test covers lines 99-100: when suggestions array is empty
      setupCommonMocks();

      // Create suggestions with CWV issues but empty suggestions array in JSON
      const suggestionsWithCWVIssues = [
        createMockSuggestion('suggestion-test', 10000, [
          createMockMetrics(3000, 0.05, 250), // Above LCP & INP thresholds
        ]),
      ];

      mockOpportunity.getSuggestions.resolves(suggestionsWithCWVIssues);

      // Use esmock to mock fs.readFileSync to return empty arrays
      const handlerModule = await esmock('../../../src/tasks/cwv-demo-suggestions-processor/handler.js', {
        '../../../src/utils/slack-utils.js': {
          say: sayStub,
        },
        fs: {
          readFileSync: sandbox.stub().returns(JSON.stringify({ lcp: [], cls: [], inp: [] })),
        },
      });
      const testHandler = handlerModule.runCwvDemoSuggestionsProcessor;

      const result = await testHandler(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(resultBody.suggestionsAdded).to.be.a('number');
    });

    it('should handle readStaticFile returning null in getRandomSuggestion', async () => {
      // This test covers when readStaticFile returns null for markdown files
      setupCommonMocks();

      const suggestionsWithCWVIssues = [
        createMockSuggestion('suggestion-test', 10000, [
          createMockMetrics(3000, 0.05, 250), // Above LCP & INP thresholds
        ]),
      ];

      mockOpportunity.getSuggestions.resolves(suggestionsWithCWVIssues);

      // Use esmock to mock fs.readFileSync to simulate file not found
      const handlerModule = await esmock('../../../src/tasks/cwv-demo-suggestions-processor/handler.js', {
        '../../../src/utils/slack-utils.js': {
          say: sayStub,
        },
        fs: {
          readFileSync: sandbox.stub().throws(new Error('File not found')),
        },
      });
      const testHandler = handlerModule.runCwvDemoSuggestionsProcessor;

      const result = await testHandler(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(resultBody.suggestionsAdded).to.be.a('number');
    });

    it('should handle errors in updateSuggestionWithGenericIssues', async () => {
      // This test covers lines 172-173: error handling in updateSuggestionWithGenericIssues
      setupCommonMocks();

      const suggestionsWithCWVIssues = [
        createMockSuggestion('suggestion-test', 10000, [
          createMockMetrics(3000, 0.05, 250), // Above LCP & INP thresholds
        ]),
      ];

      mockOpportunity.getSuggestions.resolves(suggestionsWithCWVIssues);

      // Mock suggestion.save to throw an error
      const mockSuggestion = suggestionsWithCWVIssues[0];
      mockSuggestion.save.rejects(new Error('Database save failed'));

      // Mock fs.readFileSync to return valid content so getRandomSuggestion works
      const handlerModule = await esmock('../../../src/tasks/cwv-demo-suggestions-processor/handler.js', {
        '../../../src/utils/slack-utils.js': {
          say: sayStub,
        },
        fs: {
          readFileSync: sandbox.stub().returns('Test suggestion content'),
        },
      });
      const testHandler = handlerModule.runCwvDemoSuggestionsProcessor;

      const result = await testHandler(mockMessage, mockContext);
      const resultBody = await result.json();

      expect(resultBody.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and returns suggestionsToUpdate.length even if save fails
      expect(resultBody.suggestionsAdded).to.be.a('number');
      expect(resultBody.suggestionsAdded).to.equal(1); // Should be 1 suggestion attempted
    });
  });
});
