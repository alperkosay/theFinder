---
"@thefinder/react": patch
---

Dialogs stay centered under CSS resets that zero every margin (Tailwind v4 preflight, shadcn/ui) instead of sticking to the top left corner. Window-like dialogs (storage, version history, image optimization, Quick Look, code and image editors) can now be moved by their title bar, like the file picker; double click the title bar to center again. Confirmation and prompt dialogs stay put.
