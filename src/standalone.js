import { createLearningGuardTools } from "./tools.js"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

async function optionalPackageAdapters() {
  try {
    const [{ tool }, { Effect }] = await Promise.all([
      import("@opencode-ai/plugin"),
      import("effect"),
    ])
    return {
      toolFactory: tool,
      runPermissionEffect: Effect.runPromise,
    }
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {}
    throw error
  }
}

function standaloneConfigRoot() {
  const envRoot = process.env.OPENCODE_CONFIG_ROOT
  if (typeof envRoot === "string" && envRoot.trim()) return envRoot

  const here = fileURLToPath(import.meta.url)
  const fileName = path.basename(here)
  const toolsDir = path.basename(path.dirname(here))
  if (fileName === "oc_learning.js" && toolsDir === "tools") {
    return path.dirname(path.dirname(here))
  }

  throw new Error("Standalone oc_learning tools require OPENCODE_CONFIG_ROOT or placement at <config-root>/tools/oc_learning.js.")
}

const tools = createLearningGuardTools({
  configRoot: standaloneConfigRoot(),
  ...(await optionalPackageAdapters()),
})

export const memory_list = tools.memory_list
export const memory_audit = tools.memory_audit
export const memory_add = tools.memory_add
export const memory_replace = tools.memory_replace
export const memory_remove = tools.memory_remove
export const skill_create = tools.skill_create
export const skill_patch = tools.skill_patch
export const skill_archive = tools.skill_archive
