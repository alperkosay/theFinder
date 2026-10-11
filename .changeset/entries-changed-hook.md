---
"@thefinder/core": minor
---

Add the `onEntriesChanged` option. It is called after storage changes that move, remove, restore or replace existing entries, with structured events (`moved`, `trashed`, `restored`, `deleted`, `purged`, `replaced`), so an application that refers to files by its own id (for example a CMS with a `uuid → path` table) can keep up when a path changes. One call per command, before `onAfterCommand`; a folder is a single event; paths are the real outcome (a clash rename, a restore to another name); a command that fails half way still reports what it did. Items removed by the trash retention period are reported as `purged`. `EntryChange` is exported. Nothing changes when the option is not set.
