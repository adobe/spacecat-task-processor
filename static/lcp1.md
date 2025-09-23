### Prioritize the LCP Image and Lazy-Load Other Images

- **Metric**: LCP
- **Category**: images
- **Priority**: High
- **Effort**: Easy
- **Impact**: Reduces LCP by 400ms-800ms

**Description**

The most important image on the page (the LCP element) is competing for network resources with other, less critical images. This delays the LCP and worsens the user experience. By explicitly telling the browser which image to load eagerly and which to load lazily, we can ensure the main content is visible much faster.

**Implementation**

Set `loading="eager"` on the LCP `<img>` element. While this is often the browser's default, explicitly setting it can help override other platform-level lazy-loading defaults. Crucially, set `loading="lazy"` on all other non-critical images that appear below the fold. This prevents them from being loaded until the user scrolls near them, freeing up bandwidth for the LCP image.

**Code Example**
```html
<!-- LCP Image (Above the fold): Prioritize with loading="eager" -->
<img src="/path/to/lcp-image.jpg" loading="eager" width="1200" height="800" alt="Main hero image">

<!-- Other Images (Below the fold): Defer with loading="lazy" -->
<img src="/path/to/another-image-1.jpg" loading="lazy" width="600" height="400" alt="A secondary image">
<img src="/path/to/another-image-2.jpg" loading="lazy" width="600" height="400" alt="Another secondary image">
```