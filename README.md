# opencode-learning-guard

Deterministic enforcement tools for bounded OpenCode memory and agent-managed
skills.

This package is an enforcement layer, not a policy agent. It does not decide
what should be remembered, evaluate whether a lesson is true, initiate
self-improvement, edit product code, or write arbitrary OpenCode files. It only
validates and applies explicitly requested changes to:

- `skills/global-memory/SKILL.md`
- managed skills under `skills/<name>/SKILL.md`
- package-owned state under `.oc_learning/`

The OpenCode tool ids keep the stable `oc_learning_*` prefix for compatibility
with existing host permissions.

## Tools

Stable tool ids:

- `oc_learning_memory_list`
- `oc_learning_memory_audit`
- `oc_learning_memory_add`
- `oc_learning_memory_replace`
- `oc_learning_memory_remove`
- `oc_learning_skill_create`
- `oc_learning_skill_patch`
- `oc_learning_skill_archive`

## Usage

Install this package as an OpenCode plugin with an explicit config root:

```json
{
  "plugin": [
    ["opencode-learning-guard", { "configRoot": "C:\\Users\\you\\.config\\opencode" }]
  ]
}
```

The plugin also accepts `config_root` or `OPENCODE_CONFIG_ROOT`. It fails closed
without one.

The default toolset is `none`. Expose tools explicitly:

```json
{
  "plugin": [
    [
      "opencode-learning-guard",
      {
        "configRoot": "C:\\Users\\you\\.config\\opencode",
        "toolset": "memory-read"
      }
    ]
  ]
}
```

Available toolsets:

- `none`: expose no tools.
- `memory-read`: expose only list and audit.
- `memory-write`: expose memory list/audit/add/replace/remove.
- `skills-write`: expose managed-skill create/patch/archive.
- `all` / `improver`: expose every `oc_learning_*` tool.

`enabledTools` is an explicit allowlist and takes priority over `toolset`.
Unknown ids and unknown toolsets are rejected.

## Programmatic API

The package entrypoint exports only the plugin and the unbound factory:

```js
import { createLearningGuardTools } from "opencode-learning-guard"

const tools = createLearningGuardTools({ configRoot: "/home/me/.config/opencode" })
```

There is no import-time writable default instance. Write-capable tools require
an explicit `configRoot`.

For package-installed OpenCode custom-tool files, import
`opencode-learning-guard/standalone` and set `OPENCODE_CONFIG_ROOT`.

For hosts that sync tool files directly into the OpenCode config root, copy both
files together:

- `src/standalone.js` -> `<config-root>/tools/oc_learning.js`
- `src/tools.js` -> `<config-root>/tools/tools.js`

The wrapper infers the config root only from the copied
`<config-root>/tools/oc_learning.js` placement.
Copied mode does not require repo-local `node_modules`; package-installed mode
uses the OpenCode package adapters when they are available.

## Runtime Guarantees

- `memory_list` and `memory_audit` are read-only. If memory is absent they do
  not create `skills/`, `global-memory/`, `.oc_learning/`, locks, or backups.
- Mutations compute and accept SHA-256 `expected_revision` guards.
- Mutations are serialized with an in-process mutex plus a heartbeated
  cross-process lock in `.oc_learning/locks/`.
- Writes use temp files in the target directory, best-effort fsync, atomic
  rename/replace, post-write validation, and rollback from backup on validation
  failure.
- Backups and manifests live under `.oc_learning/backups/` and are reported as
  relative paths only.
- Skill archives live under `.oc_learning/archive/` and are reported as
  relative paths only.
- Skill archive refuses symlinked or junctioned `skills/<name>` path components
  before moving the skill directory into the archive.
- After a successful archive move, manifest status updates are best-effort; the
  JSON tool result is authoritative if only that status update fails.
- Normal results and expected validation errors avoid absolute local paths.

Tool results are JSON strings with stable fields such as `status`, `operation`,
`target`, `before_revision`, `after_revision`, `backup`, `changed`, and
`warnings`.

## Safety Scanner

The scanner is defense-in-depth. It rejects common secret assignment forms,
private-key blocks, prompt-injection language, bidi/invisible controls, and
reserved memory structure markers in original and normalized text. It does not
prove absence of secrets, truth of lessons, or correct policy scope.

Unsafe entries found in an existing memory file are redacted by read tools.
Use `memory_audit` to get entry numbers and the current revision, then remove by
`entry_number` plus `expected_revision`.

Oversized legacy entries and over-capacity memory blocks are also reported by
`memory_audit` as cleanup findings so they can be removed or replaced through
reviewed guard-tool mutations.

## Documentation

- [Operational policy](docs/operational-policy.md)
- [Threat model](docs/threat-model.md)
- [Atomicity and recovery](docs/atomicity-and-recovery.md)
- [Design notes](docs/design.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
