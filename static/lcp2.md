### Split CSS into Critical and Non-Critical Files to Unblock Rendering

- **Metric**: LCP
- **Category**: css
- **Priority**: High
- **Effort**: Medium
- **Impact**: Reduces LCP by 300ms-600ms

**Description**

A large, single CSS file is blocking the page from rendering until it is fully downloaded and parsed. Much of this CSS is not needed for the initial view. This "render-blocking" behavior significantly delays when users can see content, negatively impacting LCP.

**Implementation**

Separate your CSS into two parts: "critical" and "non-critical". The critical CSS file should contain only the minimal styles required to render the content visible in the initial viewport (above the fold). Load this file synchronously in the `<head>`. The rest of the styles should be in a separate, non-critical CSS file that is loaded asynchronously, so it doesn't block the initial rendering of the page.

**Code Example**
```html
<head>
  <!-- Load critical CSS synchronously to render above-the-fold content -->
  <link rel="stylesheet" href="/styles/critical.css">

  <!-- Preload and then asynchronously load the main stylesheet -->
  <link rel="preload" href="/styles/main.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
  
  <!-- Fallback for browsers without JavaScript -->
  <noscript>
    <link rel="stylesheet" href="/styles/main.css">
  </noscript>
</head>
```