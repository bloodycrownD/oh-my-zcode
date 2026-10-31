import type { ZCodeProvider } from "@zcode/shared";

type SkillSourceType = "glm" | "unknown";

export function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  // FORK(upgrade-316)：目录约定是双轨的——用户级 HOME 在 fork 品牌改名为 `.omz`
  // （~/.omz/skills、~/.omz/cli/plugins/cache），工作区级 `.zcode/skills` 是仓库内容
  // 约定、不参与改名（见 skillsService.ts 的目录注释）。此前只认 `.omz` 会让
  // 工作区 `.zcode/skills` 里没有 `glm:` 前缀 id 的技能被 / $ 面板与设置页过滤掉。
  if (normalized.includes("/.omz/skills/")) {
    return "glm";
  }
  if (normalized.includes("/.omz/cli/plugins/cache/")) {
    return "glm";
  }
  if (normalized.includes("/.zcode/skills/")) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

function isZcodeSkill(skill: { id?: string; path: string; scope?: string }): boolean {
  return (
    // plugin skill 的真实路径在 CLI plugin cache 下，不在 `.omz/skills`。
    // 服务层已用 scope 标记来源，前端过滤时要放行，否则 `/` 和 `$` 面板会漏掉插件技能。
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill.path) === "glm"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: ZCodeProvider,
): T[] {
  return skills.filter(isZcodeSkill);
}
