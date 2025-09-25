 ### Improve Page Interactivity by Deferring Non-Essential JavaScript

- **Metric**: INP
- **Category**: javascript
- **Priority**: High
- **Effort**: Medium
- **Impact**: Reduces INP by 100ms-200ms

**Description**

A large JavaScript bundle is being downloaded and executed early during page load, which blocks the browser from responding to user interactions like clicks or typing. This leads to a poor Interaction to Next Paint (INP) score and makes the page feel sluggish.

**Implementation**

Split your JavaScript into smaller chunks. Load essential, interactive scripts with `defer` so they don't block parsing. Load scripts for non-critical features (e.g., social media widgets, analytics) after the page is interactive, either on a delay (`setTimeout`) or when the user scrolls them into view.

**Code Example**
```html
<!-- Critical interactive script, does not block HTML parsing -->
<script src="main-interactive.js" defer></script>

<!-- Non-critical script loaded after a 4-second delay -->
<script>
  setTimeout(() => {
    const script = document.createElement('script');
    script.src = 'heavy-analytics.js';
    document.body.appendChild(script);
  }, 4000);
</script>
```  