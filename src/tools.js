import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export const MEMORY_NAME = "global-memory"
export const MEMORY_REL = "skills/global-memory/SKILL.md"
export const MEMORY_CHAR_LIMIT = 4000
export const MEMORY_ENTRY_LIMIT = 280
export const SKILL_BODY_LIMIT = 12000
export const ARCHIVE_REASON_LIMIT = 500
export const ENTRY_START = "<!-- oc-memory-entries:start -->"
export const ENTRY_END = "<!-- oc-memory-entries:end -->"

const MARKER_RE = /<!--\s*oc-memory-entries\s*:\s*(?:start|end)\s*-->/i
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 25
const LOCK_HEARTBEAT_MIN_MS = 10
const inProcessLocks = new Map()

function standaloneSchema() {
  const schema = {
    describe(description) {
      return { ...schema, description }
    },
    optional() {
      return { ...schema, optional: true }
    },
  }
  return schema
}

function standaloneTool(input) {
  return input
}

standaloneTool.schema = {
  string: standaloneSchema,
  boolean: standaloneSchema,
}

class GuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "GuardError"
    this.code = code
  }
}

class ConflictError extends GuardError {
  constructor() {
    super("revision_conflict", "Revision conflict: target changed before mutation. Re-read state and retry with the current revision.")
  }
}

function stableJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function revisionForBytes(bytes) {
  return bytes ? sha256Bytes(bytes) : null
}

function posixRel(...parts) {
  return parts.join("/").replace(/\/+/g, "/")
}

function fromRoot(root, rel) {
  return path.resolve(root, ...rel.split("/"))
}

function normalizeRel(rel) {
  return rel.replace(/\\/g, "/").replace(/^\/+/, "")
}

function errorMessage(error) {
  if (error instanceof GuardError || error instanceof ConflictError) return error.message
  return error?.message ?? String(error)
}

function heartbeatMs(staleMs) {
  return Math.max(LOCK_HEARTBEAT_MIN_MS, Math.min(1000, Math.floor(staleMs / 3)))
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate)
    return true
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false
    throw error
  }
}

async function readFileIfExists(candidate) {
  try {
    return await fs.readFile(candidate)
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null
    throw error
  }
}

async function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate)
  while (!(await pathExists(current))) {
    const parent = path.dirname(current)
    if (parent === current) {
      throw new GuardError("config_root_unavailable", "Configured root has no existing ancestor.")
    }
    current = parent
  }
  return current
}

function assertInside(realRoot, realCandidate, relForMessage) {
  const rel = path.relative(realRoot, realCandidate)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new GuardError("path_escape", `Path escapes configured root: ${relForMessage}`)
  }
  return realCandidate
}

function requireExplicitConfigRoot(options = {}) {
  const root = options.configRoot ?? options.config_root
  if (typeof root !== "string" || !root.trim()) {
    throw new GuardError("config_root_required", "configRoot must be an explicit non-empty path string.")
  }
  return path.resolve(root)
}

async function fsyncFile(handle) {
  try {
    await handle.sync()
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error
  }
}

async function fsyncDirectory(dir) {
  let handle = null
  try {
    handle = await fs.open(dir, "r")
    await handle.sync()
  } catch (error) {
    if (!["EISDIR", "EINVAL", "ENOTSUP", "EPERM", "EBADF"].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function writeFileExclusiveDurable(file, bytes) {
  const handle = await fs.open(file, "wx")
  try {
    await handle.writeFile(bytes)
    await fsyncFile(handle)
  } finally {
    await handle.close()
  }
}

async function writeJson(file, payload) {
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

async function atomicReplace(target, bytes, opId) {
  const dir = path.dirname(target)
  const temp = path.join(dir, `.${path.basename(target)}.${opId}.tmp`)
  await writeFileExclusiveDurable(temp, bytes)
  try {
    await fs.rename(temp, target)
    await fsyncDirectory(dir)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function withInProcessLock(key, fn, onCleanup) {
  const previous = inProcessLocks.get(key) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current, () => current)
  inProcessLocks.set(key, queued)
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (inProcessLocks.get(key) === queued) inProcessLocks.delete(key)
    await onCleanup?.({ key, size: inProcessLocks.size })
  }
}

function lockNameForTarget(rel) {
  return `${sha256Bytes(Buffer.from(rel, "utf8"))}.lock`
}

async function readLockPayload(lockFile) {
  try {
    const text = await fs.readFile(lockFile, "utf8")
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null
    throw error
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

async function ownsLock(lockFile, lockId) {
  const payload = await readLockPayload(lockFile)
  return payload?.lock_id === lockId
}

async function staleLockIsRecoverable(lockFile) {
  const payload = await readLockPayload(lockFile)
  if (!payload?.lock_id || !Number.isInteger(payload.pid)) return true
  return !isProcessAlive(payload.pid)
}

async function acquireProcessLock({ lockDir, targetRel, timeoutMs, staleMs }) {
  await fs.mkdir(lockDir, { recursive: true })
  const lockFile = path.join(lockDir, lockNameForTarget(targetRel))
  const started = Date.now()
  const lockId = randomUUID()
  const payload = {
    lock_id: lockId,
    target: targetRel,
    pid: process.pid,
    created_at: new Date().toISOString(),
  }

  while (true) {
    let handle = null
    try {
      handle = await fs.open(lockFile, "wx")
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8")
      await fsyncFile(handle)
      await handle.close()
      handle = null
      await fsyncDirectory(lockDir)
      let heartbeat = null
      let released = false
      const touch = async () => {
        if (released) return
        try {
          if (!(await ownsLock(lockFile, lockId))) return
          const now = new Date()
          await fs.utimes(lockFile, now, now)
        } catch {
          // Ownership is asserted at commit points; heartbeat failures only
          // make contenders wait or time out instead of authorizing writes.
        }
      }
      heartbeat = setInterval(() => {
        touch()
      }, heartbeatMs(staleMs))
      heartbeat.unref?.()
      return {
        lockId,
        lockFile,
        async assertHeld() {
          if (!(await ownsLock(lockFile, lockId))) {
            throw new GuardError("lock_lost", "Mutation lock was lost before commit. Retry the operation.")
          }
        },
        async release() {
          released = true
          if (heartbeat) clearInterval(heartbeat)
          try {
            if (!(await ownsLock(lockFile, lockId))) return
          } catch (error) {
            if (error?.code === "ENOENT") return
            throw error
          }
          await fs.rm(lockFile, { force: true })
        },
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code !== "EEXIST") throw error
      try {
        const stat = await fs.stat(lockFile)
        if (Date.now() - stat.mtimeMs > staleMs) {
          if (await staleLockIsRecoverable(lockFile)) {
            await fs.rm(lockFile, { force: true })
            continue
          }
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError
      }
      if (Date.now() - started >= timeoutMs) {
        throw new GuardError("lock_timeout", "Timed out waiting for mutation lock.")
      }
      await sleep(LOCK_POLL_MS)
    }
  }
}

function parseYamlScalar(raw) {
  const trimmed = `${raw ?? ""}`.trim()
  if (!trimmed) return ""
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function parseFrontmatter(source) {
  const result = {}
  const errors = []
  let parent = null
  const seenTop = new Set()
  const seenNested = new Map()

  source.split(/\r?\n/).forEach((rawLine, index) => {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) return
    const indent = rawLine.match(/^\s*/)[0].length
    const match = rawLine.trim().match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
    if (!match) {
      errors.push(`frontmatter line ${index + 1} is malformed`)
      return
    }
    const [, key, rawValue = ""] = match
    if (indent === 0) {
      if (seenTop.has(key)) errors.push(`frontmatter key '${key}' is duplicated`)
      seenTop.add(key)
      if (!rawValue) {
        result[key] = {}
        parent = key
        seenNested.set(key, new Set())
      } else {
        result[key] = parseYamlScalar(rawValue)
        parent = null
      }
      return
    }
    if (indent !== 2 || !parent || typeof result[parent] !== "object" || result[parent] === null) {
      errors.push(`frontmatter line ${index + 1} has invalid nesting`)
      return
    }
    const nestedSeen = seenNested.get(parent)
    if (nestedSeen.has(key)) errors.push(`frontmatter key '${parent}.${key}' is duplicated`)
    nestedSeen.add(key)
    result[parent][key] = parseYamlScalar(rawValue)
  })

  return { data: result, errors }
}

function splitFrontmatterDocument(content) {
  const lines = content.split(/\r?\n/)
  const errors = []
  if (lines[0] !== "---") {
    return { ok: false, errors: ["frontmatter must start with an opening delimiter"], data: null, bodyLines: [], closeLine: -1 }
  }
  const closeLine = lines.findIndex((line, index) => index > 0 && line === "---")
  if (closeLine === -1) {
    return { ok: false, errors: ["frontmatter is not closed"], data: null, bodyLines: [], closeLine: -1 }
  }
  const parsed = parseFrontmatter(lines.slice(1, closeLine).join("\n"))
  errors.push(...parsed.errors)
  return {
    ok: errors.length === 0,
    errors,
    data: parsed.data,
    bodyLines: lines.slice(closeLine + 1),
    closeLine,
  }
}

function yamlString(value) {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim())
}

function memoryTemplate() {
  return `---
name: ${MEMORY_NAME}
description: ${yamlString("Load at the start of non-trivial work to recall durable user preferences, environment facts, project conventions, and lessons learned across OpenCode sessions")}
license: MIT
compatibility: opencode
metadata:
  managed_by: oc_learning
  purpose: persistent-memory
---
# Global Memory

Compact durable notes for OpenCode. This is not a scratchpad.

Use this skill to recall facts that should survive across sessions: user preferences, stable environment facts, project conventions, tool quirks, and verified workflow lessons.

Do not store secrets, credentials, private keys, raw logs, large code blocks, temporary paths, or one-off task details. Raw logs may still be used transiently for diagnosis; persist only compact redacted lessons.

## Scope rules

- Treat project-prefixed entries as scoped hints, not global rules. Do not generalize project-specific logging guidance into a cross-project ban on raw logs.
- Apply a project entry only when the current repo, user request, file paths, or task context clearly match that project or domain.
- If a memory entry does not match the current context, ignore it silently instead of carrying its constraints into unrelated work.
- Prefer project-local \`WORKFLOW.md\` or project skills over global memory for repo-specific build, test, architecture, and behavior rules.

${ENTRY_START}
${ENTRY_END}
`
}

function parseMemoryDocument(content, { requireSafeEntries = false, enforceLimits = true } = {}) {
  const errors = []
  const limitErrors = []
  const front = splitFrontmatterDocument(content)
  errors.push(...front.errors)
  const metadata = front.data ?? {}
  if (metadata.name !== MEMORY_NAME) errors.push("frontmatter name must be global-memory")
  if (metadata.metadata?.managed_by !== "oc_learning") errors.push("frontmatter metadata.managed_by must be oc_learning")
  if (metadata.metadata?.purpose !== "persistent-memory") errors.push("frontmatter metadata.purpose must be persistent-memory")

  const bodyLines = front.bodyLines ?? []
  const markerLines = []
  bodyLines.forEach((line, index) => {
    const trimmed = line.trim()
    if (MARKER_RE.test(line)) {
      if (trimmed !== ENTRY_START && trimmed !== ENTRY_END) {
        errors.push(`memory marker on body line ${index + 1} must use the canonical standalone form`)
      }
      markerLines.push({ type: trimmed === ENTRY_START ? "start" : "end", index })
    }
  })

  const starts = markerLines.filter((marker) => marker.type === "start")
  const ends = markerLines.filter((marker) => marker.type === "end")
  if (starts.length !== 1) errors.push(`memory document must contain exactly one start marker; found ${starts.length}`)
  if (ends.length !== 1) errors.push(`memory document must contain exactly one end marker; found ${ends.length}`)
  let startIndex = -1
  let endIndex = -1
  if (starts.length === 1 && ends.length === 1) {
    startIndex = starts[0].index
    endIndex = ends[0].index
    if (endIndex <= startIndex) errors.push("memory end marker must appear after start marker")
  }

  const entries = []
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    bodyLines.slice(startIndex + 1, endIndex).forEach((line, index) => {
      if (!line.trim()) return
      const match = line.match(/^\s*-\s+(.+?)\s*$/)
      if (!match) {
        errors.push(`memory entry line ${index + 1} inside marker block must be a markdown list item`)
        return
      }
      const entry = match[1].trim()
      const structural = structuralEntryError(entry)
      if (structural) errors.push(`memory entry line ${index + 1}: ${structural}`)
      entries.push(entry)
    })
  }

  const renderedLength = entryBlockLength(entries)
  if (renderedLength > MEMORY_CHAR_LIMIT) {
    limitErrors.push(`memory entry block exceeds ${MEMORY_CHAR_LIMIT} chars`)
  }
  entries.forEach((entry, index) => {
    if (entry.length > MEMORY_ENTRY_LIMIT) {
      limitErrors.push(`memory entry #${index + 1} exceeds ${MEMORY_ENTRY_LIMIT} chars`)
    }
    if (requireSafeEntries) {
      const unsafe = scanUnsafeReason(entry, { entryMode: true })
      if (unsafe) errors.push(`memory entry #${index + 1} is unsafe: ${unsafe}`)
    }
  })
  if (enforceLimits) errors.push(...limitErrors)
  if (requireSafeEntries) {
    errors.push(...duplicateEntryErrors(entries))
  }

  return {
    ok: errors.length === 0,
    errors,
    limitErrors,
    entries,
    metadata,
    bodyLines,
    startIndex,
    endIndex,
  }
}

function renderMemoryDocument(parsed, entries) {
  const bodyLines = parsed.bodyLines
  const prefix = bodyLines.slice(0, parsed.startIndex + 1).join("\n")
  const suffix = bodyLines.slice(parsed.endIndex).join("\n").replace(/\n*$/, "")
  const entryBlock = entries.length ? `${entries.map((entry) => `- ${entry}`).join("\n")}\n` : ""
  const body = `${prefix}\n${entryBlock}${suffix}\n`
  const front = `---
name: ${MEMORY_NAME}
description: ${yamlString("Load at the start of non-trivial work to recall durable user preferences, environment facts, project conventions, and lessons learned across OpenCode sessions")}
license: MIT
compatibility: opencode
metadata:
  managed_by: oc_learning
  purpose: persistent-memory
---
`
  return `${front}${body}`
}

export function renderMemoryEntries(entries) {
  const parsed = parseMemoryDocument(memoryTemplate(), { requireSafeEntries: true })
  if (!parsed.ok) throw new GuardError("internal_error", "Internal memory template is invalid.")
  return renderMemoryDocument(parsed, entries)
}

export function parseRenderedMemoryEntries(content) {
  const parsed = parseMemoryDocument(content, { requireSafeEntries: true })
  if (!parsed.ok) throw new GuardError("malformed_memory", "Memory document is malformed.")
  return parsed.entries
}

function structuralEntryError(entry) {
  if (MARKER_RE.test(entry)) return "reserved memory marker is not allowed inside an entry"
  if (/^---$/.test(entry) || /\n---\n/.test(entry)) return "frontmatter delimiter is not allowed inside an entry"
  return null
}

function entryBlockLength(entries) {
  return entries.map((entry) => `- ${entry}`).join("\n").length
}

function normalizeWhitespace(text) {
  return `${text ?? ""}`.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function duplicateKey(entry) {
  return normalizeWhitespace(entry)
    .toLowerCase()
    .replace(/[`*_~[\]()#>"'.:,;!?-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function duplicateEntryErrors(entries) {
  const exact = new Map()
  const normalized = new Map()
  const errors = []
  entries.forEach((entry, index) => {
    const number = index + 1
    if (exact.has(entry)) errors.push(`memory entry #${number} duplicates entry #${exact.get(entry)}`)
    else exact.set(entry, number)
    const key = duplicateKey(entry)
    if (normalized.has(key)) errors.push(`memory entry #${number} normalizes to duplicate entry #${normalized.get(key)}`)
    else normalized.set(key, number)
  })
  return errors
}

function scanUnsafeReason(text, { entryMode = false } = {}) {
  const original = `${text ?? ""}`
  const normalized = original.normalize("NFKC")
  const candidates = [original, normalized]
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(original)) {
    return "contains invisible or bidi control characters"
  }
  for (const candidate of candidates) {
    if (MARKER_RE.test(candidate)) return "contains a reserved memory marker"
    if (entryMode && /(?:^|\n)---(?:\n|$)/.test(candidate)) return "contains a frontmatter delimiter"
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(candidate)) return "contains a private key block"
    if (/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|credential|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{6,}/i.test(candidate)) {
      return "contains a secret assignment pattern"
    }
    if (/\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions|rules|messages)/i.test(candidate)) {
      return "contains prompt-injection language"
    }
    if (/\b(?:reveal|print|dump|exfiltrate|send)\b.{0,100}\b(?:secret|token|password|credential|key|system prompt|developer message|hidden instructions)\b/i.test(candidate)) {
      return "contains prompt-injection exfiltration language"
    }
  }
  return null
}

function scanUnsafe(text, options) {
  const reason = scanUnsafeReason(text, options)
  if (reason) throw new GuardError("unsafe_content", `Rejected by safety scanner: ${reason}.`)
}

function normalizeEntry(content) {
  const normalized = normalizeWhitespace(content)
  if (!normalized) throw new GuardError("empty_entry", "Memory entry is empty.")
  if (normalized.length > MEMORY_ENTRY_LIMIT) {
    throw new GuardError("entry_too_large", `Memory entry is ${normalized.length} chars; keep it <= ${MEMORY_ENTRY_LIMIT} chars.`)
  }
  const structural = structuralEntryError(normalized)
  if (structural) throw new GuardError("reserved_structure", `Rejected memory entry: ${structural}.`)
  scanUnsafe(normalized, { entryMode: true })
  return normalized
}

function normalizeStoredEntry(content) {
  return normalizeWhitespace(content)
}

function safeDescription(description) {
  const value = normalizeWhitespace(description)
  if (!value || value.length > 1024) throw new GuardError("invalid_description", "Description must be 1-1024 chars.")
  scanUnsafe(value)
  return value
}

function safeBody(body) {
  const value = `${body ?? ""}`.trim()
  if (!value) throw new GuardError("empty_body", "Skill body is empty.")
  if (value.length > SKILL_BODY_LIMIT) throw new GuardError("body_too_large", `Skill body is too large (${value.length} chars > ${SKILL_BODY_LIMIT}).`)
  scanUnsafe(value)
  return value
}

function safeArchiveReason(reason) {
  const value = normalizeWhitespace(reason)
  if (!value) throw new GuardError("empty_archive_reason", "Archive reason is empty.")
  if (value.length > ARCHIVE_REASON_LIMIT) {
    throw new GuardError("archive_reason_too_large", `Archive reason is ${value.length} chars; keep it <= ${ARCHIVE_REASON_LIMIT} chars.`)
  }
  scanUnsafe(value)
  return value
}

function validateSkillName(name) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(`${name ?? ""}`) || `${name ?? ""}`.length > 64) {
    throw new GuardError("invalid_skill_name", "Invalid skill name. Use lowercase alphanumeric words separated by single hyphens, max 64 chars.")
  }
}

function skillFrontmatter(name, description) {
  return `---
name: ${name}
description: ${yamlString(description)}
license: MIT
compatibility: opencode
metadata:
  managed_by: oc_learning
  origin: agent-created
---
`
}

function validateSkillDocument(content, name, { requireManaged = false, requireOrigin = false } = {}) {
  const errors = []
  const front = splitFrontmatterDocument(content)
  errors.push(...front.errors)
  const metadata = front.data ?? {}
  if (metadata.name !== name) errors.push("frontmatter name must match skill directory")
  if (!metadata.description) errors.push("frontmatter description is required")
  if (requireManaged && metadata.metadata?.managed_by !== "oc_learning") {
    errors.push("frontmatter metadata.managed_by must be oc_learning")
  }
  if (requireOrigin && metadata.metadata?.origin !== "agent-created") {
    errors.push("frontmatter metadata.origin must be agent-created")
  }
  const body = (front.bodyLines ?? []).join("\n").trim()
  if (!body) errors.push("skill body is empty")
  if (body.length > SKILL_BODY_LIMIT) errors.push(`skill body exceeds ${SKILL_BODY_LIMIT} chars`)
  const unsafe = scanUnsafeReason(body)
  if (unsafe) errors.push(`skill body is unsafe: ${unsafe}`)
  return {
    ok: errors.length === 0,
    errors,
    metadata,
    managed: metadata.metadata?.managed_by === "oc_learning",
    origin: metadata.metadata?.origin,
    body,
  }
}

function previewEntry(entry, entryNumber) {
  const reason = scanUnsafeReason(entry, { entryMode: true })
  if (reason) return { preview: `<redacted unsafe memory entry #${entryNumber}>`, redacted: true, unsafe_reason: reason }
  return { preview: entry.length <= 100 ? entry : `${entry.slice(0, 97)}...`, redacted: false }
}

function memoryFindings(entries, revision) {
  const used = entryBlockLength(entries)
  const findings = []
  const seen = new Map()
  entries.forEach((entry, index) => {
    const entryNumber = index + 1
    const unsafe = scanUnsafeReason(entry, { entryMode: true })
    if (unsafe) {
      findings.push({
        type: "unsafe",
        entry_number: entryNumber,
        preview: `<redacted unsafe memory entry #${entryNumber}>`,
        redacted: true,
        message: `Entry #${entryNumber} is unsafe and should be removed or replaced.`,
        expected_revision: revision,
      })
    }
    if (entry.length > MEMORY_ENTRY_LIMIT) {
      findings.push({
        type: "oversized",
        entry_number: entryNumber,
        preview: unsafe ? `<redacted unsafe memory entry #${entryNumber}>` : previewEntry(entry, entryNumber).preview,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} exceeds the per-entry size limit.`,
        expected_revision: revision,
        safe_remove_args: {
          entry_number: String(entryNumber),
          expected_revision: revision,
        },
      })
    } else if (entry.length > Math.floor(MEMORY_ENTRY_LIMIT * 0.85)) {
      findings.push({
        type: "long-entry",
        entry_number: entryNumber,
        preview: unsafe ? `<redacted unsafe memory entry #${entryNumber}>` : previewEntry(entry, entryNumber).preview,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} is near the per-entry size limit.`,
      })
    }
    const key = duplicateKey(entry)
    if (seen.has(key)) {
      const finding = {
        type: "duplicate",
        entry_number: entryNumber,
        duplicate_of: seen.get(key),
        preview: unsafe ? `<redacted unsafe memory entry #${entryNumber}>` : previewEntry(entry, entryNumber).preview,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} duplicates entry #${seen.get(key)}.`,
        safe_remove_args: {
          entry_number: String(entryNumber),
          expected_revision: revision,
        },
      }
      if (!unsafe) finding.safe_remove_args.expected_content = entry
      findings.push(finding)
    } else {
      seen.set(key, entryNumber)
    }
    if (/\b([A-Za-z]:\\|\\\\|\/Users\/|\/home\/|cwd=|WORKFLOW\.md|mvnw|gradlew|pom\.xml|package\.json)\b/i.test(entry)) {
      findings.push({
        type: "scope-review",
        entry_number: entryNumber,
        preview: unsafe ? `<redacted unsafe memory entry #${entryNumber}>` : previewEntry(entry, entryNumber).preview,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} looks project- or machine-specific; review whether it belongs in project-local docs.`,
      })
    }
  })
  if (used > Math.floor(MEMORY_CHAR_LIMIT * 0.85)) {
    findings.unshift({
      type: "capacity",
      message: `Memory block is above 85% of capacity.`,
      used_chars: used,
      total_capacity: MEMORY_CHAR_LIMIT,
    })
  }
  return findings
}

function hasText(value) {
  return value !== undefined && value !== null && `${value}`.trim() !== ""
}

function resolveEntryIndex(entries, args) {
  if (hasText(args.entry_number)) {
    const raw = `${args.entry_number}`.trim()
    if (!/^\d+$/.test(raw)) throw new GuardError("invalid_entry_number", "entry_number must be a 1-based integer.")
    const entryNumber = Number.parseInt(raw, 10)
    if (entryNumber < 1 || entryNumber > entries.length) {
      throw new GuardError("entry_number_out_of_range", `entry_number ${entryNumber} is outside the memory entry range.`)
    }
    const index = entryNumber - 1
    if (hasText(args.expected_content)) {
      const expected = normalizeStoredEntry(args.expected_content)
      if (normalizeStoredEntry(entries[index]) !== expected) {
        throw new GuardError("expected_content_mismatch", `expected_content did not match memory entry #${entryNumber}. Refusing to mutate a shifted entry.`)
      }
    }
    return { index, label: `entry #${entryNumber}` }
  }

  const needle = `${args.old_text ?? ""}`.trim()
  if (!needle) throw new GuardError("target_required", "Provide old_text or entry_number.")
  const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(needle))
  if (matches.length !== 1) throw new GuardError("ambiguous_match", `Expected exactly one match for old_text; found ${matches.length}.`)
  return { index: matches[0].index, label: "old_text" }
}

async function defaultRunPermissionResult(result) {
  if (!result) return
  if (typeof result.then === "function") {
    await result
    return
  }
  throw new GuardError("approval_runner_required", "Host permission approval returned a non-Promise effect. Use the package plugin entrypoint or pass runPermissionEffect.")
}

async function requireUnmanagedSkillApproval(name, context, runPermissionEffect) {
  if (!context?.ask) {
    throw new GuardError("approval_required", `Mutating unmanaged skill '${name}' requires host permission approval.`)
  }
  await runPermissionEffect(context.ask({
    permission: "oc_learning.skill_patch.unmanaged",
    patterns: [`skills/${name}/SKILL.md`],
    always: [],
    metadata: {
      skill: name,
      reason: "Patch unmanaged skill through oc_learning_skill_patch",
    },
  }))
}

function mutationPayload(base) {
  return stableJson({
    status: base.status,
    operation: base.operation,
    target: base.target,
    before_revision: base.before_revision ?? null,
    after_revision: base.after_revision ?? null,
    backup: base.backup ?? null,
    changed: Boolean(base.changed),
    warnings: base.warnings ?? [],
    ...base.extra,
  })
}

export function createLearningGuardTools(options = {}) {
  const root = requireExplicitConfigRoot(options)
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_WAIT_MS
  const staleLockMs = options.staleLockMs ?? LOCK_STALE_MS
  const testHooks = options.testHooks ?? {}
  const toolFactory = options.toolFactory ?? standaloneTool
  const runPermissionEffect = options.runPermissionEffect ?? defaultRunPermissionResult
  let cachedRealRoot = null

  async function realConfigRoot() {
    if (!cachedRealRoot) {
      try {
        cachedRealRoot = await fs.realpath(root)
      } catch {
        throw new GuardError("config_root_unavailable", "Configured root is not accessible.")
      }
    }
    return cachedRealRoot
  }

  function lexicalPathRel(rel) {
    const normalized = normalizeRel(rel)
    const lexicalRoot = path.resolve(root)
    const candidate = fromRoot(root, normalized)
    return assertInside(lexicalRoot, candidate, normalized)
  }

  async function assertNoSymlinkComponentsRel(rel) {
    const normalized = normalizeRel(rel)
    const lexicalRoot = path.resolve(root)
    const target = lexicalPathRel(normalized)
    const relative = path.relative(lexicalRoot, target)
    let current = lexicalRoot
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part)
      try {
        const info = await fs.lstat(current)
        if (info.isSymbolicLink()) {
          throw new GuardError("symlinked_skill_path", `Refusing to archive symlinked skill path: ${normalized}`)
        }
      } catch (error) {
        if (error instanceof GuardError) throw error
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return
        throw error
      }
    }
  }

  async function pathForWriteRel(rel) {
    const realRoot = await realConfigRoot()
    const normalized = normalizeRel(rel)
    const candidate = fromRoot(root, normalized)
    const ancestor = await nearestExistingAncestor(candidate)
    const realAncestor = await fs.realpath(ancestor)
    assertInside(realRoot, realAncestor, normalized)
    const suffix = path.relative(path.resolve(ancestor), candidate)
    const safeCandidate = path.resolve(realAncestor, suffix)
    return assertInside(realRoot, safeCandidate, normalized)
  }

  async function existingPathRel(rel) {
    const realRoot = await realConfigRoot()
    const normalized = normalizeRel(rel)
    try {
      const realCandidate = await fs.realpath(fromRoot(root, normalized))
      return assertInside(realRoot, realCandidate, normalized)
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null
      throw error
    }
  }

  async function lockDirPath() {
    return pathForWriteRel(".oc_learning/locks")
  }

  async function backupOperation({ opId, operation, targetRel, beforeRevision, afterRevision, currentBytes }) {
    const opDirRel = posixRel(".oc_learning", "backups", `${nowStamp()}-${opId}`)
    const opDir = await pathForWriteRel(opDirRel)
    await fs.mkdir(opDir, { recursive: true })
    let backupRel = null
    if (currentBytes) {
      backupRel = posixRel(opDirRel, normalizeRel(targetRel).replace(/[/:\\]/g, "__"))
      await writeFileExclusiveDurable(await pathForWriteRel(backupRel), currentBytes)
    }
    const manifestRel = posixRel(opDirRel, "manifest.json")
    const manifest = {
      operation_id: opId,
      timestamp: new Date().toISOString(),
      operation,
      target: targetRel,
      before_revision: beforeRevision,
      intended_after_revision: afterRevision,
      backup: backupRel,
      status: "prepared",
    }
    await writeJson(await pathForWriteRel(manifestRel), manifest)
    return { opDirRel, backupRel, manifestRel, manifest }
  }

  async function updateManifest(manifestRel, manifest, status, extra = {}) {
    const next = { ...manifest, ...extra, status }
    try {
      await writeJson(await pathForWriteRel(manifestRel), next)
    } catch {
      // The mutation result remains authoritative; manifest update failure must not
      // cause a second write or leak local paths.
    }
  }

  async function withMutationLock(targetRel, fn) {
    const realRoot = await realConfigRoot()
    const key = `${realRoot}|${targetRel}`
    return withInProcessLock(key, async () => {
      const lock = await acquireProcessLock({
        lockDir: await lockDirPath(),
        targetRel,
        timeoutMs: lockTimeoutMs,
        staleMs: staleLockMs,
      })
      try {
        return await fn(lock)
      } finally {
        await lock.release().catch(() => {})
      }
    }, testHooks.afterInProcessLockCleanup)
  }

  async function transaction({ operation, targetRel, expectedRevision, build, validateFinal }) {
    return withMutationLock(targetRel, async (lock) => {
      const opId = randomUUID()
      const target = await pathForWriteRel(targetRel)
      const existing = await existingPathRel(targetRel)
      const currentBytes = existing ? await readFileIfExists(existing) : null
      const beforeRevision = revisionForBytes(currentBytes)
      if (expectedRevision && expectedRevision !== beforeRevision) throw new ConflictError()
      const currentText = currentBytes ? currentBytes.toString("utf8") : null
      const built = await build({
        currentText,
        currentBytes,
        beforeRevision,
        exists: Boolean(currentBytes),
      })
      if (built?.blocked) {
        return mutationPayload({
          ...built.blocked,
          operation,
          target: targetRel,
          before_revision: beforeRevision,
          after_revision: beforeRevision,
          backup: null,
          changed: false,
        })
      }
      const nextText = built.nextText
      const nextBytes = Buffer.from(nextText, "utf8")
      const afterRevision = revisionForBytes(nextBytes)
      if (currentBytes && Buffer.compare(currentBytes, nextBytes) === 0) {
        return mutationPayload({
          status: "unchanged",
          operation,
          target: targetRel,
          before_revision: beforeRevision,
          after_revision: beforeRevision,
          backup: null,
          changed: false,
          warnings: built.warnings ?? [],
        })
      }
      validateFinal(nextText)
      await lock.assertHeld()
      await fs.mkdir(path.dirname(target), { recursive: true })
      const backup = await backupOperation({
        opId,
        operation,
        targetRel,
        beforeRevision,
        afterRevision,
        currentBytes,
      })
      await testHooks.afterBackup?.({ operation, targetRel })
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${opId}.tmp`)
      try {
        await writeFileExclusiveDurable(temp, nextBytes)
        await testHooks.afterTempWrite?.({ operation, targetRel })
        await testHooks.beforeRename?.({ operation, targetRel })
        await lock.assertHeld()
        await fs.rename(temp, target)
        await fsyncDirectory(path.dirname(target))
        await testHooks.afterRename?.({ operation, targetRel })
        const finalBytes = await fs.readFile(target)
        const checkedBytes = (await testHooks.postReadBytes?.({ operation, targetRel, bytes: finalBytes })) ?? finalBytes
        const finalText = checkedBytes.toString("utf8")
        validateFinal(finalText)
        const finalRevision = revisionForBytes(finalBytes)
        if (finalRevision !== afterRevision) throw new GuardError("post_write_mismatch", "Post-write revision does not match intended revision.")
        await updateManifest(backup.manifestRel, backup.manifest, "committed")
        return mutationPayload({
          status: "ok",
          operation,
          target: targetRel,
          before_revision: beforeRevision,
          after_revision: afterRevision,
          backup: {
            path: backup.backupRel,
            manifest: backup.manifestRel,
          },
          changed: true,
          warnings: built.warnings ?? [],
        })
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {})
        try {
          if (currentBytes) await atomicReplace(target, currentBytes, `${opId}.restore`)
          else await fs.rm(target, { force: true })
          await updateManifest(backup.manifestRel, backup.manifest, "rolled-back", { rollback_reason: errorMessage(error) })
        } catch {
          await updateManifest(backup.manifestRel, backup.manifest, "rollback-failed", { rollback_reason: "restore failed" })
        }
        throw error
      }
    })
  }

  function parseCurrentMemory(currentText) {
    const text = currentText ?? memoryTemplate()
    const parsed = parseMemoryDocument(text, { enforceLimits: false })
    if (!parsed.ok) {
      throw new GuardError("malformed_memory", "Memory document is malformed. Run oc_learning_memory_audit or restore it manually before mutation.")
    }
    return parsed
  }

  function validateFinalMemory(text) {
    const parsed = parseMemoryDocument(text, { requireSafeEntries: true })
    if (!parsed.ok) {
      throw new GuardError("malformed_memory", `Final memory document failed validation: ${parsed.errors.join("; ")}`)
    }
  }

  function validateFinalMemoryStructure(text) {
    const parsed = parseMemoryDocument(text, { enforceLimits: false })
    if (!parsed.ok) {
      throw new GuardError("malformed_memory", `Final memory document failed validation: ${parsed.errors.join("; ")}`)
    }
  }

  function unsafeEntryCount(entries) {
    return entries.filter((entry) => scanUnsafeReason(entry, { entryMode: true })).length
  }

  function limitViolationCount(entries) {
    return entries.filter((entry) => entry.length > MEMORY_ENTRY_LIMIT).length + (entryBlockLength(entries) > MEMORY_CHAR_LIMIT ? 1 : 0)
  }

  function legacyCleanupWarnings(beforeEntries, afterEntries) {
    const beforeUnsafe = unsafeEntryCount(beforeEntries)
    const afterUnsafe = unsafeEntryCount(afterEntries)
    const beforeLimitViolations = limitViolationCount(beforeEntries)
    const afterLimitViolations = limitViolationCount(afterEntries)
    if (afterUnsafe > beforeUnsafe) {
      throw new GuardError("unsafe_memory_cleanup_required", "Mutation would increase unsafe memory entries.")
    }
    if (afterLimitViolations > beforeLimitViolations) {
      throw new GuardError("memory_limit_cleanup_required", "Mutation would increase memory limit violations.")
    }
    if (beforeUnsafe > 0 && afterUnsafe >= beforeUnsafe) {
      throw new GuardError("unsafe_memory_cleanup_required", "Unsafe memory entries exist; cleanup mutations must remove or replace unsafe entries before other changes.")
    }
    const warnings = []
    if (afterUnsafe > 0) warnings.push("Unsafe legacy memory entries remain redacted; continue cleanup with memory_audit and expected_revision.")
    if (afterLimitViolations > 0) warnings.push("Memory limit violations remain; continue cleanup with memory_audit and expected_revision.")
    return warnings
  }

  function capacityBlocked(entries) {
    return {
      blocked: {
        status: "blocked",
        warnings: [],
        extra: {
          reason: "capacity",
          current_entry_count: entries.length,
          used_chars: entryBlockLength(entries),
          total_capacity: MEMORY_CHAR_LIMIT,
          recommendation: "Run oc_learning_memory_audit and compact or remove stale entries before retrying.",
        },
      },
    }
  }

  function replacementStillExceedsCapacityButReducesUsage(beforeEntries, afterEntries) {
    const beforeChars = entryBlockLength(beforeEntries)
    const afterChars = entryBlockLength(afterEntries)
    return beforeChars > MEMORY_CHAR_LIMIT && afterChars > MEMORY_CHAR_LIMIT && afterChars < beforeChars
  }

  const tools = {
    memory_list: toolFactory({
      description: "List compact durable OpenCode memory entries from skills/global-memory/SKILL.md without creating state",
      args: {},
      async execute() {
        const existing = await existingPathRel(MEMORY_REL)
        if (!existing) {
          return stableJson({
            status: "absent",
            entry_count: 0,
            revision: null,
            entries: [],
            findings: [],
            message: "No memory entries.",
          })
        }
        const bytes = await fs.readFile(existing)
        const revision = revisionForBytes(bytes)
        const parsed = parseMemoryDocument(bytes.toString("utf8"), { enforceLimits: false })
        if (!parsed.ok) {
          return stableJson({
            status: "error",
            entry_count: 0,
            revision,
            entries: [],
            findings: [],
            structural_errors: parsed.errors,
            limit_errors: parsed.limitErrors,
            recommendation: "Run oc_learning_memory_audit or restore skills/global-memory/SKILL.md manually. Unsafe content is not shown.",
          })
        }
        const entries = parsed.entries.map((entry, index) => {
          const number = index + 1
          const preview = previewEntry(entry, number)
          return {
            entry_number: number,
            content: preview.redacted ? `<redacted unsafe memory entry #${number}>` : entry,
            redacted: preview.redacted,
          }
        })
        return stableJson({
          status: "ok",
          entry_count: entries.length,
          revision,
          entries,
          findings: [
            ...(entries.some((entry) => entry.redacted) ? [{ type: "unsafe-redacted", message: "One or more entries were redacted. Run oc_learning_memory_audit." }] : []),
            ...parsed.limitErrors.map((message) => ({ type: "limit", message })),
          ],
        })
      },
    }),

    memory_audit: toolFactory({
      description: "Audit OpenCode memory for cleanup candidates without mutating files",
      args: {},
      async execute() {
        const existing = await existingPathRel(MEMORY_REL)
        if (!existing) {
          return stableJson({
            status: "absent",
            entry_count: 0,
            revision: null,
            findings: [],
            structural_errors: [],
            message: "No memory entries.",
          })
        }
        const bytes = await fs.readFile(existing)
        const revision = revisionForBytes(bytes)
        const parsed = parseMemoryDocument(bytes.toString("utf8"), { enforceLimits: false })
        if (!parsed.ok) {
          return stableJson({
            status: "error",
            entry_count: 0,
            revision,
            findings: [],
            structural_errors: parsed.errors,
            limit_errors: parsed.limitErrors,
            recommendation: "Restore the memory file from backup or repair it manually. Unsafe content is not shown.",
          })
        }
        return stableJson({
          status: "ok",
          entry_count: parsed.entries.length,
          revision,
          used_chars: entryBlockLength(parsed.entries),
          total_capacity: MEMORY_CHAR_LIMIT,
          findings: memoryFindings(parsed.entries, revision),
          structural_errors: [],
          limit_errors: parsed.limitErrors,
        })
      },
    }),

    memory_add: toolFactory({
      description: "Add one verified, non-sensitive durable OpenCode memory entry; rejects secrets, duplicates, reserved markers, and over-capacity memory",
      args: {
        content: toolFactory.schema.string().describe("One compact durable memory entry, <= 280 chars"),
        expected_revision: toolFactory.schema.string().optional().describe("Optional SHA-256 revision guard from memory_list or memory_audit"),
      },
      async execute(args) {
        const entry = normalizeEntry(args.content)
        return transaction({
          operation: "memory_add",
          targetRel: MEMORY_REL,
          expectedRevision: args.expected_revision,
          validateFinal: validateFinalMemory,
          build({ currentText }) {
            const parsed = parseCurrentMemory(currentText)
            const entries = parsed.entries.map(normalizeStoredEntry)
            if (entries.includes(entry) || entries.map(duplicateKey).includes(duplicateKey(entry))) {
              return { nextText: currentText ?? renderMemoryDocument(parsed, entries), warnings: ["duplicate memory entry ignored"] }
            }
            const next = [...entries, entry]
            if (entryBlockLength(next) > MEMORY_CHAR_LIMIT) return capacityBlocked(entries)
            return { nextText: renderMemoryDocument(parsed, next) }
          },
        })
      },
    }),

    memory_replace: toolFactory({
      description: "Replace exactly one durable memory entry using a unique substring match or a guarded 1-based entry number",
      args: {
        old_text: toolFactory.schema.string().optional().describe("Unique substring of the memory entry to replace"),
        entry_number: toolFactory.schema.string().optional().describe("1-based entry number to replace when duplicates make old_text non-unique"),
        expected_content: toolFactory.schema.string().optional().describe("Optional current entry content guard when using entry_number"),
        expected_revision: toolFactory.schema.string().optional().describe("Optional SHA-256 revision guard from memory_list or memory_audit"),
        content: toolFactory.schema.string().describe("Replacement memory entry, <= 280 chars"),
      },
      async execute(args) {
        const replacement = normalizeEntry(args.content)
        return transaction({
          operation: "memory_replace",
          targetRel: MEMORY_REL,
          expectedRevision: args.expected_revision,
          validateFinal: validateFinalMemoryStructure,
          build({ currentText }) {
            const parsed = parseCurrentMemory(currentText)
            const entries = parsed.entries.map(normalizeStoredEntry)
            const target = resolveEntryIndex(entries, args)
            const replacementKey = duplicateKey(replacement)
            const duplicatesOtherEntry = entries.some((entry, index) => index !== target.index && (entry === replacement || duplicateKey(entry) === replacementKey))
            if (duplicatesOtherEntry) throw new GuardError("duplicate_memory_entry", "Replacement would create a duplicate memory entry.")
            const next = [...entries]
            next[target.index] = replacement
            if (entryBlockLength(next) > MEMORY_CHAR_LIMIT && !replacementStillExceedsCapacityButReducesUsage(entries, next)) {
              return capacityBlocked(entries)
            }
            return {
              nextText: renderMemoryDocument(parsed, next),
              warnings: legacyCleanupWarnings(entries, next),
            }
          },
        })
      },
    }),

    memory_remove: toolFactory({
      description: "Remove exactly one durable memory entry using a unique substring match or a guarded 1-based entry number",
      args: {
        old_text: toolFactory.schema.string().optional().describe("Unique substring of the memory entry to remove"),
        entry_number: toolFactory.schema.string().optional().describe("1-based entry number to remove when duplicates make old_text non-unique"),
        expected_content: toolFactory.schema.string().optional().describe("Optional current entry content guard when using entry_number"),
        expected_revision: toolFactory.schema.string().optional().describe("Optional SHA-256 revision guard from memory_list or memory_audit"),
      },
      async execute(args) {
        return transaction({
          operation: "memory_remove",
          targetRel: MEMORY_REL,
          expectedRevision: args.expected_revision,
          validateFinal: validateFinalMemoryStructure,
          build({ currentText }) {
            const parsed = parseCurrentMemory(currentText)
            const entries = parsed.entries.map(normalizeStoredEntry)
            const target = resolveEntryIndex(entries, args)
            const next = [...entries]
            next.splice(target.index, 1)
            return {
              nextText: renderMemoryDocument(parsed, next),
              warnings: legacyCleanupWarnings(entries, next),
            }
          },
        })
      },
    }),

    skill_create: toolFactory({
      description: "Create a focused agent-managed OpenCode skill under skills/<name>/SKILL.md with validation and backup discipline",
      args: {
        name: toolFactory.schema.string().describe("Skill name, lowercase words separated by hyphens"),
        description: toolFactory.schema.string().describe("Specific trigger description, 1-1024 chars"),
        body: toolFactory.schema.string().describe("Markdown skill body with procedure, pitfalls, and verification"),
        overwrite: toolFactory.schema.boolean().optional().describe("Overwrite only if an existing managed skill should be replaced"),
        expected_revision: toolFactory.schema.string().optional().describe("Optional SHA-256 revision guard for overwrite"),
      },
      async execute(args) {
        validateSkillName(args.name)
        if (args.name === MEMORY_NAME) throw new GuardError("reserved_skill", "Use memory_* tools for global-memory.")
        const description = safeDescription(args.description)
        const body = safeBody(args.body)
        const targetRel = posixRel("skills", args.name, "SKILL.md")
        return transaction({
          operation: "skill_create",
          targetRel,
          expectedRevision: args.expected_revision,
          validateFinal(text) {
            const validation = validateSkillDocument(text, args.name, { requireManaged: true, requireOrigin: true })
            if (!validation.ok) throw new GuardError("malformed_skill", `Final skill document failed validation: ${validation.errors.join("; ")}`)
          },
          build({ currentText, exists }) {
            if (exists) {
              const validation = validateSkillDocument(currentText, args.name, { requireManaged: true, requireOrigin: true })
              if (!validation.ok) throw new GuardError("malformed_skill", "Existing managed skill is malformed; repair it manually before overwrite.")
              if (!args.overwrite) throw new GuardError("skill_exists", `Managed skill '${args.name}' already exists. Use skill_patch or set overwrite after explicit approval.`)
            }
            return { nextText: `${skillFrontmatter(args.name, description)}${body}\n` }
          },
        })
      },
    }),

    skill_patch: toolFactory({
      description: "Patch one existing managed skill by replacing an exact old_string with new_string; unmanaged skills require host permission approval",
      args: {
        name: toolFactory.schema.string().describe("Skill name"),
        old_string: toolFactory.schema.string().describe("Exact text to replace; must occur once"),
        new_string: toolFactory.schema.string().describe("Replacement text"),
        allow_unmanaged: toolFactory.schema.boolean().optional().describe("Request host permission approval before patching an unmanaged skill"),
        expected_revision: toolFactory.schema.string().optional().describe("Optional SHA-256 revision guard for the skill document"),
      },
      async execute(args, context) {
        validateSkillName(args.name)
        if (args.name === MEMORY_NAME) throw new GuardError("reserved_skill", "Use memory_* tools for global-memory.")
        if (!args.old_string) throw new GuardError("empty_old_string", "old_string is empty.")
        scanUnsafe(args.new_string)
        const targetRel = posixRel("skills", args.name, "SKILL.md")
        const preExisting = await existingPathRel(targetRel)
        if (!preExisting) throw new GuardError("missing_skill", `Skill '${args.name}' does not exist.`)
        const preContent = await fs.readFile(preExisting, "utf8")
        const preValidation = validateSkillDocument(preContent, args.name, { requireManaged: false })
        const needsApproval = !preValidation.managed
        if (needsApproval) {
          if (!args.allow_unmanaged) {
            throw new GuardError("unmanaged_skill", `Refusing to mutate unmanaged skill '${args.name}'. Set allow_unmanaged only to request host permission approval.`)
          }
          await requireUnmanagedSkillApproval(args.name, context, runPermissionEffect)
        }
        let currentRequiresManagedValidation = true
        return transaction({
          operation: "skill_patch",
          targetRel,
          expectedRevision: args.expected_revision,
          validateFinal(text) {
            const validation = validateSkillDocument(text, args.name, {
              requireManaged: currentRequiresManagedValidation,
              requireOrigin: currentRequiresManagedValidation,
            })
            if (!validation.ok) throw new GuardError("malformed_skill", `Final skill document failed validation: ${validation.errors.join("; ")}`)
          },
          build({ currentText }) {
            if (currentText === null) throw new GuardError("missing_skill", `Skill '${args.name}' does not exist.`)
            const currentShape = validateSkillDocument(currentText, args.name, { requireManaged: false })
            currentRequiresManagedValidation = currentShape.managed
            if (!currentShape.managed && !needsApproval) {
              throw new GuardError("unmanaged_skill", `Refusing to mutate unmanaged skill '${args.name}' without host permission approval.`)
            }
            const currentValidation = validateSkillDocument(currentText, args.name, {
              requireManaged: currentRequiresManagedValidation,
              requireOrigin: currentRequiresManagedValidation,
            })
            if (!currentValidation.ok) throw new GuardError("malformed_skill", "Current skill document is malformed; repair it manually before mutation.")
            const occurrences = currentText.split(args.old_string).length - 1
            if (occurrences !== 1) throw new GuardError("ambiguous_patch", `Expected old_string to occur exactly once; found ${occurrences}.`)
            return { nextText: currentText.replace(args.old_string, args.new_string) }
          },
        })
      },
    }),

    skill_archive: toolFactory({
      description: "Archive a managed agent-created skill instead of deleting it",
      args: {
        name: toolFactory.schema.string().describe("Managed skill name to archive"),
        reason: toolFactory.schema.string().describe("Why the skill is being archived, <= 500 chars"),
        expected_revision: toolFactory.schema.string().optional().describe("Optional SHA-256 revision guard for the skill document"),
      },
      async execute(args) {
        validateSkillName(args.name)
        if (args.name === MEMORY_NAME) throw new GuardError("reserved_skill", "global-memory cannot be archived by this tool.")
        const reason = safeArchiveReason(args.reason)
        const skillDirRel = posixRel("skills", args.name)
        const targetRel = posixRel("skills", args.name, "SKILL.md")
        await assertNoSymlinkComponentsRel(skillDirRel)
        return withMutationLock(targetRel, async (lock) => {
          const opId = randomUUID()
          await assertNoSymlinkComponentsRel(skillDirRel)
          const skillDir = lexicalPathRel(skillDirRel)
          const skillFile = await existingPathRel(targetRel)
          if (!(await pathExists(skillDir)) || !skillFile) throw new GuardError("missing_skill", `Skill '${args.name}' does not exist.`)
          const currentBytes = await fs.readFile(skillFile)
          const beforeRevision = revisionForBytes(currentBytes)
          if (args.expected_revision && args.expected_revision !== beforeRevision) throw new ConflictError()
          const currentText = currentBytes.toString("utf8")
          const validation = validateSkillDocument(currentText, args.name, { requireManaged: true, requireOrigin: true })
          if (!validation.ok) throw new GuardError("malformed_skill", "Only structurally valid managed skills can be archived.")
          await lock.assertHeld()
          const backup = await backupOperation({
            opId,
            operation: "skill_archive",
            targetRel,
            beforeRevision,
            afterRevision: null,
            currentBytes,
          })
          await testHooks.afterBackup?.({ operation: "skill_archive", targetRel })
          const archiveRel = posixRel(".oc_learning", "archive", `${args.name}-${nowStamp()}-${opId}`)
          const archiveDir = await pathForWriteRel(archiveRel)
          const archivedSkillRel = posixRel(archiveRel, "source")
          const archivedSkillDir = await pathForWriteRel(archivedSkillRel)
          const manifestRel = posixRel(archiveRel, "manifest.json")
          const archiveManifest = {
            operation_id: opId,
            timestamp: new Date().toISOString(),
            operation: "skill_archive",
            original_path: skillDirRel,
            archived_path: archivedSkillRel,
            reason,
            before_revision: beforeRevision,
            status: "prepared",
          }
          const markArchive = async (status, extra = {}) => {
            await writeJson(await pathForWriteRel(manifestRel), { ...archiveManifest, ...extra, status })
          }
          let moved = false
          try {
            await fs.mkdir(archiveDir, { recursive: true })
            await fs.writeFile(await pathForWriteRel(posixRel(archiveRel, "ARCHIVE_REASON.txt")), `${reason}\n`, "utf8")
            await markArchive("prepared")
            await testHooks.beforeRename?.({ operation: "skill_archive", targetRel })
            await lock.assertHeld()
            await assertNoSymlinkComponentsRel(skillDirRel)
            await fs.rename(skillDir, archivedSkillDir)
            moved = true
            await fsyncDirectory(path.dirname(skillDir))
            await fsyncDirectory(archiveDir)
            await testHooks.afterRename?.({ operation: "skill_archive", targetRel })
            const archivedBytes = await fs.readFile(path.join(archivedSkillDir, "SKILL.md"))
            if (revisionForBytes(archivedBytes) !== beforeRevision) {
              throw new GuardError("archive_verification_failed", "Archived skill revision does not match the source revision.")
            }
          } catch (error) {
            let rollbackStatus = "rolled-back"
            try {
              if (moved) {
                if (await pathExists(skillDir)) {
                  throw new GuardError("archive_rollback_blocked", "Archive rollback target already exists.")
                }
                if (!(await pathExists(archivedSkillDir))) {
                  throw new GuardError("archive_rollback_missing_source", "Archive rollback source is missing.")
                }
                await fs.rename(archivedSkillDir, skillDir)
                await fsyncDirectory(path.dirname(skillDir))
                await fsyncDirectory(archiveDir)
              }
              await markArchive("rolled-back", { rollback_reason: errorMessage(error) }).catch(() => {})
              await updateManifest(backup.manifestRel, backup.manifest, "rolled-back", {
                archive: archiveRel,
                rollback_reason: errorMessage(error),
              })
            } catch {
              rollbackStatus = "rollback-failed"
              await markArchive("rollback-failed", { rollback_reason: "restore failed" }).catch(() => {})
              await updateManifest(backup.manifestRel, backup.manifest, "rollback-failed", {
                archive: archiveRel,
                rollback_reason: "restore failed",
              })
            }
            if (rollbackStatus === "rollback-failed") {
              throw new GuardError("archive_rollback_failed", "Archive failed after moving the skill and rollback did not complete. Recover from the archive or backup manifest.")
            }
            throw error
          }
          const warnings = []
          try {
            await markArchive("committed")
          } catch {
            warnings.push("Archive committed, but archive manifest status update failed; use the returned archive path as authoritative.")
          }
          await updateManifest(backup.manifestRel, backup.manifest, "committed", { archive: archiveRel })
          return mutationPayload({
            status: "ok",
            operation: "skill_archive",
            target: targetRel,
            before_revision: beforeRevision,
            after_revision: null,
            backup: {
              path: backup.backupRel,
              manifest: backup.manifestRel,
            },
            changed: true,
            warnings,
            extra: {
              archive: archiveRel,
              archive_manifest: manifestRel,
            },
          })
        })
      },
    }),
  }

  Object.defineProperty(tools, "assertReady", {
    value: async () => {
      await realConfigRoot()
    },
  })

  return tools
}
