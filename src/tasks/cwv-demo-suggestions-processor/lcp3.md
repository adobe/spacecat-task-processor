### Optimize Custom Font Loading to Speed Up Text Rendering

- **Metric**: LCP
- **Category**: fonts
- **Priority**: Medium
- **Effort**: Medium
- **Impact**: Reduces LCP by 200ms-400ms

**Description**

Custom fonts are blocking the display of important text, including the page's headline, until the font files are fully downloaded. This delay contributes to a higher LCP if the LCP element is a block of text.

**Implementation**

Host fonts on your own domain to avoid an extra connection to a third-party domain. Preload the most critical font files in the `<head>`. Use `font-display: swap;` in your `@font-face` declaration to allow the browser to show a fallback font immediately while the custom font loads.

**Code Example**
```css
/* In your CSS file */
@font-face {
  font-family: 'YourAppFont';
  src: url('/fonts/yourappfont.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap; /* This allows text to be visible while font loads */
}
```
```html
<!-- In HTML <head> -->
<link rel="preload" href="/fonts/yourappfont.woff2" as="font" type="font/woff2" crossorigin>
```