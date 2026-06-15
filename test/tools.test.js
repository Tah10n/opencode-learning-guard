import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { LearningGuardPlugin, createLearningGuardTools } from "../src/index.js"

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-learning-guard-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function managedSkill(name, body = "Old body") {
  return `---
name: ${name}
description: "Test skill"
license: MIT
compatibility: opencode
metadata:
  managed_by: oc_learning
---
${body}
`
}

function memorySkill(entries) {
  return `---
name: global-memory
description: "Memory"
license: MIT
compatibility: opencode
metadata:
  managed_by: oc_learning
  purpose: persistent-memory
---
# Global Memory

<!-- oc-memory-entries:start -->
${entries.map((entry) => `- ${entry}`).join("\n")}
<!-- oc-memory-entries:end -->
`
}

async function writeSkill(root, name, content) {
  const dir = path.join(root, "skills", name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "SKILL.md"), content, "utf8")
}

test("plugin mode requires an explicit configRoot", async () => {
  await assert.rejects(
    () => LearningGuardPlugin({}, {}),
    /requires a configRoot option/,
  )
})

test("plugin mode writes to the configured OpenCode root", async (t) => {
  const root = await tempDir(t)
  const hooks = await LearningGuardPlugin({}, { configRoot: root })

  await hooks.tool.oc_learning_memory_add.execute({
    content: "Remember verified project conventions compactly.",
  })

  const markdown = await readFile(path.join(root, "skills", "global-memory", "SKILL.md"), "utf8")
  assert.match(markdown, /Remember verified project conventions compactly\./)
})

test("plugin mode can expose only read-only memory tools", async (t) => {
  const root = await tempDir(t)
  const hooks = await LearningGuardPlugin({}, { configRoot: root, toolset: "memory-read" })

  assert.deepEqual(Object.keys(hooks.tool), ["oc_learning_memory_list", "oc_learning_memory_audit"])
})

test("plugin mode can expose an explicit bounded tool list", async (t) => {
  const root = await tempDir(t)
  const hooks = await LearningGuardPlugin({}, {
    configRoot: root,
    enabledTools: ["oc_learning_memory_list", "oc_learning_memory_add", "oc_learning_memory_list"],
  })

  assert.deepEqual(Object.keys(hooks.tool), [
    "oc_learning_memory_list",
    "oc_learning_memory_add",
  ])
})

test("plugin mode rejects unknown toolset and tool ids", async (t) => {
  const root = await tempDir(t)

  await assert.rejects(
    () => LearningGuardPlugin({}, { configRoot: root, toolset: "always-learn" }),
    /Unknown toolset/,
  )

  await assert.rejects(
    () => LearningGuardPlugin({}, { configRoot: root, enabledTools: ["oc_learning_memory_dump"] }),
    /Unknown oc_learning tool id/,
  )
})

test("memory_audit reports cleanup candidates without mutating memory", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "global-memory", memorySkill([
    "Keep durable lessons compact and verified.",
    "Keep durable lessons compact and verified.",
    "For C:\\Users\\example\\repo, run npm run verify before pushing.",
  ]))

  const file = path.join(root, "skills", "global-memory", "SKILL.md")
  const before = await readFile(file, "utf8")
  const report = await tools.memory_audit.execute()
  const after = await readFile(file, "utf8")

  assert.match(report, /Memory cleanup audit/)
  assert.match(report, /\[duplicate\] entry #2/)
  assert.match(report, /safe remove args: entry_number="2"/)
  assert.match(report, /\[scope-review\] entry #3/)
  assert.equal(after, before)
})

test("memory_audit redacts unsafe stored entries in every finding preview", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "global-memory", memorySkill([
    "api_key: super-secret-token",
    "api_key: super-secret-token",
  ]))

  const report = await tools.memory_audit.execute()

  assert.match(report, /\[unsafe\] entry #1/)
  assert.match(report, /\[duplicate\] entry #2/)
  assert.match(report, /<redacted by safety scanner>/)
  assert.doesNotMatch(report, /super-secret-token/)
  assert.doesNotMatch(report, /expected_content=/)
})

test("memory_remove and memory_replace can target duplicate entries by guarded entry number", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "global-memory", memorySkill([
    "Keep durable lessons compact and verified.",
    "Keep durable lessons compact and verified.",
  ]))

  await assert.rejects(
    () => tools.memory_remove.execute({
      old_text: "Keep durable lessons compact",
    }),
    /Expected exactly one match/,
  )

  await assert.rejects(
    () => tools.memory_replace.execute({
      entry_number: "2",
      expected_content: "Different entry.",
      content: "Keep durable lessons compact, verified, and scoped.",
    }),
    /expected_content did not match/,
  )

  await tools.memory_replace.execute({
    entry_number: "2",
    expected_content: "Keep durable lessons compact and verified.",
    content: "Keep durable lessons compact, verified, and scoped.",
  })

  await tools.memory_remove.execute({
    entry_number: "1",
    expected_content: "Keep durable lessons compact and verified.",
  })

  const markdown = await readFile(path.join(root, "skills", "global-memory", "SKILL.md"), "utf8")
  assert.doesNotMatch(markdown, /Keep durable lessons compact and verified\./)
  assert.match(markdown, /Keep durable lessons compact, verified, and scoped\./)
})

test("managed-skill detection only trusts frontmatter metadata", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "fake-managed", `---
name: fake-managed
description: "Unmanaged skill"
---
# Fake

This body mentions metadata:
  managed_by: oc_learning

Old body
`)

  await assert.rejects(
    () => tools.skill_patch.execute({
      name: "fake-managed",
      old_string: "Old body",
      new_string: "New body",
    }),
    /Refusing to mutate unmanaged skill/,
  )
})

test("allow_unmanaged requests host permission instead of acting as approval", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "manual-skill", `---
name: manual-skill
description: "Manual skill"
---
Old body
`)

  await assert.rejects(
    () => tools.skill_patch.execute({
      name: "manual-skill",
      old_string: "Old body",
      new_string: "New body",
      allow_unmanaged: true,
    }),
    /requires host permission approval/,
  )

  let permissionInput = null
  const context = {
    ask(input) {
      permissionInput = input
      return Effect.succeed(undefined)
    },
  }

  await tools.skill_patch.execute({
    name: "manual-skill",
    old_string: "Old body",
    new_string: "New body",
    allow_unmanaged: true,
  }, context)

  assert.equal(permissionInput.permission, "oc_learning.skill_patch.unmanaged")
  assert.deepEqual(permissionInput.patterns, ["skills/manual-skill/SKILL.md"])
})

test("skill_patch enforces the final skill body size", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "managed-skill", managedSkill("managed-skill", "Old body"))

  await assert.rejects(
    () => tools.skill_patch.execute({
      name: "managed-skill",
      old_string: "Old body",
      new_string: "x".repeat(12001),
    }),
    /Skill body would exceed 12000 chars/,
  )
})

test("skill_archive limits archive reason size", async (t) => {
  const root = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  await writeSkill(root, "managed-skill", managedSkill("managed-skill", "Old body"))

  await assert.rejects(
    () => tools.skill_archive.execute({
      name: "managed-skill",
      reason: "x".repeat(501),
    }),
    /Archive reason is 501 chars/,
  )
})

test("skill paths cannot escape the config root through symlinks or junctions", async (t) => {
  const root = await tempDir(t)
  const outside = await tempDir(t)
  const tools = createLearningGuardTools({ configRoot: root })
  const outsideSkill = path.join(outside, "escape")

  await mkdir(path.join(root, "skills"), { recursive: true })
  await mkdir(outsideSkill, { recursive: true })
  await writeFile(path.join(outsideSkill, "SKILL.md"), managedSkill("escape", "Old body"), "utf8")

  try {
    await symlink(outsideSkill, path.join(root, "skills", "escape"), process.platform === "win32" ? "junction" : "dir")
  } catch {
    t.skip("symlink or junction creation is not available in this environment")
    return
  }

  await assert.rejects(
    () => tools.skill_patch.execute({
      name: "escape",
      old_string: "Old body",
      new_string: "New body",
    }),
    /Path escapes allowed root/,
  )

  const outsideMarkdown = await readFile(path.join(outsideSkill, "SKILL.md"), "utf8")
  assert.match(outsideMarkdown, /Old body/)
})
