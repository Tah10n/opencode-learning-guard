# Design

The learning guard separates policy from enforcement.

This design is inspired by the self-improving agent direction in
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), while
keeping this package focused on bounded OpenCode memory and managed-skill
writes.

Policy:

- Agent prompts and skills decide whether a lesson is durable.
- The user can ask for `/learn` or `@improver`.
- Project-specific facts belong in project-local workflow docs or skills.

Enforcement:

- This package validates content.
- This package writes only confined memory or managed-skill files.
- This package creates backups before mutations.
- This package can expose a narrowed toolset so ordinary profiles do not pay
  for unrelated write tools.
- Memory cleanup starts with a read-only audit. Deletion and replacement stay
  explicit, reviewed, and backed up.

This keeps the self-improvement loop useful without letting it rewrite the
agent operating environment opportunistically.

Token cost is a host-harness concern. This package does not inject memory into
prompts; it only provides tools that the host may expose to selected profiles.
