# Copilot PR Review Instructions

## 1. Review Goals and Priorities

Your primary purpose is to identify **behavior-breaking defects**, **security/auth gaps**, and **missing tests for changed behavior**.
When such issues are present, prioritize them above all other considerations (performance, cost, style).

Use **three severities**:

* **Critical** – Bugs, regressions, security issues, missing required validation, or missing tests for changed behavior.
  *Respond with:* “This PR should not be merged until this is fixed.”
* **Major** – Missing documentation, missing but non-blocking tests, realistic performance or cost concerns.
* **Minor** – Stylistic suggestions or optional improvements.
  *Only list Minor issues if no Critical issues exist.*

If you find any Critical issue, list it first and deprioritize all other feedback.

---

## 2. Output Format (Always Required)

Respond using the following structure:

### Summary

1–3 sentences describing the overall health of the PR.

### Issues

#### Critical

* List each issue, quoting relevant code and suggesting a concrete fix.

#### Major

* As above.

#### Minor

* As above. Only include if there are no Critical issues.

### Suggested Tests

* Describe which tests should be added or updated (if applicable). If no test changes are needed, state that clearly.

---

## 3. Core Checks (Apply to Every PR)

### 3.1 Bug & Regression Scan

Look for defects including:

* Missing or incorrect null/undefined checks.
* Incorrect async/await handling.
* Logic changes without corresponding test updates.

**If you see changed behavior without new or updated tests, mark as Critical.**

---

### 3.2 Use of shared utility functions

Check that utility functions available here: https://github.com/adobe/spacecat-shared/blob/main/packages/spacecat-shared-utils/src/index.js are used where appropriate and instead of self-made checks.

---

### 3.3 Required Tests

For any non-trivial code change:

* Require unit tests under `test/**` using Mocha/Chai/Sinon/esmock.
* Integration tests where relevant.
* Tests must assert behavior, not just shallow coverage.
* Fixtures and helpers must be updated consistently.

**If behavior changes but tests do not → Critical.**

If a PR is documentation-only or comment-only, explicitly mark tests as not required.

---

## 4. Performance Scan (Secondary Priority)

Raise **Major** issues for realistic performance risks:

* Repeated DAO calls inside loops.
* Redundant fetches or HTTP calls.
* Blocking or synchronous operations where async or batching exists.
* Unbounded payload handling without streaming.

Do **not** speculate without evidence.

---

## 5. Cost Impact Scan (Secondary Priority)

Flag potential cost increases only when the diff clearly adds:

* New SQS calls, queue consumers, cron jobs.
* Large CSV/JSON generation.
* Long-running processing.
* Removal of rate limits such as `SANDBOX_AUDIT_RATE_LIMIT_HOURS`.

Tie comments to specific code, not general assumptions.

---

## 6. Config, Documentation, and Change Control

For any new:

* Env var
* Queue
* Feature flag
* Controller surface area

Require updates to:

* `README.md`

Missing required docs → **Major**.

---

## 7. Final Quality Pass

Once all Critical and Major issues are addressed:

* Ensure handlers, tests, routing, and docs are consistent.
* Ensure no lint rules are violated.
* Ensure logging is structured and avoids PII.
* Only then offer stylistic suggestions (Minor).