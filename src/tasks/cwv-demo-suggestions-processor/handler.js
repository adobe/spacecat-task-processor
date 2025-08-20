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

const TASK_TYPE = 'cwv-demo-suggestions-processor';

/**
 * CWV Reference Suggestions from wiki
 * These are generic recommendations for LCP, CLS, and INP issues
 */
const CWV_REFERENCE_SUGGESTIONS = {
  lcp: {
    type: 'lcp',
    value: '## 1. **Title:** Defer Non-Essential JavaScript, SVGs, and jQuery from Critical Path\n\n*   **Description:** Several JavaScript files, decorative SVGs, and jQuery are loaded eagerly but are not essential for rendering the LCP. Deferring them will free up bandwidth and CPU for critical resources.\n *   **Implementation Priority:** Medium\n *   **Implementation Effort:** Medium\n *   **Details:**\n     *   **Lottie Animations & Player:** Defer `unpkg.com/@dotlottie/player-component` (and its chunks like `chunk-HDDX7F4A.mjs`) and the lottie animation file (`YVBP7LmN0o.lottie` from `lottie.host`) to be loaded in `loadLazy` or `loadDelayed` in `scripts.js`. Instantiate Lottie animations only when they become visible using an IntersectionObserver.\n     *   **Decorative SVGs:** Inline SVGs (`section-arc.svg`, `background-arc.svg`) identified in rule violations should be converted to `<img>` tags with `loading="lazy"` attribute and appropriate `width`/`height` or loaded via CSS that is part of `lazy-styles.css` or block-specific CSS loaded lazily.\n     *   **jQuery:** Defer `jquery-3.7.1.min.js` (30KB) to `loadLazy` or `loadDelayed` if it\'s not strictly required for LCP rendering logic.\n     *   **Other Non-LCP Images:** Images from `assets.ups.com` (e.g., `urn:aaid:aem:8e7fc503...`, `urn:aaid:aem:8195feea...`) that are not the LCP element but are above the fold should be converted to `<img>` by JS with `loading="eager"` and `fetchpriority="auto"`. If below the fold, use `loading="lazy"`. Ensure `width` and `height` are set.\n *   **Expected Impact:** LCP reduction of 300-600ms. INP improvement of 50-100ms.',
  },
  cls: {
    type: 'cls',
    value: '## 1. **Title:** Ensure Image Dimensions are Set for Dynamically Loaded Images\n\n*   **Description:** Many images on the page are initially `<a>` tags and are converted to `<img>` tags by JavaScript. If these images lack `width` and `height` attributes or `aspect-ratio` CSS, they can cause layout shifts when they load.\n*   **Implementation Priority:** Medium\n*   **Implementation Effort:** Medium\n*   **Details:**\n    *   Modify the JavaScript in `scripts.js` or block-specific scripts that transform `<a>` tags (especially those from `assets.ups.com`) into `<img>` tags.\n    *   Ensure the script adds explicit `width` and `height` attributes to the generated `<img>` tags.\n    *   Alternatively, define `aspect-ratio` for these images via CSS if their dimensions are responsive but maintain a consistent aspect ratio.\n*   **Expected Impact:** CLS reduction of <0.05, depending on how many images are affected.\n\n',
  },
  inp: {
    type: 'inp',
    value: '## 1. **Title:** Optimize JavaScript Execution and Reduce Main Thread Blocking\n\n*   **Description:** JavaScript execution on the main thread can block user interactions, leading to poor INP scores. Long tasks and excessive JavaScript execution should be optimized.\n*   **Implementation Priority:** High\n*   **Implementation Effort:** Medium\n*   **Details:**\n    *   Break down long JavaScript tasks into smaller chunks using `setTimeout` or `requestIdleCallback`.\n    *   Move non-critical JavaScript to web workers where possible.\n    *   Optimize event handlers to avoid blocking the main thread.\n    *   Use `passive: true` for scroll and touch event listeners.\n    *   Implement debouncing for input events.\n*   **Expected Impact:** INP improvement of 100-200ms.\n\n',
  },
};

/**
 * CWV thresholds for determining if metrics have issues
 */
const CWV_THRESHOLDS = {
  lcp: 2500, // 2.5 seconds
  cls: 0.1, // 0.1
  inp: 200, // 200 milliseconds
};

/**
 * Checks if a metric has issues based on CWV thresholds
 * @param {Object} metrics - The metrics object containing lcp, cls, inp values
 * @returns {Array} Array of metric types that have issues
 */
function getMetricIssues(metrics) {
  const issues = [];

  if (metrics.lcp && metrics.lcp > CWV_THRESHOLDS.lcp) {
    issues.push('lcp');
  }

  if (metrics.cls && metrics.cls > CWV_THRESHOLDS.cls) {
    issues.push('cls');
  }

  if (metrics.inp && metrics.inp > CWV_THRESHOLDS.inp) {
    issues.push('inp');
  }

  return issues;
}

/**
 * Checks if a suggestion already has issues data
 * @param {Object} suggestion - The suggestion object
 * @returns {boolean} True if suggestion already has issues
 */
function hasExistingIssues(suggestion) {
  const data = suggestion.getData();
  return data.issues && Array.isArray(data.issues) && data.issues.length > 0;
}

/**
 * Updates a suggestion with generic CWV issues using the proper API pattern
 * @param {Object} suggestion - The suggestion object
 * @param {Array} metricIssues - Array of metric types with issues
 * @param {Object} log - The logger object
 * @param {Object} Suggestion - The Suggestion data access object
 * @returns {Promise<void>}
 */
async function updateSuggestionWithGenericIssues(suggestion, metricIssues, log, Suggestion) {
  try {
    const suggestionId = suggestion.getId();

    const suggestionToUpdate = await Suggestion.findById(suggestionId);
    if (!suggestionToUpdate) {
      log.warn(`Suggestion ${suggestionId} not found, skipping update`);
      return;
    }

    const data = suggestionToUpdate.getData();

    if (!data.issues) {
      data.issues = [];
    }

    for (const issueType of metricIssues) {
      if (CWV_REFERENCE_SUGGESTIONS[issueType]) {
        const genericIssue = CWV_REFERENCE_SUGGESTIONS[issueType];

        const existingIssue = data.issues.find((issue) => issue.type === issueType);
        if (!existingIssue) {
          data.issues.push(genericIssue);
        }
      }
    }

    data.genericSuggestions = true;

    suggestionToUpdate.setData(data);
    suggestionToUpdate.setUpdatedBy('system');
    await suggestionToUpdate.save();

    log.info(`Updated suggestion ${suggestionId} with generic CWV issues: ${metricIssues.join(', ')}`);
  } catch (error) {
    log.error(`Error updating suggestion ${suggestion.getId()} with generic issues:`, error);
  }
}

/**
 * Processes a single CWV opportunity to add generic suggestions
 * @param {Object} opportunity - The opportunity object
 * @param {Object} log - The logger object
 * @param {Object} Suggestion - The Suggestion data access object
 * @returns {Promise<void>}
 */
async function processOpportunity(opportunity, log, Suggestion) {
  try {
    const suggestions = await opportunity.getSuggestions();

    const hasSuggestionsWithIssues = suggestions.some(hasExistingIssues);

    if (hasSuggestionsWithIssues) {
      log.info(`Opportunity ${opportunity.getId()} already has suggestions with issues, skipping generic suggestions`);
      return;
    }

    // Sort suggestions by pageviews (descending)
    const sortedSuggestions = suggestions
      .filter((suggestion) => {
        const data = suggestion.getData();
        return data.pageviews && data.pageviews > 0;
      })
      .sort((a, b) => b.getData().pageviews - a.getData().pageviews);

    // Find first 2 suggestions with CWV issues
    const suggestionsToUpdate = [];

    for (const suggestion of sortedSuggestions) {
      if (suggestionsToUpdate.length >= 2) break;

      const data = suggestion.getData();
      const metrics = data.metrics || [];

      // Check if any device metrics have CWV issues
      let hasCWVIssues = false;
      let metricIssues = [];

      for (const metric of metrics) {
        const issues = getMetricIssues(metric);
        if (issues.length > 0) {
          hasCWVIssues = true;
          metricIssues = issues;
          break;
        }
      }

      if (hasCWVIssues) {
        suggestionsToUpdate.push({ suggestion, metricIssues });
      }
    }

    // Update suggestions with generic recommendations
    const updatePromises = suggestionsToUpdate.map(
      ({ suggestion, metricIssues }) => updateSuggestionWithGenericIssues(
        suggestion,
        metricIssues,
        log,
        Suggestion,
      ),
    );
    await Promise.all(updatePromises);

    if (suggestionsToUpdate.length > 0) {
      log.info(`Added generic suggestions to opportunity ${opportunity.getId()} for ${suggestionsToUpdate.length} suggestions`);
    }
  } catch (error) {
    log.error(`Error processing opportunity ${opportunity.getId()}:`, error);
  }
}

/**
 * Runs the CWV demo suggestions processor
 * @param {object} message - The message object
 * @param {object} context - The context object
 */
export async function runCwvDemoSuggestionsProcessor(message, context) {
  const { log, dataAccess } = context;
  const { Site, Suggestion } = dataAccess;
  const {
    siteId, organizationId, taskContext,
  } = message;
  const {
    auditTypes = [], profile,
  } = taskContext || {};

  log.info('Processing CWV demo suggestions for site:', {
    taskType: TASK_TYPE,
    siteId,
    organizationId,
    auditTypes,
    profile,
  });

  try {
    if (!profile || profile !== 'demo') {
      log.info(`Skipping CWV processing for non-demo profile. Profile: ${profile}`);
      return {
        message: 'CWV processing skipped - not a demo profile',
        reason: 'non-demo-profile',
        profile,
      };
    }

    log.info(`Confirmed demo profile - proceeding with CWV processing for profile: ${profile}`);

    const site = await Site.findById(siteId);
    if (!site) {
      log.error(`Site not found for siteId: ${siteId}`);
      return { message: 'Site not found' };
    }

    const opportunities = await site.getOpportunities();
    const cwvOpportunities = opportunities.filter((opp) => opp.getType() === 'cwv');

    if (cwvOpportunities.length === 0) {
      log.info('No CWV opportunities found for site, skipping generic suggestions');
      return { message: 'No CWV opportunities found' };
    }

    const processPromises = cwvOpportunities.map(
      (opportunity) => processOpportunity(opportunity, log, Suggestion),
    );
    await Promise.all(processPromises);

    log.info(`Processed ${cwvOpportunities.length} CWV opportunities for generic suggestions`);

    return {
      message: `CWV demo suggestions processor completed for ${cwvOpportunities.length} opportunities`,
      opportunitiesProcessed: cwvOpportunities.length,
    };
  } catch (error) {
    log.error('Error in CWV demo suggestions processor:', error);
    return {
      message: 'CWV demo suggestions processor completed with errors',
      error: error.message,
    };
  }
}

export default runCwvDemoSuggestionsProcessor;
