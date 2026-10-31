interface RawFinding {
  /** 问题位置，worktree 相对路径带行号，如 "packages/ui/src/v4/composer/V4ComposerToolbar.tsx:643" */
  where: string;
  /** 一句话：什么错了（现象与影响，不是修法） */
  what: string;
  /** 证据：实际读到的代码行或命令输出，具体到可复查 */
  evidence: string;
  /** low=边角瑕疵 medium=功能退化 high=数据丢失/崩溃/错误结果 */
  severity: "low" | "medium" | "high";
}
interface ShardResult {
  findings: RawFinding[];
  /** 本片实际检查过的文件与命令，供报告 verified 使用 */
  covered: string[];
}
interface Confirmation {
  /** confirmed=独立复核成立 refuted=复核驳回 uncertain=无法独立判定 */
  verdict: "confirmed" | "refuted" | "uncertain";
  /** 一句话：确认依据或驳回理由 */
  note: string;
}
interface Finding extends RawFinding {
  status: "verified" | "unconfirmed";
  confirmNote: string;
}
interface Triaged {
  /** 去重合并后保留的发现（可调整 severity，附最终判级） */
  kept: Finding[];
  /** 被合并或驳回的条目及理由 */
  merged: string[];
  /** 一句话：修复优先级排序建议 */
  priority: string;
}

const WORKTREE = "D:/worktree/upstream-316-gitline";

const COMMON = `你在审查一次上游版本合并（zcode v3.14.3 血缘 fork 合并上游 v3.16.2）后的代码树，找「合并干净但语义错位」的问题。

工作树（所有文件读这里）：${WORKTREE}
对照基准（用 Bash 的 git -C ${WORKTREE} ... 查）：
- fork 合并前基线：git -C ${WORKTREE} show main:<路径>（main 分支是 fork 的旧 HEAD）
- 上游 v3.16.2 原版：git -C ${WORKTREE} show upstream/v3.16.2:<路径> 或 tag v3.16.2（先用 git -C ${WORKTREE} tag -l 确认 tag 名）
- 当前工作区状态：git -C ${WORKTREE} status --short、git -C ${WORKTREE} diff main --stat

背景：fork 已删除上游的商业化面——官方账号/登录、计费(codingPlan/off-peak)、遥测(telemetry/OpenTelemetry)、会话分享、营销、highspeed 加速、原生压缩链(core/src/compact，压缩由 fork 自有的 Magic Context 接管)。fork 自有必须保留的：Magic Context(MC) 全家、spec C（v4-gateway 窗口化 hydrate / row manifest / keep-warm / 命令级读写锁）、v4 协议接线。

教学样例（这类问题的典型形态，已修复，不要重复报）：
- 滑块闪烁：fork 保留的 V4ComposerToolbar 没传上游新 prop composerOptions → 上游新滑条 UI 静默缺席；随后调档投影重读一帧 model 空串 → popper 重定位+disabled 闪烁。形态=「fork 保留的调用点没接上游新信号」。
- taskRunningReconcile 劈叉（已修）：fork 写侧 completeRunningRows 写 task_status+meta_json，上游读侧 rowToMeta 改为从 cli_last_outcome 派生 status → 收敛成功但读回 undefined。形态=「fork 写侧 × 上游读侧列口径劈叉」。
- ModelConfigSelect presentation 冻结（已修）：上游冻结机制以 providerMenu.pending 为信号，fork 无 providerMenu → 冻结永不触发。形态=「上游机制依赖 fork 已删输入而静默失效」。

其它已修勿重复报：T-DWF-1 engine countNodes 窄读回退、迁移 0006 撞号顺延 0007/0008、G-3 runtimeInitialization 键、shared #src/ 子路径改相对路径、MC 接触面注释、window-close-tray 的 createDesktopTray 改名适配、tsup node:sqlite 说明符回写、styles.css 残留 highspeed @import。

规则：
- 只读不改：不编辑任何文件、不 git add/commit。
- 每条发现必须给出 path:line 级证据（引用你实际读到的代码行）；推测而无证据的不要。
- 宁缺毋滥：最多 8 条，按严重度从高到低。
- 若某方面你查了没发现问题，也要在 covered 里说明查了什么，这样报告能区分「没事」和「没查」。
- 用中文写 what/evidence。
- 最终回复必须是一个 JSON 代码块，结构严格匹配你被要求返回的类型，不要附加多余文本。`;

interface Shard {
  id: string;
  name: string;
  focus: string;
}

const SHARDS: Shard[] = [
  {
    id: "ui-wiring",
    name: "UI 接线断线",
    focus: `专查「fork 保留的 UI 调用点没接上游 v3.16 新增或变更的 props/信号/回调」。
方法：挑上游 v3.16.2 在 packages/ui/src/chat-input-toolbar/ 与 packages/ui/src/project-sidebar/ 下的核心组件（ModelConfigSelect、ComposerModelMenu、ComposerProviderMenu、ThoughtLevelCycleControl、ChatModeSwitchControl、WorkspaceGroupedTasksSection、useTaskGroups、ConversationTimeline 等），对每个组件：
1) 读当前树里它的 Props 接口定义；
2) git show upstream/v3.16.2:<同路径> 对比接口差异（上游新增的 prop / 语义变化的 prop）；
3) grep 当前树所有调用点，核对是否传了这些 prop，没传的影响是什么（silent fallback？功能缺席？）。
重点：上游新增的可选 prop 在 fork 调用点缺席时走默认分支，默认分支行为对 fork 是对是错。composerOptions 已修不报。`,
  },
  {
    id: "rw-split",
    name: "读写口径劈叉",
    focus: `专查「fork 保留的写侧 × 上游覆盖的读侧」列口径/形状劈叉（同一字段写 A 读 B）。
起点：packages/services/src/tasks-index/taskIndexRepo.ts（rowToMeta / applyCliFacts / writeRecord / completeRunningRows 已修不报，找其它列）、packages/services/src/tasks-index/zcodeTaskIndexSyncer.ts、sessions-index 相关、packages/services/src/node.ts 的服务装配、apps/zcode-cli/packages/bootstrap 的 conversation-topic-publisher.ts 与 product-projection.ts（投影字段派生）。
方法：对每个「状态列/投影字段/枚举值」建三元组检查：上游 v3.16.2 的读方从什么列派生什么值（git show upstream/v3.16.2 对照），fork 写侧现在写什么形状，中间有没有映射断层。特别枚举值集合：上游新增的枚举成员（如 runtimeInitialization 的 initializing、任务状态新值）fork 写侧会不会漏写或写旧值。`,
  },
  {
    id: "dead-mechanism",
    name: "上游机制静默失效",
    focus: `专查「上游 v3.16 的机制依赖 fork 已删输入，fork 下静默失效或分支死锁」。
方法：在 packages/ui/src 与 apps/zcode-cli/packages/{core,bootstrap} 里 grep 上游组件引用的已删面符号（providerMenu、highspeed、highspeedPresented、codingPlan、telemetry、agentTelemetry、compactBoundary、ZCodeProviderAccountAccess、OAuth），对每处命中：
1) 读当前树该分支的条件表达式，判断在 fork（这些输入恒为 undefined/false/空）下走哪条路；
2) 那条路对用户是「无害的降级」还是「功能静默失效/UI 死角/逻辑死锁」；
3) presentation 冻结已修不报；model-runtime-headers 垫片已做，但可检查垫片调用方对 undefined 的处理是否正确。
也查反方向：fork 自有逻辑（MC 接线、spec C 闸门）有没有被上游同文件新代码绕过（如上游新增的调用路径没过 fork 的闸门）。`,
  },
  {
    id: "shims",
    name: "垫片与残留",
    focus: `专查本次合并修复中引入的垫层（no-op 模块、恒定返回、删实现留 import）本身的正确性与必要性。
方法：
1) git -C ${WORKTREE} diff main --stat 拿全量改动文件清单，挑出「新增的垫片文件」（如 packages/ui/src/lib/appTelemetry.ts 等）与「小改动文件」（几行的 import 修补）；
2) grep -rn "FORK(upgrade-316)" 与 "no-op" 拿到全部标记点；
3) 逐个判断三类：(a) 真死代码可删（调用方根本不读结果）；(b) 该真接线（调用方读结果且结果该有值——如 useUiPluginRecommendations、useVulnerabilityReportUrl、WebLoginPage 之前被标过存疑）；(c) 垫片有副作用（改变上游默认行为、吞错误、破坏缓存键）。
每条给出调用方证据（谁 import 它、读不读返回值）。`,
  },
  {
    id: "migrations",
    name: "迁移与升级路径",
    focus: `专查数据库迁移的编号、checksum 与老库升级路径。
方法：
1) 全仓找迁移清单：grep -rn "migrations" --include="*.ts" 找 schema 目录（已知 packages/services/src/tasks-index/ 的 default-workspace、packages/adapters 的迁移、packages/shared/src/sqlite-migrations 框架），列出每个目录当前的迁移 id 序列；
2) 对每个目录 git show main:<路径> 对照 fork 基线的 id 序列，查：编号撞号（同 id 不同内容）、fork 老库已应用的 id 在新树里变成不同迁移、孤儿 id（老库账本有而新清单没有——runner 是否校验）；
3) 已知已修：tasks-index 的 0006 撞号顺延 0007/0008、adapters 0023→0025——验证这两处顺延后的序列仍单调且老库（已应用 fork 0006_task_group_admissions）首启 ensureReady 不报 checksum mismatch、不重放、不丢列；
4) 检查新增迁移的 up 是否幂等（ADD COLUMN 前判列存在）。`,
  },
  {
    id: "test-rewrites",
    name: "测试改写审计",
    focus: `专查本次合并中「为了过门禁改过断言/夹具的测试」是否掩盖了真回归。
已知改过的测试（逐个审）：packages/services/test 的 nonCliAcpRetirement.test.ts（改断言为 migrateLegacyAcpTaskIds 迁移语义）、taskRunningReconcile 相关（终态种子 lastOutcome、notEqual completed）、apps/zcode-cli 的 engine-resume 测试（T-DWF-1 已补窄读）、packages/desktop 的 window-close-tray 测试（createDesktopTray/closeToTraySupported 改名）、packages/shared/test/apply.test.ts（runtimeInitialization PATCH_BUILDERS）、zcodeTaskServiceAdapterStreamFallback（补 syncSnapshotAndBroadcast 桩返回真 meta）、held-queue-routing（锚点挪到 input-admission.ts）、setHighspeedMetrics 断言。
方法：对每个测试，读当前断言 + git show main:<路径> 旧断言 + 读被测代码当前行为，三边对照，判：改写是「如实反映上游新语义」（好）还是「把断言放松到什么都过得去 / 绕过了原本守护的 fork 不变量」（坏）。坏的种类：删掉断言、改成永远真、桩替身绕过真实计数点。`,
  },
];

phase("并行审查六个风险面，高严重度发现逐条独立复核");

log(`开始 6 片并行审查：${SHARDS.map((s) => s.name).join(" / ")}`);

const shardResults = await Promise.all(
  SHARDS.map(async (shard) => {
    const reviewer = agent(`评审-${shard.name}`, {
      system:
        `你是资深代码评审员，专门在大型合并后的代码树里找「合并干净但语义错位」的缺陷。` +
        `只读不改。每条结论必须落在具体文件行号上。如果某个检查做不了（文件不存在、命令失败），` +
        `在 covered 里如实说明，不要编造。`,
    });
    const result = await reviewer.ask<ShardResult>(
      `${COMMON}\n\n=== 你的专属审查面 ===\n${shard.focus}\n\n返回 JSON：{ "findings": RawFinding[], "covered": string[] }`,
    );

    const findings: Finding[] = [];
    for (let i = 0; i < result.findings.length; i += 1) {
      const raw = result.findings[i];
      let status: "verified" | "unconfirmed" = "unconfirmed";
      let confirmNote = "低严重度，未独立复核";
      if (raw.severity !== "low") {
        const confirmer = agent(`复核-${shard.id}-${i}`, {
          system:
            `你是独立复核员。拿到别的评审员的发现后，你自己读代码验证它是否成立。` +
            `只读不改。你的判断标准：证据行是否真的存在、推理链是否成立、有没有更简单的解释（比如该行为其实是上游有意为之）。` +
            `拿不准就标 uncertain，不要勉强确认或驳回。`,
        });
        const confirmation = await confirmer.ask<Confirmation>(
          `以下是一条针对 ${WORKTREE}（zcode v3.16.2 合并树）的评审发现，请独立复核：\n${JSON.stringify(raw, null, 2)}\n\n` +
          `对照基准：git -C ${WORKTREE} show main:<路径> 是 fork 合并前基线；git -C ${WORKTREE} show upstream/v3.16.2:<路径> 是上游原版。` +
          `返回 JSON：{ "verdict": "confirmed"|"refuted"|"uncertain", "note": string }`,
        );
        status = confirmation.verdict === "confirmed" ? "verified" : "unconfirmed";
        confirmNote = confirmation.note;
      }
      findings.push({ ...raw, status, confirmNote });
      report({ shard: shard.name, where: raw.where, severity: raw.severity, status });
    }
    log(`「${shard.name}」完成：${findings.length} 条发现`);
    return { shard: shard.name, findings, covered: result.covered };
  }),
);

phase("跨片去重、统一严重度并产出评审报告");

const allFindings = shardResults.flatMap((s) => s.findings);
const triage = await agent("评审组长", {
  system:
    `你是评审组长，把六个评审员的发现汇总成一份可执行的清单。` +
    `你的价值在跨片视角：不同片可能报了同一个根因的不同表象（合并为一条，严重度取高）；` +
    `复核被驳回(refuted)的条目直接丢弃并在 merged 里说明；uncertain 的保留但不要提级。` +
    `只依据给你的 JSON 判断，不要自己再去读代码。`,
});
const triaged = await triage.ask<Triaged>(
  `六片评审结果如下（status=verified 已独立复核，unconfirmed 未复核或复核不确定）：\n${JSON.stringify(allFindings, null, 2)}\n\n` +
  `返回 JSON：{ "kept": Finding[]（去重合并后，severity 统一校准，保持原字段）, "merged": string[]（合并/丢弃说明）, "priority": string }`,
);

const lines: string[] = [
  `# v3.16.2 合并语义错位 CR 报告`,
  ``,
  `> 审查对象：${WORKTREE}（fork 合并上游 zcode v3.16.2 后的工作树）`,
  `> 六片并行审查：${SHARDS.map((s) => s.name).join("、")}`,
  ``,
  `## 结论`,
  ``,
  triaged.priority,
  ``,
  `## 发现（${triaged.kept.length} 条）`,
  ``,
];
for (const f of triaged.kept) {
  lines.push(
    `### [${f.severity.toUpperCase()}${f.status === "verified" ? "/已复核" : "/未定"}] ${f.what}`,
    ``,
    `- 位置：\`${f.where}\``,
    `- 证据：${f.evidence}`,
    `- 复核：${f.confirmNote}`,
    ``,
  );
}
lines.push(
  `## 跨片合并/丢弃`,
  ``,
  ...(triaged.merged.length > 0 ? triaged.merged.map((m) => `- ${m}`) : [`- 无`]),
  ``,
  `## 各片覆盖面`,
  ``,
);
for (const s of shardResults) {
  lines.push(`### ${s.shard}（${s.findings.length} 条）`, ...(s.covered ?? []).map((c) => `- ${c}`), ``);
}

await artifact.markdown("cr-report", lines.join("\n"), {
  title: "v3.16.2 合并语义错位评审报告",
  description: `六片审查 ${allFindings.length} 条原始发现，去重后 ${triaged.kept.length} 条。`,
  primary: true,
});

return {
  conclusion:
    `六片审查共产出 ${allFindings.length} 条原始发现，去重后保留 ${triaged.kept.length} 条` +
    `（其中 ${triaged.kept.filter((f) => f.severity === "high").length} 条 high、` +
    `${triaged.kept.filter((f) => f.status === "verified").length} 条已独立复核）。${triaged.priority}`,
  findings: triaged.kept,
  verified: [
    ...shardResults.map((s) => `${s.shard}：${(s.covered ?? []).join("；")}`),
    `severity 为 medium/high 的发现均由独立复核子代理二次读代码确认，refuted 的已在汇总中丢弃`,
  ],
  notCovered: [
    "dev 真机四项（长会话冷开 / 滚动 / 侧边栏拖拽 / 编辑重发）尚未人工验证，静态审查无法覆盖运行时行为",
    "性能回归（会话打开耗时等 spec C 指标）未测量，需要真机对照 uiViewReady ≤ 1000ms 基线",
    "六片之外的目录（如 apps/zcode-cli/packages/web、provider-node）只被顺带扫过，未逐文件审",
  ],
};
