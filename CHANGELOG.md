# Changelog

## 0.2.0 - 2026-06-24

### Breaking Behavior

- Default plugin tool exposure is now fail-closed: omitting `toolset` and
  `enabledTools` exposes zero tools instead of all write tools.
- The package entrypoint no longer exports import-time pre-bound memory or skill
  tool objects. Use `createLearningGuardTools({ configRoot })` or the OpenCode
  plugin entrypoint.
- Malformed memory documents are no longer treated as empty or repaired
  implicitly. Read tools return structured errors, and mutations refuse to
  proceed until the document is repaired or restored.
- Managed skill mutation now requires structurally valid frontmatter with
  `metadata.managed_by: oc_learning` and `metadata.origin: agent-created`.
- Copied custom-tool mode uses a wrapper plus sibling core module:
  `standalone.js` copied as `tools/oc_learning.js` and `tools.js` copied next to
  it as `tools/tools.js`.

### Security

- Made `memory_list` and `memory_audit` byte-for-byte read-only.
- Added strict memory frontmatter and marker validation.
- Added redaction for unsafe stored memory in read and audit output.
- Added SHA-256 revisions and optional optimistic concurrency guards.
- Added in-process and heartbeated cross-process mutation locks.
- Replaced direct writes with crash-safer transaction writes, backups, manifests,
  temp files, post-write validation, and rollback.
- Restricted normal outputs and expected validation errors to relative paths.
- Refused symlinked or junctioned skill archive paths before moving the skill
  directory into the archive.
- Made skill archive recover from post-move failures and treat final manifest
  status updates as best-effort after the archive move is committed.
- Added archive manifests and collision-safe archive destinations.
- Kept oversized and over-capacity legacy memory states audit-cleanable through
  reviewed remove/replace mutations.

### Fixed

- Made copied standalone mode independent of repo-local `node_modules` by moving
  OpenCode plugin and Effect adapters out of the copied core module.

### Tests

- Added negative tests for read-only guarantees, tool exposure, malformed memory,
  scanner behavior, revision conflicts, concurrency, atomic failure injection,
  skill structure, archive serialization, linked archive paths, path leakage,
  isolated copied-wrapper loading, package schema adapter loading, and repo-local
  package-cache verification.
