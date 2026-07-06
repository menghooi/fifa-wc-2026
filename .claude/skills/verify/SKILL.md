---
name: verify
description: How to run and verify the FIFA WC 2026 static site locally
---

# Verify this project

Static site — no build step for the app itself.

1. Regenerate data if `scripts/build-wcdata.mjs` changed: `node scripts/build-wcdata.mjs` (writes `project/wcData.js`; needs network for openfootball + ESPN).
2. Serve the repo root: `python -m http.server 8137` (run in background) and open `http://localhost:8137/index.html` in Chrome via claude-in-chrome.
3. Gotchas:
   - Chrome-extension screenshots can wedge on this page ("Page still loading … document_idle") even though `document.readyState==='complete'`. Fall back to `javascript_tool` DOM queries and drive the UI via `element.click()` — the React handlers fire normally.
   - Every fixture-row label span appears TWICE in the DOM (dc-runtime renders a mirror copy). Count 2 per match, not 1 — it is not a duplicate fixture.
   - A console error `sibling fetch for <Slot/> failed: ./Slot.dc.html returned 404` is pre-existing and harmless (Slot/Flag are pre-registered inline in index.html).
   - Mobile layout: force it with `document.body.style.maxWidth='430px'; window.dispatchEvent(new Event('resize'))` (breakpoint is wrap width < 760px).
4. Flows worth driving: bracket boxes → match modal; header tabs (Bracket/Groups/Fixtures/Road); mobile round pills; check `polyline[points]` for NaN after geometry changes.
