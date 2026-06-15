import {
  createLearningGuardTools,
  memory_add,
  memory_audit,
  memory_list,
  memory_remove,
  memory_replace,
  skill_archive,
  skill_create,
  skill_patch,
} from "./tools.js"

export {
  createLearningGuardTools,
  memory_add,
  memory_audit,
  memory_list,
  memory_remove,
  memory_replace,
  skill_archive,
  skill_create,
  skill_patch,
}

const TOOL_ALIASES = {
  oc_learning_memory_add: "memory_add",
  oc_learning_memory_audit: "memory_audit",
  oc_learning_memory_list: "memory_list",
  oc_learning_memory_remove: "memory_remove",
  oc_learning_memory_replace: "memory_replace",
  oc_learning_skill_archive: "skill_archive",
  oc_learning_skill_create: "skill_create",
  oc_learning_skill_patch: "skill_patch",
}

const TOOLSETS = {
  all: Object.keys(TOOL_ALIASES),
  improver: Object.keys(TOOL_ALIASES),
  "memory-read": ["oc_learning_memory_list", "oc_learning_memory_audit"],
  "memory-write": [
    "oc_learning_memory_list",
    "oc_learning_memory_audit",
    "oc_learning_memory_add",
    "oc_learning_memory_replace",
    "oc_learning_memory_remove",
  ],
  "skills-write": [
    "oc_learning_skill_create",
    "oc_learning_skill_patch",
    "oc_learning_skill_archive",
  ],
  none: [],
}

function pluginConfigRoot(options = {}) {
  const root = options.configRoot ?? options.config_root ?? process.env.OPENCODE_CONFIG_ROOT
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("opencode-learning-guard plugin requires a configRoot option or OPENCODE_CONFIG_ROOT.")
  }
  return root
}

function enabledToolIds(options = {}) {
  const explicit = options.enabledTools ?? options.enabled_tools
  if (explicit !== undefined) {
    if (!Array.isArray(explicit)) throw new Error("enabledTools must be an array of oc_learning tool ids.")
    return validateToolIds(explicit)
  }

  const toolset = options.toolset ?? options.tool_set ?? "all"
  if (!Object.hasOwn(TOOLSETS, toolset)) {
    throw new Error(`Unknown toolset '${toolset}'. Use one of: ${Object.keys(TOOLSETS).join(", ")}.`)
  }
  return TOOLSETS[toolset]
}

function validateToolIds(toolIds) {
  for (const toolId of toolIds) {
    if (!Object.hasOwn(TOOL_ALIASES, toolId)) {
      throw new Error(`Unknown oc_learning tool id '${toolId}'. Use one of: ${Object.keys(TOOL_ALIASES).join(", ")}.`)
    }
  }
  return [...new Set(toolIds)]
}

function toolMap(tools, options = {}) {
  const selected = {}
  for (const toolId of enabledToolIds(options)) {
    selected[toolId] = tools[TOOL_ALIASES[toolId]]
  }
  return selected
}

export const LearningGuardPlugin = async (_input, options = {}) => {
  const tools = createLearningGuardTools({ configRoot: pluginConfigRoot(options) })
  await tools.assertReady()
  return {
    tool: toolMap(tools, options),
  }
}

export default LearningGuardPlugin
