# Operational Policy

`opencode-learning-guard` is useful only when the host harness keeps memory and
skill writes rare, scoped, and reviewable. It is a deterministic enforcement
layer, not an always-on memory agent.

## Tool Exposure

The default toolset is `none`. A plugin stanza without `toolset` or
`enabledTools` exposes zero tools.

Use the smallest explicit surface that fits the active profile:

- Ordinary coding and review profiles should not load this plugin, or should
  use `toolset: "none"` when a shared plugin stanza is needed.
- Read-only memory inspection profiles should use `toolset: "memory-read"`.
- Memory maintenance profiles should use `toolset: "memory-write"`.
- Managed-skill maintenance profiles should use `toolset: "skills-write"`.
- Dedicated reviewed improver profiles may use `toolset: "improver"` or `all`.

For tighter control, use `enabledTools` with explicit OpenCode tool ids:

```json
{
  "plugin": [
    [
      "opencode-learning-guard",
      {
        "configRoot": "C:\\Users\\you\\.config\\opencode",
        "enabledTools": [
          "oc_learning_memory_list",
          "oc_learning_memory_audit",
          "oc_learning_memory_add"
        ]
      }
    ]
  ]
}
```

Unknown toolsets and unknown tool ids fail closed.

## Memory Read Gate

Read memory only when there is a realistic chance it will change the answer:

- non-trivial repository work;
- repeated problems;
- OpenCode configuration or harness work;
- tasks that reference previous decisions, conventions, or workflow details.

`oc_learning_memory_list` and `oc_learning_memory_audit` do not initialize
memory. If the memory file is absent, they return an absent/no-entry result
without creating directories, locks, backups, or timestamps.

## Memory Write Gate

Persist only durable lessons that meet all of these conditions:

- The lesson is likely to matter again.
- It is verified by the current work, not guessed.
- It is compact enough to stay useful as context.
- It contains no secrets, raw logs, stack traces, or temporary paths.
- Its scope is clear: global OpenCode behavior or a specific project/domain.

Project-specific facts should normally live in project-local workflow docs or
project-local skills. Global memory should stay project-neutral unless the entry
is explicitly scoped.

## Review And Compaction

When memory approaches the total cap, consolidate instead of appending. Start
with `oc_learning_memory_audit`; it is read-only and returns the current
`revision`.

The audit catches mechanical cleanup candidates:

- exact or normalized duplicate entries;
- entries over or near the per-entry limit;
- safety-scanner hits that should be removed or redacted;
- capacity pressure;
- entries that look project- or machine-specific and may belong in project-local docs.

After review, apply cleanup with mutating tools:

- remove stale entries;
- merge duplicates;
- move project facts out of global memory;
- keep only rules that have changed real future behavior.

Use `entry_number` plus `expected_revision` with
`oc_learning_memory_remove` or `oc_learning_memory_replace` when content is
unsafe, duplicated, or likely to shift. Use `expected_content` as an additional
guard when the current entry is safe to show.

Entries that exceed the per-entry or total memory limit remain audit-cleanable:
`oc_learning_memory_audit` reports them with entry numbers and the current
revision, and reviewed remove/replace operations may reduce those violations
without requiring manual file repair first.

Do not auto-apply audit findings without review. Staleness and scope still need
human judgment.

## Backups And Recovery

Every mutation creates an operation manifest under `.oc_learning/backups/`.
When the target already exists, the same operation directory also contains an
exact backup of the previous target bytes. Outputs return relative paths only.

Backups are not deleted automatically. Retention is intentionally a host policy
decision and should be implemented as a separate reviewed maintenance command,
not as an implicit side effect of these tools.

## Token Budget

The plugin itself does not inject memory into prompts. Token cost comes from the
host choosing to expose tool definitions or inject memory content. Keep both
bounded by using narrow toolsets and reading memory only through the read gate.
