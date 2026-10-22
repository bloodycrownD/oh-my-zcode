import { createContext, useCallback, useContext, useState } from "react";
import {
  TrajectorySearchRevealContext,
  TrajectorySearchRevealTurnContext,
} from "@/ModelTrajectorySearch.js";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";

export interface TrajectoryExpansionCommand {
  expanded: boolean;
  version: number;
}

export type TrajectoryExpansionCommands = Record<TrajectoryVisualRole, TrajectoryExpansionCommand>;

export const TRAJECTORY_EXPANSION_KINDS: readonly TrajectoryVisualRole[] = [
  // 回合级命令排在最前：「自定义展开」菜单按此序渲染，回合项与工具栏全量入口都写它。
  "turn",
  "system",
  "user",
  "reasoning",
  "assistant",
  "tool-call",
  "tool-result",
];

/**
 * 回合级展开键前缀（B-1/B-8）。
 * key 形如 `turn:<turnId>`；无 turnId 的 fallback 组为 `turn:fallback:<首条 requestId>`。
 * 前缀同时用于面板「清理回合级 override」的判定（Pane 只重置 `turn:` 命名空间，
 * 不动消息行的 override）。Turns.ts 是零 `@/` 纯函数区，不能反向导入本模块，
 * 前缀在那里以字面量出现，两处必须保持一致。
 */
export const TRAJECTORY_TURN_EXPANSION_KEY_PREFIX = "turn:";

export function createTrajectoryExpansionCommands(): TrajectoryExpansionCommands {
  return Object.fromEntries(
    // v1.0.19：全部默认收起（用户拍板「trace 中所有内容均折叠」）。
    // 回合点开后是单行行列表（消息行单行预览、配对卡单行头部），点击展开；
    // 「全部展开/收起」工具栏按钮与搜索命中强制展开不受默认值影响。
    // 命令初始值必须与各自的首屏展开态一致，否则菜单开关会与实际相反。
    TRAJECTORY_EXPANSION_KINDS.map((kind) => [kind, { expanded: false, version: 0 }]),
  ) as TrajectoryExpansionCommands;
}

/**
 * 展开聚合口径（v1.0.19 P1-4）：7 个命令槽是否全部展开。
 * 只看命令槽的 expanded 值，per-row override 不参与聚合
 * （override 命中与否由命令 version 与 override 的 commandVersion 比较决定）。
 */
export function areAllTrajectoryExpansionKindsExpanded(
  commands: TrajectoryExpansionCommands,
): boolean {
  return TRAJECTORY_EXPANSION_KINDS.every((kind) => commands[kind].expanded);
}

/**
 * 批量写全部命令槽（工具栏「全部展开/收起」入口，v1.0.19 P1-4）。
 * 7 槽写同一 `{expanded, version}`：version 递增以覆盖此前逐行 override 记录的 commandVersion。
 * 目标态由调用方给出（全展开→收起；任一未展开→展开）。
 */
export function setAllTrajectoryExpansionKinds(
  commands: TrajectoryExpansionCommands,
  expanded: boolean,
  version: number,
): TrajectoryExpansionCommands {
  const next: TrajectoryExpansionCommands = { ...commands };
  for (const kind of TRAJECTORY_EXPANSION_KINDS) {
    next[kind] = { expanded, version };
  }
  return next;
}

/**
 * 剔除回合命名空间（`turn:` 前缀）的 per-row override。
 * 两个回合写入口（工具栏全量、菜单「回合」项）在写 turn 槽前都要调用——
 * 否则被 override 钉住的回合对翻转无响应（现状语义保留）；非 turn 行 override 不清理。
 */
export function withoutTrajectoryTurnOverrides(
  overrides: ReadonlyMap<string, TrajectoryExpansionOverride>,
): Map<string, TrajectoryExpansionOverride> {
  const next = new Map<string, TrajectoryExpansionOverride>();
  for (const [key, override] of overrides) {
    if (!key.startsWith(TRAJECTORY_TURN_EXPANSION_KEY_PREFIX)) next.set(key, override);
  }
  return next;
}

export const TrajectoryExpansionCommandContext = createContext<TrajectoryExpansionCommands | null>(
  null,
);

export interface TrajectoryExpansionOverride {
  open: boolean;
  commandVersion: number;
}

interface TrajectoryExpansionRegistry {
  overrides: ReadonlyMap<string, TrajectoryExpansionOverride>;
  setOverride: (key: string, override: TrajectoryExpansionOverride) => void;
}

export const TrajectoryExpansionRegistryContext = createContext<TrajectoryExpansionRegistry | null>(
  null,
);

export interface TrajectoryExpansionState {
  /** 最终展开态（用户态或搜索命中强制展开）。 */
  open: boolean;
  /** 是否由搜索命中强制展开（展开内容因此不受「显示全部」折叠影响）。 */
  searchRevealed: boolean;
  /** Collapsible 的 onOpenChange：写面板级 override（有 key 且注册表可用时）或局部状态。 */
  handleOpenChange: (nextOpen: boolean) => void;
}

/**
 * 行级「搜索命中强制展开」判定（消息键 + 回合键两个命名空间，命中任一即为真）。
 *
 * 与 useTrajectoryExpansion 内的 searchRevealed 口径完全一致，抽成独立 hook 是为了让
 * 非折叠行（如输入区 assistant 扁平行）也能复用同一判定来源——它们没有展开态，
 * 只需要知道「本行是否被搜索命中」以决定是否跳过 clamp。
 *
 * v1.0.19（P1-5）：reveal 上下文由「单个 active 键」放宽为「本次查询的全部命中键集合」，
 * 判定改为集合成员判断（消息键与回合键两个命名空间保持不重叠）。
 */
export function useTrajectorySearchRevealed(key?: string): boolean {
  const messageRevealKeys = useContext(TrajectorySearchRevealContext);
  const turnRevealKeys = useContext(TrajectorySearchRevealTurnContext);
  if (!key) return false;
  return messageRevealKeys.has(key) || turnRevealKeys.has(key);
}

/**
 * 轨迹行/回合外壳共用的展开状态（B-9，从 ExpandableMessage 内联实现抽出）。
 *
 * 优先级（与实现同源，见下方 userOpen 计算）：
 * - 命令槽（`commandKind`）的 version **新于**该行 override 记录的 commandVersion 时，
 *   以命令的 expanded 为准（「自定义展开」菜单项与工具栏全量入口都会递增 version，
 *   因此批量写之后命令天然覆盖此前逐行做过的展开选择）；
 * - 否则以该行 override 的 open 为准；没有 override 时退到局部状态（defaultOpen）。
 * 搜索命中在上述结果之上强制展开，且不写 override。
 * - 命令槽按 `commandKind` 取；回合外壳传 `"turn"`，消息行传视觉角色。
 * - 搜索命中键读取两个上下文：消息键（`TrajectorySearchRevealContext`）与
 *   回合键（`TrajectorySearchRevealTurnContext`）命名空间不重叠，命中任一即展开。
 */
export function useTrajectoryExpansion({
  key,
  commandKind,
  defaultOpen = false,
}: {
  key?: string;
  commandKind: TrajectoryVisualRole;
  /** 无 override、无命令时的初始展开态：默认收起，与面板整体默认折叠一致。 */
  defaultOpen?: boolean;
}): TrajectoryExpansionState {
  const expansionCommands = useContext(TrajectoryExpansionCommandContext);
  const expansionRegistry = useContext(TrajectoryExpansionRegistryContext);
  const [localExpansion, setLocalExpansion] = useState({
    open: defaultOpen,
    commandVersion: 0,
  });

  const expansionCommand = expansionCommands?.[commandKind];
  const persistedExpansion = key ? expansionRegistry?.overrides.get(key) : undefined;
  const rowExpansion = persistedExpansion ?? localExpansion;
  const userOpen =
    expansionCommand && expansionCommand.version > rowExpansion.commandVersion
      ? expansionCommand.expanded
      : rowExpansion.open;
  const searchRevealed = useTrajectorySearchRevealed(key);

  const commandVersion = expansionCommand?.version;
  const rowCommandVersion = rowExpansion.commandVersion;
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      const override = {
        open: nextOpen,
        commandVersion: commandVersion ?? rowCommandVersion,
      };
      if (key && expansionRegistry) {
        expansionRegistry.setOverride(key, override);
      } else {
        setLocalExpansion(override);
      }
    },
    [commandVersion, expansionRegistry, key, rowCommandVersion],
  );

  return { open: userOpen || searchRevealed, searchRevealed, handleOpenChange };
}
