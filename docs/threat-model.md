# Threat Model

The primary risks are prompt pollution, secret persistence, unsafe broad skills,
silent data loss, path escape, and uncontrolled self-modification.

## Non-Goals

The package does not:

- decide what should be remembered;
- evaluate whether a lesson is true;
- initiate self-improvement;
- edit product code;
- write arbitrary OpenCode files;
- bypass host permissions;
- execute shell commands;
- become an autonomous self-modifying agent.

## Trust Boundaries

Inputs from agents, model output, existing memory files, and existing skill files
are untrusted. A user or older package version may have manually written unsafe
content, malformed frontmatter, duplicated markers, or machine-local paths.

The configured OpenCode config root is the only write boundary. Writable APIs
require an explicit `configRoot`, `config_root`, or `OPENCODE_CONFIG_ROOT` from
the plugin entrypoint. The package entrypoint does not create pre-bound tools
that point at the installed package directory.

## Mitigations

- Default plugin exposure is `none`.
- `memory-read` exposes only list and audit.
- `memory_list` and `memory_audit` do not create state.
- Memory structure is parsed strictly: closed frontmatter, required managed
  metadata, exactly one canonical marker block, capacity limits, and no reserved
  markers inside entries.
- Unsafe stored memory is redacted in list/audit output.
- Mutations support SHA-256 `expected_revision` guards and re-check revisions
  after acquiring the lock.
- Mutations are serialized by target path with an in-process mutex and a
  heartbeated cross-process lock file under `.oc_learning/locks/`.
- Writes use backup, temp file, fsync best effort, atomic rename/replace,
  post-write validation, and rollback from backup on validation failure.
- Backups, archives, and manifests are path-confined under `.oc_learning/`.
- Skill archive refuses symlinked or junctioned `skills/<name>` path components
  before moving the skill directory into the archive.
- Normal outputs and expected validation errors return relative paths only.
- Managed-skill detection is based on YAML frontmatter metadata, not body text.
- Unmanaged skill patching requires `allow_unmanaged` and a host `context.ask`
  approval prompt with a narrow `skills/<name>/SKILL.md` pattern.
- `global-memory` cannot be archived through skill archive.

## Scanner Scope

The scanner checks original and Unicode-normalized text for:

- common secret assignment forms;
- private-key blocks;
- prompt-injection patterns;
- bidi and invisible control characters;
- reserved memory markers.

It is a heuristic defense-in-depth layer. It does not guarantee absence of
secrets, prove truth, select durable lessons, or replace human semantic review.

## Known Limitations

- Atomic replace strength depends on platform filesystem semantics. The package
  avoids delete-then-write fallbacks and documents the best-effort guarantees in
  `docs/atomicity-and-recovery.md`.
- Lock files protect cooperating processes using this package. They cannot stop
  unrelated editors or tools that write the same files without the lock.
- The scanner intentionally avoids broad regexes that would block ordinary
  documentation; a human review gate is still required.
