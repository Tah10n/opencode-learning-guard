# Atomicity And Recovery

Mutating tools use a shared transaction path for memory and skill document
writes.

## Write Sequence

For document mutations, the package:

1. Acquires the per-target in-process mutex.
2. Acquires a cross-process lock under `.oc_learning/locks/`.
3. Canonicalizes the target under the configured root.
4. Reads current bytes and computes the SHA-256 revision.
5. Checks optional `expected_revision`.
6. Builds the next document.
7. Validates the full next document.
8. Creates an operation directory under `.oc_learning/backups/`.
9. Copies exact previous bytes when the target already exists.
10. Writes a manifest without memory or skill body content.
11. Writes the next bytes to an exclusive temp file in the target directory.
12. Flushes the temp file where the platform supports it.
13. Renames the temp file over the target.
14. Best-effort fsyncs the parent directory.
15. Re-reads the target, checks the revision, and validates the document again.
16. Rolls back from backup if post-write validation fails.
17. Removes temp and lock files in `finally` paths.

The package never uses a delete-then-write replacement path for document
updates.

## Platform Notes

On POSIX filesystems, rename over an existing file is atomic within the same
directory. On Windows, Node's `fs.rename` replaces the existing file when the
destination is a file and no external process holds an incompatible handle.

Directory fsync is best effort. Some platforms reject directory handles; those
errors are ignored after the target file has been flushed and renamed.

## Locks

Lock files are named from a SHA-256 hash of the relative target path. They do
not include user input, memory content, or secrets. Active holders refresh the
lock mtime with a heartbeat while the mutation is in progress. Contenders have
bounded wait and stale-lock handling; a stale-looking lock is recoverable only
when the lock payload is missing an owner or the recorded owner process no
longer appears alive. A long-running live mutation is not treated as stale just
because it exceeds the configured stale threshold.

Read-only tools never create locks.

## Revision Conflicts

Read and audit tools return `revision`, a SHA-256 hash of the exact file bytes.
Mutating tools accept optional `expected_revision`. If the current file revision
differs after the lock is acquired, the mutation fails with a conflict and does
not create a backup or alter the target.

## Backups

Each mutation creates a manifest under `.oc_learning/backups/<operation-id>/`.
When a previous target exists, the same directory stores an exact byte-for-byte
backup. Tool outputs expose only relative paths.

Backup manifests include operation id, timestamp, operation type, relative
target, before revision, intended after revision, relative backup path, and
status. They do not include memory entries, skill bodies, secret previews, or
absolute local paths.

Skill archive refuses symlinked or junctioned components in `skills/<name>`
before it moves the skill directory into `.oc_learning/archive/`. This keeps
archive semantics on ordinary package-owned skill directories instead of
following a linked target.

## Recovery

If a mutation fails before rename, the target remains at the old revision and
the temp file is removed.

If post-write validation fails, the package restores the old bytes from the
backup and marks the manifest as rolled back. If restore itself fails, the
manifest is marked rollback-failed so the host can recover manually from the
relative backup path.

For skill archives, the source directory is moved with a directory rename after
archive metadata is prepared. If post-move verification fails before the archive
is reported as committed, the package attempts to rename the archived source
back to `skills/<name>`. Once that move is verified, later manifest status
updates are best-effort; the tool result is authoritative if only that status
update cannot be written.

Backups are never deleted automatically.
