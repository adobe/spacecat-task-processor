### Stabilize Layout During Font Loading

- **Metric**: CLS
- **Category**: fonts
- **Priority**: Medium
- **Effort**: Medium
- **Impact**: Reduces CLS by 0.05-0.1

**Description**

The switch between the fallback font and the custom web font causes a noticeable shift in layout because the two fonts have different sizes. This contributes to the CLS score and makes the page feel unstable.

**Implementation**

Use the `size-adjust` CSS descriptor in your `@font-face` rule to normalize the size of the fallback font to match the custom font. This minimizes the layout shift when the custom font loads. You can use online tools to calculate the correct `size-adjust` value.

**Code Example**
```css
/* Example for matching Arial to a custom font */
@font-face {
  font-family: 'FallbackFont';
  size-adjust: 95%; /* Adjust this value based on font metrics */
  src: local('Arial');
}

body {
  /* The browser will use the adjusted fallback font until YourAppFont loads */
  font-family: 'YourAppFont', 'FallbackFont', sans-serif;
}
```