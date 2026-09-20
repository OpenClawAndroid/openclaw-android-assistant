/** Reuse the native bounded Skill reader with host-owned per-file authorization. */
export async function readWorkspaceSkillResources(
  ...args: Parameters<typeof import("../skills/runtime/resources.js").readSkillResourceFiles>
) {
  const { readSkillResourceFiles } = await import("../skills/runtime/resources.js");
  return readSkillResourceFiles(...args);
}
