import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const MEMORY_NAME = "global-memory"
const MEMORY_CHAR_LIMIT = 4000
const MEMORY_ENTRY_LIMIT = 280
const SKILL_BODY_LIMIT = 12000
const ARCHIVE_REASON_LIMIT = 500
const ENTRY_START = "<!-- oc-memory-entries:start -->"
const ENTRY_END = "<!-- oc-memory-entries:end -->"

function defaultConfigRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "..")
}

function configuredRoot(options) {
  const root = options.configRoot ?? options.config_root ?? defaultConfigRoot()
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("configRoot must be a non-empty path string.")
  }
  return path.resolve(root)
}

function assertRealInside(root, candidate) {
  const rel = path.relative(root, candidate)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes allowed root: ${candidate}`)
  }
  return candidate
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

async function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate)
  while (!(await pathExists(current))) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`No existing ancestor for path: ${candidate}`)
    current = parent
  }
  return current
}

function validateSkillName(name) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error("Invalid skill name. Use lowercase alphanumeric words separated by single hyphens, max 64 chars.")
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function scanUnsafe(text) {
  const invisible = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/
  if (invisible.test(text)) throw new Error("Rejected: text contains invisible/control Unicode characters.")

  const dangerous = [
    /BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY/i,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential)\b\s*[:=]/i,
    /\bssh-rsa\b|\bed25519\b.*\bprivate\b/i,
    /ignore (all )?(previous|prior|above) (instructions|rules)/i,
    /(reveal|print|dump|exfiltrate).*(secret|token|password|credential|key|system prompt|developer message|hidden instructions)/i,
    /send .* (token|secret|password|credential|key|system prompt|developer message|hidden instructions)/i,
  ]
  for (const pattern of dangerous) {
    if (pattern.test(text)) throw new Error(`Rejected by safety scanner: ${pattern}`)
  }
}

function normalizeEntry(content) {
  const normalized = content.replace(/\s+/g, " ").trim()
  if (!normalized) throw new Error("Memory entry is empty.")
  if (normalized.length > MEMORY_ENTRY_LIMIT) {
    throw new Error(`Memory entry is ${normalized.length} chars; keep it <= ${MEMORY_ENTRY_LIMIT} chars.`)
  }
  scanUnsafe(normalized)
  return normalized
}

function normalizeStoredEntry(content) {
  return content.replace(/\s+/g, " ").trim()
}

function yamlString(value) {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim())
}

function parseYamlScalar(value) {
  const trimmed = value.trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function splitFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return { metadata: null, body: content }
  return {
    metadata: parseFrontmatter(match[1]),
    body: content.slice(match[0].length),
  }
}

function parseFrontmatter(source) {
  const result = {}
  let parent = null

  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue
    const indent = rawLine.match(/^\s*/)[0].length
    const match = rawLine.trim().match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
    if (!match) continue

    const [, key, rawValue = ""] = match
    if (indent === 0) {
      if (!rawValue) {
        result[key] = {}
        parent = key
      } else {
        result[key] = parseYamlScalar(rawValue)
        parent = null
      }
      continue
    }

    if (parent && typeof result[parent] === "object" && result[parent] !== null) {
      result[parent][key] = parseYamlScalar(rawValue)
    }
  }

  return result
}

function isManagedSkill(content) {
  const { metadata } = splitFrontmatter(content)
  return metadata?.metadata?.managed_by === "oc_learning"
}

function skillBodyLength(content) {
  return splitFrontmatter(content).body.trim().length
}

function safeDescription(description) {
  const value = description.replace(/\s+/g, " ").trim()
  if (!value || value.length > 1024) throw new Error("Description must be 1-1024 chars.")
  scanUnsafe(value)
  return value
}

function safeBody(body) {
  const value = body.trim()
  if (!value) throw new Error("Skill body is empty.")
  if (value.length > SKILL_BODY_LIMIT) throw new Error(`Skill body is too large (${value.length} chars > ${SKILL_BODY_LIMIT}).`)
  scanUnsafe(value)
  return value
}

function safeArchiveReason(reason) {
  const value = reason.replace(/\s+/g, " ").trim()
  if (!value) throw new Error("Archive reason is empty.")
  if (value.length > ARCHIVE_REASON_LIMIT) {
    throw new Error(`Archive reason is ${value.length} chars; keep it <= ${ARCHIVE_REASON_LIMIT} chars.`)
  }
  scanUnsafe(value)
  return value
}

function frontmatter(name, description) {
  return `---
name: ${name}
description: ${yamlString(description)}
license: MIT
compatibility: opencode
metadata:
  managed_by: oc_learning
  origin: agent-created
---`
}

function parseEntries(markdown) {
  const start = markdown.indexOf(ENTRY_START)
  const end = markdown.indexOf(ENTRY_END)
  if (start === -1 || end === -1 || end < start) return []
  const body = markdown.slice(start + ENTRY_START.length, end).trim()
  if (!body) return []
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean)
}

function renderEntries(markdown, entries) {
  const start = markdown.indexOf(ENTRY_START)
  const end = markdown.indexOf(ENTRY_END)
  const block = entries.length ? `\n${entries.map((entry) => `- ${entry}`).join("\n")}\n` : "\n"
  if (start === -1 || end === -1 || end < start) {
    return `${markdown.trim()}\n\n${ENTRY_START}${block}${ENTRY_END}\n`
  }
  return markdown.slice(0, start + ENTRY_START.length) + block + markdown.slice(end)
}

function entryBlockLength(entries) {
  return entries.map((entry) => `- ${entry}`).join("\n").length
}

function cleanupKey(entry) {
  return entry
    .toLowerCase()
    .replace(/[`*_~[\]()#>"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function previewEntry(entry, { redacted = false } = {}) {
  if (redacted) return "<redacted by safety scanner>"
  return entry.length <= 100 ? entry : `${entry.slice(0, 97)}...`
}

function hasText(value) {
  return value !== undefined && value !== null && `${value}`.trim() !== ""
}

function resolveEntryIndex(entries, args) {
  if (hasText(args.entry_number)) {
    const raw = `${args.entry_number}`.trim()
    if (!/^\d+$/.test(raw)) throw new Error("entry_number must be a 1-based integer.")
    const entryNumber = Number.parseInt(raw, 10)
    if (entryNumber < 1 || entryNumber > entries.length) {
      throw new Error(`entry_number ${entryNumber} is outside the memory entry range 1-${entries.length}.`)
    }
    const index = entryNumber - 1
    if (hasText(args.expected_content)) {
      const expected = normalizeStoredEntry(args.expected_content)
      if (normalizeStoredEntry(entries[index]) !== expected) {
        throw new Error(`expected_content did not match memory entry #${entryNumber}. Refusing to mutate a shifted entry.`)
      }
    }
    return { index, label: `#${entryNumber}` }
  }

  const needle = `${args.old_text ?? ""}`.trim()
  if (!needle) throw new Error("Provide old_text or entry_number.")
  const matches = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(needle))
  if (matches.length !== 1) throw new Error(`Expected exactly one match for old_text; found ${matches.length}.`)
  return { index: matches[0].index, label: "old_text" }
}

function memoryAuditReport(entries) {
  const used = entryBlockLength(entries)
  const percent = MEMORY_CHAR_LIMIT === 0 ? 0 : Math.round((used / MEMORY_CHAR_LIMIT) * 100)
  const findings = []
  const seen = new Map()

  entries.forEach((entry, index) => {
    const entryNumber = index + 1
    let unsafe = null
    try {
      scanUnsafe(entry)
    } catch (error) {
      unsafe = error?.message ?? "Rejected by safety scanner."
      findings.push({
        type: "unsafe",
        entryNumber,
        redacted: true,
        message: `${unsafe} Review and remove or replace entry #${entryNumber}.`,
      })
    }

    if (entry.length > MEMORY_ENTRY_LIMIT) {
      findings.push({
        type: "oversized",
        entryNumber,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} is ${entry.length} chars; keep entries <= ${MEMORY_ENTRY_LIMIT} chars.`,
      })
    } else if (entry.length > Math.floor(MEMORY_ENTRY_LIMIT * 0.85)) {
      findings.push({
        type: "long-entry",
        entryNumber,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} is ${entry.length} chars; consider tightening it during cleanup.`,
      })
    }

    const key = cleanupKey(entry)
    if (seen.has(key)) {
      findings.push({
        type: "duplicate",
        entryNumber,
        duplicateOf: seen.get(key),
        redacted: Boolean(unsafe),
        expectedContent: unsafe ? null : entry,
        message: `Entry #${entryNumber} duplicates entry #${seen.get(key)}.`,
      })
    } else {
      seen.set(key, entryNumber)
    }

    if (/\b([A-Za-z]:\\|\\\\|\/Users\/|\/home\/|cwd=|WORKFLOW\.md|mvnw|gradlew|pom\.xml|package\.json)\b/i.test(entry)) {
      findings.push({
        type: "scope-review",
        entryNumber,
        redacted: Boolean(unsafe),
        message: `Entry #${entryNumber} looks project- or machine-specific; move it to project-local docs or skills unless it is explicitly scoped.`,
      })
    }
  })

  if (used > Math.floor(MEMORY_CHAR_LIMIT * 0.85)) {
    findings.unshift({
      type: "capacity",
      message: `Memory block uses ${used}/${MEMORY_CHAR_LIMIT} chars (${percent}%). Consolidate before adding more entries.`,
    })
  }

  const lines = [
    "Memory cleanup audit",
    `Entries: ${entries.length}`,
    `Capacity: ${used}/${MEMORY_CHAR_LIMIT} chars (${percent}%)`,
    "",
  ]

  if (findings.length === 0) {
    lines.push("No mechanical cleanup candidates found.")
  } else {
    lines.push("Cleanup candidates:")
    for (const finding of findings) {
      const prefix = finding.entryNumber ? `entry #${finding.entryNumber}` : "memory"
      lines.push(`- [${finding.type}] ${prefix}: ${finding.message}`)
      if (finding.entryNumber) {
        lines.push(`  preview: ${previewEntry(entries[finding.entryNumber - 1], { redacted: finding.redacted })}`)
      }
      if (finding.type === "duplicate" && finding.expectedContent) {
        lines.push(`  safe remove args: entry_number=${JSON.stringify(String(finding.entryNumber))}, expected_content=${JSON.stringify(finding.expectedContent)}`)
      }
    }
  }

  lines.push("")
  lines.push("This tool does not mutate memory. Apply reviewed cleanup with oc_learning_memory_remove or oc_learning_memory_replace; backups are created before writes.")
  lines.push("Staleness requires human review; this audit only catches mechanical cleanup candidates.")

  return lines.join("\n")
}

async function runPermissionEffect(effect) {
  if (!effect) return
  await Effect.runPromise(effect)
}

async function requireUnmanagedSkillApproval(name, context) {
  if (!context?.ask) {
    throw new Error(`Mutating unmanaged skill '${name}' requires host permission approval.`)
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

export function createLearningGuardTools(options = {}) {
  const root = configuredRoot(options)
  let cachedRealRoot = null

  async function realConfigRoot() {
    if (!cachedRealRoot) cachedRealRoot = await fs.realpath(root)
    return cachedRealRoot
  }

  async function assertInsideForWrite(candidate) {
    const realRoot = await realConfigRoot()
    const resolvedCandidate = path.resolve(candidate)
    const ancestor = await nearestExistingAncestor(resolvedCandidate)
    const realAncestor = await fs.realpath(ancestor)
    assertRealInside(realRoot, realAncestor)
    const suffix = path.relative(path.resolve(ancestor), resolvedCandidate)
    const safeCandidate = path.resolve(realAncestor, suffix)
    return assertRealInside(realRoot, safeCandidate)
  }

  async function assertExistingInside(candidate) {
    const realRoot = await realConfigRoot()
    const realCandidate = await fs.realpath(path.resolve(candidate))
    return assertRealInside(realRoot, realCandidate)
  }

  async function skillsRoot() {
    return assertInsideForWrite(path.join(root, "skills"))
  }

  async function stateRoot() {
    return assertInsideForWrite(path.join(root, ".oc_learning"))
  }

  async function memoryPath() {
    return assertInsideForWrite(path.join(await skillsRoot(), MEMORY_NAME, "SKILL.md"))
  }

  async function skillDir(name) {
    validateSkillName(name)
    return assertInsideForWrite(path.join(await skillsRoot(), name))
  }

  async function skillPath(name) {
    return assertInsideForWrite(path.join(await skillDir(name), "SKILL.md"))
  }

  async function backupFile(file, reason) {
    const safeFile = await assertExistingInside(file)
    if (!(await pathExists(safeFile))) return null
    const realRoot = await realConfigRoot()
    const rel = path.relative(realRoot, safeFile).replace(/[\\/]/g, "__")
    const backupDir = await assertInsideForWrite(path.join(await stateRoot(), "backups", timestamp()))
    await fs.mkdir(backupDir, { recursive: true })
    const dest = await assertInsideForWrite(path.join(backupDir, rel))
    await fs.copyFile(safeFile, dest)
    await fs.writeFile(path.join(backupDir, "reason.txt"), reason, "utf8")
    return dest
  }

  async function ensureMemoryFile() {
    const file = await memoryPath()
    if (await pathExists(file)) return
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `---
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
`, "utf8")
  }

  async function ensureManagedSkill(name, content, allowUnmanaged, context) {
    if (name === MEMORY_NAME) return
    if (isManagedSkill(content)) return
    if (!allowUnmanaged) {
      throw new Error(`Refusing to mutate unmanaged skill '${name}'. Set allow_unmanaged only to request host permission approval.`)
    }
    await requireUnmanagedSkillApproval(name, context)
  }

  const tools = {
    memory_list: tool({
      description: "List compact durable OpenCode memory entries from skills/global-memory/SKILL.md",
      args: {},
      async execute() {
        await ensureMemoryFile()
        const markdown = await fs.readFile(await memoryPath(), "utf8")
        const entries = parseEntries(markdown)
        return entries.length ? entries.map((entry, index) => `${index + 1}. ${entry}`).join("\n") : "No memory entries."
      },
    }),

    memory_audit: tool({
      description: "Audit OpenCode memory for cleanup candidates without mutating files; reports duplicates, oversized entries, safety issues, capacity pressure, and scope concerns",
      args: {},
      async execute() {
        await ensureMemoryFile()
        const markdown = await fs.readFile(await memoryPath(), "utf8")
        return memoryAuditReport(parseEntries(markdown))
      },
    }),

    memory_add: tool({
      description: "Add one verified, non-sensitive durable OpenCode memory entry; rejects secrets, prompt injection, duplicates, and over-capacity memory",
      args: {
        content: tool.schema.string().describe("One compact durable memory entry, <= 280 chars"),
      },
      async execute(args) {
        await ensureMemoryFile()
        const entry = normalizeEntry(args.content)
        const file = await memoryPath()
        const markdown = await fs.readFile(file, "utf8")
        const entries = parseEntries(markdown)
        if (entries.includes(entry)) return "No-op: exact duplicate memory entry already exists."
        const next = [...entries, entry]
        if (entryBlockLength(next) > MEMORY_CHAR_LIMIT) {
          return `Blocked: memory would exceed ${MEMORY_CHAR_LIMIT} chars. Consolidate existing entries first.\n\nCurrent entries:\n${entries.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
        }
        const backup = await backupFile(file, "before memory_add")
        await fs.writeFile(file, renderEntries(markdown, next), "utf8")
        return `Saved memory entry. Backup: ${backup ?? "none"}`
      },
    }),

    memory_replace: tool({
      description: "Replace exactly one durable memory entry using a unique substring match or a guarded 1-based entry number",
      args: {
        old_text: tool.schema.string().optional().describe("Unique substring of the memory entry to replace"),
        entry_number: tool.schema.string().optional().describe("1-based entry number to replace when duplicates make old_text non-unique"),
        expected_content: tool.schema.string().optional().describe("Optional current entry content guard when using entry_number"),
        content: tool.schema.string().describe("Replacement memory entry, <= 280 chars"),
      },
      async execute(args) {
        await ensureMemoryFile()
        const replacement = normalizeEntry(args.content)
        const file = await memoryPath()
        const markdown = await fs.readFile(file, "utf8")
        const entries = parseEntries(markdown)
        const target = resolveEntryIndex(entries, args)
        entries[target.index] = replacement
        if (entryBlockLength(entries) > MEMORY_CHAR_LIMIT) throw new Error(`Replacement would exceed ${MEMORY_CHAR_LIMIT} chars.`)
        const backup = await backupFile(file, `before memory_replace ${target.label}`)
        await fs.writeFile(file, renderEntries(markdown, entries), "utf8")
        return `Replaced memory entry. Backup: ${backup ?? "none"}`
      },
    }),

    memory_remove: tool({
      description: "Remove exactly one durable memory entry using a unique substring match or a guarded 1-based entry number",
      args: {
        old_text: tool.schema.string().optional().describe("Unique substring of the memory entry to remove"),
        entry_number: tool.schema.string().optional().describe("1-based entry number to remove when duplicates make old_text non-unique"),
        expected_content: tool.schema.string().optional().describe("Optional current entry content guard when using entry_number"),
      },
      async execute(args) {
        await ensureMemoryFile()
        const file = await memoryPath()
        const markdown = await fs.readFile(file, "utf8")
        const entries = parseEntries(markdown)
        const target = resolveEntryIndex(entries, args)
        entries.splice(target.index, 1)
        const backup = await backupFile(file, `before memory_remove ${target.label}`)
        await fs.writeFile(file, renderEntries(markdown, entries), "utf8")
        return `Removed memory entry. Backup: ${backup ?? "none"}`
      },
    }),

    skill_create: tool({
      description: "Create a focused agent-managed OpenCode skill under skills/<name>/SKILL.md with validation and backup discipline",
      args: {
        name: tool.schema.string().describe("Skill name, lowercase words separated by hyphens"),
        description: tool.schema.string().describe("Specific trigger description, 1-1024 chars"),
        body: tool.schema.string().describe("Markdown skill body with procedure, pitfalls, and verification"),
        overwrite: tool.schema.boolean().optional().describe("Overwrite only if an existing managed skill should be replaced"),
      },
      async execute(args) {
        validateSkillName(args.name)
        if (args.name === MEMORY_NAME) throw new Error("Use memory_* tools for global-memory.")
        const description = safeDescription(args.description)
        const body = safeBody(args.body)
        const file = await skillPath(args.name)
        const exists = await pathExists(file)
        if (exists) {
          const current = await fs.readFile(file, "utf8")
          await ensureManagedSkill(args.name, current, false)
          if (!args.overwrite) throw new Error(`Managed skill '${args.name}' already exists. Use skill_patch or set overwrite after explicit approval.`)
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        const backup = exists ? await backupFile(file, "before skill_create overwrite") : null
        await fs.writeFile(file, `${frontmatter(args.name, description)}\n${body}\n`, "utf8")
        return `${exists ? "Replaced" : "Created"} managed skill '${args.name}'. Backup: ${backup ?? "none"}`
      },
    }),

    skill_patch: tool({
      description: "Patch one existing managed skill by replacing an exact old_string with new_string; unmanaged skills require host permission approval",
      args: {
        name: tool.schema.string().describe("Skill name"),
        old_string: tool.schema.string().describe("Exact text to replace; must occur once"),
        new_string: tool.schema.string().describe("Replacement text"),
        allow_unmanaged: tool.schema.boolean().optional().describe("Request host permission approval before patching an unmanaged skill"),
      },
      async execute(args, context) {
        validateSkillName(args.name)
        if (args.name === MEMORY_NAME) throw new Error("Use memory_* tools for global-memory.")
        const file = await skillPath(args.name)
        const current = await fs.readFile(file, "utf8")
        await ensureManagedSkill(args.name, current, args.allow_unmanaged, context)
        if (!args.old_string) throw new Error("old_string is empty.")
        scanUnsafe(args.new_string)
        const occurrences = current.split(args.old_string).length - 1
        if (occurrences !== 1) throw new Error(`Expected old_string to occur exactly once; found ${occurrences}.`)
        const next = current.replace(args.old_string, args.new_string)
        if (skillBodyLength(next) > SKILL_BODY_LIMIT) {
          throw new Error(`Skill body would exceed ${SKILL_BODY_LIMIT} chars.`)
        }
        const backup = await backupFile(file, "before skill_patch")
        await fs.writeFile(file, next, "utf8")
        return `Patched skill '${args.name}'. Backup: ${backup ?? "none"}`
      },
    }),

    skill_archive: tool({
      description: "Archive a managed agent-created skill instead of deleting it",
      args: {
        name: tool.schema.string().describe("Managed skill name to archive"),
        reason: tool.schema.string().describe("Why the skill is being archived, <= 500 chars"),
      },
      async execute(args) {
        validateSkillName(args.name)
        if (args.name === MEMORY_NAME) throw new Error("global-memory cannot be archived by this tool.")
        const reason = safeArchiveReason(args.reason)
        const dir = await skillDir(args.name)
        const file = await assertExistingInside(path.join(dir, "SKILL.md"))
        const current = await fs.readFile(file, "utf8")
        await ensureManagedSkill(args.name, current, false)
        const archiveRoot = await assertInsideForWrite(path.join(await stateRoot(), "archive"))
        await fs.mkdir(archiveRoot, { recursive: true })
        const dest = await assertInsideForWrite(path.join(archiveRoot, `${args.name}-${timestamp()}`))
        const backup = await backupFile(file, `before skill_archive: ${reason}`)
        await fs.rename(dir, dest)
        await fs.writeFile(path.join(dest, "ARCHIVE_REASON.txt"), reason, "utf8")
        return `Archived skill '${args.name}' to ${dest}. Backup: ${backup ?? "none"}`
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

const defaultTools = createLearningGuardTools()

export const memory_list = defaultTools.memory_list
export const memory_audit = defaultTools.memory_audit
export const memory_add = defaultTools.memory_add
export const memory_replace = defaultTools.memory_replace
export const memory_remove = defaultTools.memory_remove
export const skill_create = defaultTools.skill_create
export const skill_patch = defaultTools.skill_patch
export const skill_archive = defaultTools.skill_archive
