import {
  createLearningGuardTools,
  memory_add,
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
  memory_list,
  memory_remove,
  memory_replace,
  skill_archive,
  skill_create,
  skill_patch,
}

function pluginConfigRoot(options = {}) {
  const root = options.configRoot ?? options.config_root ?? process.env.OPENCODE_CONFIG_ROOT
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("opencode-learning-guard plugin requires a configRoot option or OPENCODE_CONFIG_ROOT.")
  }
  return root
}

function toolMap(tools) {
  return {
    oc_learning_memory_add: tools.memory_add,
    oc_learning_memory_list: tools.memory_list,
    oc_learning_memory_remove: tools.memory_remove,
    oc_learning_memory_replace: tools.memory_replace,
    oc_learning_skill_archive: tools.skill_archive,
    oc_learning_skill_create: tools.skill_create,
    oc_learning_skill_patch: tools.skill_patch,
  }
}

export const LearningGuardPlugin = async (_input, options = {}) => {
  const tools = createLearningGuardTools({ configRoot: pluginConfigRoot(options) })
  await tools.assertReady()
  return {
    tool: toolMap(tools),
  }
}

export default LearningGuardPlugin
