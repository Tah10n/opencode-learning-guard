# Design

The learning guard separates policy from enforcement.

Policy belongs to the host harness, prompts, skills, user review, and explicit
approval flow:

- decide whether a lesson is durable;
- decide whether a skill should exist;
- decide when an improver profile may run;
- decide backup retention and cleanup.

Enforcement belongs to this package:

- expose only explicitly selected tools;
- require an explicit config root for writable tools;
- validate memory and managed-skill documents structurally;
- reject unsafe content patterns and reserved markers;
- keep read tools pure;
- serialize mutations;
- write through backup, temp file, atomic replace, and post-write validation;
- return deterministic relative-path JSON results.

This package does not inject memory into prompts. Token cost is controlled by
the host choosing when to expose tools or read memory.

The package is intentionally narrow: it writes only global memory, managed
skills, backups, locks, and archives under the configured OpenCode config root.
It does not provide a generic file patch tool.
