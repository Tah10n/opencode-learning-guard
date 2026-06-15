# opencode-learning-guard

Bounded write tools for OpenCode memory and agent-managed skills.

This package provides the deterministic enforcement layer for a controlled
self-improvement workflow. It does not decide what should be remembered. It
only validates and writes approved memory or managed-skill changes.

The project is inspired by the self-improving agent work in
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), but
is intentionally scoped to OpenCode memory and managed-skill write safety.

For the host orchestration profile that decides when these bounded write tools
should be used, see
[`opencode-harness`](https://github.com/Tah10n/opencode-harness).

## Naming

The repository and plugin package are named `opencode-learning-guard` to
emphasize that this package is an enforcement layer, not a decision-making
agent. The OpenCode tool ids keep the stable `oc_learning_*` prefix for
compatibility with existing harness permissions and installed profiles.

## Tools

Plugin export names:

- `oc_learning_memory_list`
- `oc_learning_memory_audit`
- `oc_learning_memory_add`
- `oc_learning_memory_replace`
- `oc_learning_memory_remove`
- `oc_learning_skill_create`
- `oc_learning_skill_patch`
- `oc_learning_skill_archive`

The raw tool module is also kept in `src/tools.js` so an OpenCode config can
sync it into `tools/oc_learning.js` when using OpenCode custom tools directly.

## Safety model

- Compact global memory only.
- Per-entry and total memory caps.
- Read-only cleanup audit before curation.
- Secret and prompt-injection scanner.
- Realpath-based path confinement to the configured OpenCode root.
- Backups before mutation.
- Managed-skill boundary: tools refuse unmanaged skills unless explicitly
  approved through the host permission flow.
- Archive instead of delete for managed skills.

## What this is not

This is not an autonomous self-modifying agent. The host profile owns policy,
review, and approval. This package only enforces bounded writes once a change is
approved.

## Usage

Install this package as an OpenCode plugin with an explicit `configRoot` option:

```json
{
  "plugin": [
    ["opencode-learning-guard", { "configRoot": "C:\\Users\\you\\.config\\opencode" }]
  ]
}
```

The plugin also accepts `config_root` or the `OPENCODE_CONFIG_ROOT` environment
variable. It intentionally fails closed without one so an installed package does
not write to its own package directory by mistake.

Use the smallest tool surface that fits the active profile:

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

- `all` / `improver`: expose every `oc_learning_*` tool.
- `memory-read`: expose `oc_learning_memory_list` and `oc_learning_memory_audit`.
- `memory-write`: expose memory audit/list/add/replace/remove tools.
- `skills-write`: expose managed-skill create/patch/archive tools.
- `none`: expose no tools.

For tighter control, pass `enabledTools` with explicit tool ids. See
[`docs/operational-policy.md`](docs/operational-policy.md) for the recommended
read/write gates that keep memory useful instead of noisy.

For memory cleanup, run `oc_learning_memory_audit` first. It reports duplicate,
oversized, unsafe, capacity-pressure, and scope-review candidates without
mutating files. Apply reviewed cleanup with `oc_learning_memory_remove` or
`oc_learning_memory_replace`; both create backups before writes and can target a
guarded `entry_number` when duplicates make substring matching ambiguous.

For host profiles that use OpenCode custom-tool files directly, `src/tools.js`
is also kept as a standalone tool module that can be copied into the host
configuration by that profile's own configuration management. In that mode the
default root is the parent directory of the copied module.

This repository intentionally does not prescribe a host configuration-management workflow.
