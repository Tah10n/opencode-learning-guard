# Threat Model

The main risks are prompt pollution, secret persistence, unsafe broad skills,
and uncontrolled self-modification.

Mitigations:

- Reject obvious credentials and private keys.
- Reject prompt-injection style instructions.
- Keep memory entries small.
- Enforce total memory capacity.
- Refuse unmanaged skill mutation by default, and require a host permission
  prompt before the explicit unmanaged override can proceed.
- Resolve existing paths through `realpath` before reads, writes, backups, and
  archives so symlinks or junctions cannot escape the configured root.
- Trust the managed-skill marker only when it appears in YAML frontmatter as
  `metadata.managed_by: oc_learning`.
- Never mutate `AGENTS.md`, `opencode.json`, agent definitions, plugins, or
  product repositories through these tools.

The plugin should stay a write guard, not a policy brain.
