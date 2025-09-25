### Prevent Layout Shifts by Specifying Image Dimensions

- **Metric**: CLS
- **Category**: images
- **Priority**: High
- **Effort**: Easy
- **Impact**: Reduces CLS by 0.1-0.2

**Description**

Images on the page are loading without their dimensions being specified. This causes content to jump around as images load, creating a jarring user experience and a high Cumulative Layout Shift (CLS) score.

**Implementation**

Add `width` and `height` attributes to all `<img>` elements. This allows the browser to reserve the correct amount of space for the image before it loads, preventing content from shifting. Use CSS to ensure images remain responsive.

**Code Example**
```html
<!-- Before -->
<img src="/path/to/image.jpg" alt="Description">

<!-- After -->
<img src="/path/to/image.jpg" width="800" height="600" alt="Description" style="max-width: 100%; height: auto;">
```