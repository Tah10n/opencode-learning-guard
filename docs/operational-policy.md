# Operational Policy

The learning guard is useful only when the host harness keeps memory operations
rare, scoped, and reviewable. It should not be treated as an always-on memory
layer for every agent turn.

## Tool Exposure

Use the smallest tool surface that fits the active profile:

- Ordinary coding and review profiles should not load this plugin at all, or
  should use `toolset: "none"` when the host needs a shared plugin stanza.
- Read-only memory inspection profiles should use `toolset: "memory-read"`.
- Memory maintenance profiles should use `toolset: "memory-write"`.
- Managed-skill maintenance profiles should use `toolset: "skills-write"`.
- Dedicated improver profiles may use `toolset: "improver"`.

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

## Memory Read Gate

Read memory only when there is a realistic chance it will change the answer:

- non-trivial repository work;
- repeated problems;
- OpenCode configuration or harness work;
- tasks that reference previous decisions, conventions, or workflow details.

Do not read memory for simple commands, translations, one-off formatting, or
questions that are obviously self-contained.

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
with `oc_learning_memory_audit`; it is read-only and should be allowed anywhere
that `oc_learning_memory_list` is allowed.

The audit catches mechanical cleanup candidates:

- exact or normalized duplicate entries;
- entries over or near the per-entry limit;
- safety-scanner hits that should be removed or redacted;
- capacity pressure;
- entries that look project- or machine-specific and may belong in project-local docs.

After review, apply cleanup with the mutating tools:

- remove stale entries;
- merge duplicates;
- move project facts out of global memory;
- keep only rules that have changed real future behavior.

Use `entry_number` plus `expected_content` with `oc_learning_memory_remove` or
`oc_learning_memory_replace` when duplicate entries make `old_text` ambiguous.
Do not auto-apply audit findings without review; staleness and scope still need
human judgment.

## Token Budget

The plugin itself does not inject memory into prompts. Token cost comes from the
host choosing to expose tool definitions or inject memory content. Keep both
bounded by using narrow toolsets and reading memory only through the read gate.
