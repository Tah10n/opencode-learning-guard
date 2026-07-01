# Security Policy

Report security issues through GitHub private vulnerability reporting when it is
available for the repository. If that is unavailable, open an issue with a
minimal description and ask for a private contact path before sharing exploit
details or secrets.

## Scope

Security-sensitive areas include:

- writes outside the configured OpenCode config root;
- exposure of absolute local paths, usernames, or home directories;
- leaked memory contents, secrets, private keys, or prompt text in outputs;
- mutation without explicit tool exposure;
- mutation without explicit config root;
- silent data loss during concurrent or failed writes;
- bypass of unmanaged-skill host approval;
- malformed memory or skill files being silently repaired or treated as safe.

## Non-Scope

The scanner is heuristic. A missed secret pattern is useful to report, but the
package does not claim to prove that arbitrary text is secret-free or true.

## Operational Guidance

Use the smallest toolset possible, prefer `memory-read` for inspection, and pass
`expected_revision` for reviewed mutations. Keep backups until a separate
reviewed retention policy exists.
