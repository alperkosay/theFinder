---
"@thefinder/core": patch
---

Security fixes from an audit of the engine and drivers:

- `parents` and `stats` no longer reveal files the `permission` callback hides.
- Folder uploads (`relativePath`) need write access on every folder they create or fill.
- `paste` with `conflict: "overwrite"` checks the target name and delete access on everything it replaces before deleting anything.
- On case-insensitive disks, a differently cased path ("/SECRET") no longer gets past `permission` rules or the reserved-folder check; a case-only rename no longer replaces another file on case-sensitive disks.
- `put` (new file) and `mkfile` respect `maxUploadSize` and `maxEditSize`, and S3 chunked uploads must add up to their declared size.
- New `maxRequestSize` option: POST bodies are capped, and the CSRF header is checked before the body is read.
- Presigned S3 URLs serve files with the type of their current name, so a renamed HTML file is not served as HTML.
