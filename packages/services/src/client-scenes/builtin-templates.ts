import type { ClientSceneConfig, ClientSceneItem } from "./clientScenes.js";

/**
 * FORK（D-6）：`/api/v1/client/scenes` 的网络拉取整删，改读随包内置模板清单。
 *
 * 三条硬约束（任一不满足会被 `automationTemplateCatalog` 全量 reject，T-HP1 红）：
 *   1. scene 固定 `"scheduled-task"`；
 *   2. 每个 cronExpr 的 zh/en 两 locale 文本必须**逐字相同**——cron 不是自然语言，
 *      按 locale 配出不同表达式会让点击结果不可预测；
 *   3. 每条 cronExpr 必须同时过 `isValidCronExpr` 与 `canVisualizeCronInAutomationEditor`，
 *      即落在 Automation builder 的五段子集内（不可用固定月日 `M H D D *` 或日期步长 `M H D ..\/N *`）。
 */

interface ScheduledTemplateSeed {
  readonly id: string;
  readonly cronExpr: string;
  readonly icon: string;
  readonly title: { readonly cn: string; readonly en: string };
  /** catalog 把 contents 同时当 description 与 prompt，因此两处共用同一段文案。 */
  readonly body: { readonly cn: string; readonly en: string };
}

const SCHEDULED_TEMPLATE_SEEDS: readonly ScheduledTemplateSeed[] = [
  {
    id: "item-daily-standup",
    cronExpr: "30 8 * * 1-5",
    icon: "target",
    title: { cn: "工作日晨报", en: "Weekday standup" },
    body: {
      cn: "工作日早上 8:30 汇总昨日进展、遗留问题与今日计划。",
      en: "At 8:30 on weekdays, summarize yesterday's progress, open issues and today's plan.",
    },
  },
  {
    id: "item-weekly-review",
    cronExpr: "0 18 * * 5",
    icon: "list",
    title: { cn: "每周复盘", en: "Weekly review" },
    body: {
      cn: "每周五 18:00 汇总本周已完成事项与下周重点。",
      en: "At 18:00 on Fridays, summarize this week's completed work and next week's focus.",
    },
  },
  {
    id: "item-daily-repo-health",
    cronExpr: "0 10 * * *",
    icon: "activity",
    title: { cn: "仓库健康巡检", en: "Repository health check" },
    body: {
      cn: "每天上午 10:00 巡检构建、测试与 CI 风险。",
      en: "At 10:00 every day, inspect build, test and CI risks.",
    },
  },
  {
    id: "item-monthly-release-notes",
    cronExpr: "0 15 1 * *",
    icon: "file",
    title: { cn: "月度发布说明", en: "Monthly release notes" },
    body: {
      cn: "每月 1 日 15:00 汇总发布说明。",
      en: "At 15:00 on the first of each month, summarize release notes.",
    },
  },
];

const CRON_ITEMS: readonly ClientSceneItem[] = SCHEDULED_TEMPLATE_SEEDS.map((seed) => ({
  id: `cron-${seed.id}`,
  type: "cron",
  // 约束 2：两个 locale 必须逐字相同。
  contents: { "zh-CN": seed.cronExpr, "en-US": seed.cronExpr },
  labels: { "zh-CN": seed.cronExpr, "en-US": seed.cronExpr },
}));

const PROMPT_ITEMS: readonly ClientSceneItem[] = SCHEDULED_TEMPLATE_SEEDS.map((seed) => ({
  id: seed.id,
  type: "prompt",
  contents: { ...seed.body },
  descs: { ...seed.body },
  labels: { ...seed.title },
  img: seed.icon,
  // catalog 靠 defaults.cronExpr 找到本模板对应的 cron 项。
  defaults: { cronExpr: [`cron-${seed.id}`] },
}));

/** 随包内置的 client scenes 清单；当前只有 scheduled-task 一个 scene。 */
export const BUILTIN_CLIENT_SCENES: readonly ClientSceneConfig[] = [
  {
    namespace: "client",
    scene: "scheduled-task",
    options: {
      cronExpr: {
        id: "cronExpr",
        type: "select",
        contents: { "zh-CN": "定时表达式", "en-US": "Cron expression" },
        items: [...CRON_ITEMS],
      },
      prompts: {
        id: "prompts",
        type: "select",
        contents: { "zh-CN": "定时任务模板", "en-US": "Scheduled task templates" },
        items: [...PROMPT_ITEMS],
      },
    },
  },
];