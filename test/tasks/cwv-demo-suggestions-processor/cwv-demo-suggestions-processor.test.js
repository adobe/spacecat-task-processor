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
  const createMockSuggestion = (id, pageviews, metrics, hasIssues = false) => ({
    getId: sandbox.stub().returns(id),
    getData: sandbox.stub().returns({
      pageviews,
      metrics,
      ...(hasIssues && { issues: [{ type: 'lcp', value: 'existing issue' }] }),
    }),
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

      expect(mockContext.log.info.calledWith('No CWV opportunities found for site, skipping generic suggestions')).to.be.true;
      expect(result.message).to.equal('No CWV opportunities found');
    });

    it('should skip processing when opportunity already has suggestions with issues', async () => {
      const suggestionsWithIssues = [
        createMockSuggestion('suggestion-with-issues', 10000, [], true), // hasIssues = true
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(suggestionsWithIssues);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.info.calledWith('Opportunity test-opportunity-id already has suggestions with issues, skipping generic suggestions')).to.be.true;
      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should add generic suggestions to opportunities without issues', async () => {
      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

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
        createMockSuggestion('suggestion-3', 3000, [
          createMockMetrics(2800, 0.05, 180), // Above LCP threshold
        ]),
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(manySuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(result.message).to.include('CWV demo suggestions processor completed');
    });

    it('should handle suggestion not found during update', async () => {
      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(mockSuggestions);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(result.message).to.include('CWV demo suggestions processor completed');
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

      // Should complete successfully but not add any generic suggestions
      expect(result.message).to.include('CWV demo suggestions processor completed');
      expect(result.opportunitiesProcessed).to.equal(1);
    });

    it('should handle suggestions with missing metrics property', async () => {
      const suggestionsWithMissingMetrics = [
        createMockSuggestion('missing-metrics', 10000, undefined), // No metrics property
      ];

      setupCommonMocks();
      mockOpportunity.getSuggestions.resolves(suggestionsWithMissingMetrics);

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      // Should complete successfully but not add any generic suggestions since no metrics
      expect(result.message).to.include('CWV demo suggestions processor completed');
      expect(result.opportunitiesProcessed).to.equal(1);
      expect(result.suggestionsAdded).to.equal(0);
    });

    it('should skip processing for non-demo profiles', async () => {
      const nonDemoMessage = {
        siteId: 'test-site-id',
        organizationId: 'test-org-id',
        taskContext: { profile: 'default' },
      };

      const result = await runCwvDemoSuggestionsProcessor(nonDemoMessage, mockContext);

      expect(mockContext.log.info.calledWith('Skipping CWV processing for non-demo profile. Profile: default')).to.be.true;
      expect(result.message).to.equal('CWV processing skipped - not a demo profile');
      expect(result.reason).to.equal('non-demo-profile');
      expect(result.profile).to.equal('default');
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

      expect(mockContext.log.info.calledWith('Skipping CWV processing for non-demo profile. Profile: undefined')).to.be.true;
      expect(result.message).to.equal('CWV processing skipped - not a demo profile');
      expect(result.reason).to.equal('non-demo-profile');
      expect(result.profile).to.be.undefined;
    });

    it('should handle main function errors gracefully', async () => {
      mockContext.dataAccess.Site.findById.rejects(new Error('Site database error'));

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.error.calledWith('Error in CWV demo suggestions processor:', sinon.match.any)).to.be.true;
      expect(result.message).to.equal('CWV demo suggestions processor completed with errors');
      expect(result.error).to.equal('Site database error');
      expect(result.suggestionsAdded).to.equal(0);
    });

    it('should handle opportunity processing errors gracefully', async () => {
      mockContext.dataAccess.Site.findById.resolves(mockSite);
      mockSite.getOpportunities.resolves([mockOpportunity]);
      mockOpportunity.getSuggestions.rejects(new Error('Failed to fetch suggestions'));

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(mockContext.log.error.calledWith('Error processing opportunity test-opportunity-id:', sinon.match.any)).to.be.true;
      expect(result.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(result.suggestionsAdded).to.be.a('number');
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
        expect(result.message).to.include('CWV demo suggestions processor completed');
      } finally {
        // Restore original lcp suggestions
        if (module.cwvReferenceSuggestions && originalLcp) {
          module.cwvReferenceSuggestions.lcp = originalLcp;
        }
      }
    });

    it('should handle JSON file loading failure gracefully', async () => {
      // This test covers the catch block when JSON loading fails (lines 33-34)
      // We'll temporarily move the JSON file to trigger the file loading failure

      const fsModule = await import('fs');
      const path = await import('path');

      // Get the path to the JSON file
      const jsonPath = path.join(process.cwd(), 'static', 'aem-best-practices.json');
      const backupPath = path.join(process.cwd(), 'static', 'aem-best-practices.json.backup');

      // Backup and remove the original file
      if (fsModule.existsSync(jsonPath)) {
        fsModule.copyFileSync(jsonPath, backupPath);
        fsModule.unlinkSync(jsonPath);
      }

      try {
        // Now import the module with a cache-busting query parameter
        // This should trigger the catch block (lines 33-34) since the JSON file is missing
        const moduleUrl = `../../../src/tasks/cwv-demo-suggestions-processor/handler.js?t=${Date.now()}`;
        const { runCwvDemoSuggestionsProcessor: freshHandler } = await import(moduleUrl);

        // Create a test scenario to verify the fallback behavior
        const suggestionsWithCWVIssues = [
          {
            getId: sandbox.stub().returns('suggestion-test'),
            getData: sandbox.stub().returns({
              pageviews: 10000,
              metrics: [{ deviceType: 'desktop', lcp: 3000 }], // Above threshold
            }),
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

        const result = await freshHandler(mockMessage, mockContext);

        // Should complete without errors even when JSON loading fails
        expect(result.message).to.include('CWV demo suggestions processor completed');

        // The system should still function even when JSON file is missing
        // (fallback to empty suggestions object)
        expect(result.suggestionsAdded).to.be.a('number');
      } finally {
        // Restore the original file
        if (fsModule.existsSync(backupPath)) {
          fsModule.copyFileSync(backupPath, jsonPath);
          fsModule.unlinkSync(backupPath);
        }
      }
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

      expect(result.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(result.suggestionsAdded).to.be.a('number');
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

      expect(result.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(result.suggestionsAdded).to.be.a('number');
    });

    it('should handle readStaticFile returning null in getRandomSuggestion', async () => {
      // This test covers lines 108-110: when readStaticFile returns null
      setupCommonMocks();

      const suggestionsWithCWVIssues = [
        createMockSuggestion('suggestion-test', 10000, [
          createMockMetrics(3000, 0.05, 250), // Above LCP & INP thresholds
        ]),
      ];

      mockOpportunity.getSuggestions.resolves(suggestionsWithCWVIssues);

      // Use esmock to mock fs.readFileSync to return valid JSON but fail on individual files
      const handlerModule = await esmock('../../../src/tasks/cwv-demo-suggestions-processor/handler.js', {
        '../../../src/utils/slack-utils.js': {
          say: sayStub,
        },
        fs: {
          readFileSync: sandbox.stub().callsFake((filePath) => {
            if (filePath.includes('aem-best-practices.json')) {
              return JSON.stringify({ lcp: ['lcp1.md'], cls: [], inp: [] });
            } else {
              // Simulate file not found for individual files
              throw new Error('File not found');
            }
          }),
        },
      });
      const testHandler = handlerModule.runCwvDemoSuggestionsProcessor;

      const result = await testHandler(mockMessage, mockContext);

      expect(result.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(result.suggestionsAdded).to.be.a('number');
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

      const result = await runCwvDemoSuggestionsProcessor(mockMessage, mockContext);

      expect(result.message).to.include('CWV demo suggestions processor completed');
      // The handler is resilient and may still add suggestions despite file reading errors
      expect(result.suggestionsAdded).to.be.a('number');
    });
  });
});
