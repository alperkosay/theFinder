---
"@thefinder/react": minor
---

theFinder can run in its own browser window, like elFinder: `openFilePicker({ popup: true })` (or `useFilePicker`, or the CKEditor connector's `picker` option) opens the picker in a popup and resolves the same way, and `openFinderWindow(props)` opens the whole file manager. The window renders from the opening page with its stylesheets, so there is no extra page to serve. If the browser blocks the popup, the picker falls back to the dialog.
