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
  // 回合级命令排在最前：面板工具栏的「全部展开/收起」只切它（B-6 语义改回合级）。
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
    // 回合外壳默认收起（与 useTrajectoryExpansion 的 defaultOpen 对齐），
    // 消息行默认展开——命令初始值必须与各自的首屏展开态一致，否则菜单开关会与实际相反。
    TRAJECTORY_EXPANSION_KINDS.map((kind) => [kind, { expanded: kind !== "turn", version: 0 }]),
  ) as TrajectoryExpansionCommands;
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
 */
export function useTrajectorySearchRevealed(key?: string): boolean {
  const messageRevealKey = useContext(TrajectorySearchRevealContext);
  const turnRevealKey = useContext(TrajectorySearchRevealTurnContext);
  return Boolean(key && (key === messageRevealKey || key === turnRevealKey));
}

/**
 * 轨迹行/回合外壳共用的展开状态（B-9，从 ExpandableMessage 内联实现抽出）。
 *
 * 优先级（与抽出前逐字一致）：面板 override > 命令版本（「自定义展开」/全部展开）
 * > 局部状态（defaultOpen）。搜索命中在之上强制展开，不写 override。
 * - 命令槽按 `commandKind` 取；回合外壳传 `"turn"`，消息行传视觉角色。
 * - 搜索命中键读取两个上下文：消息键（`TrajectorySearchRevealContext`）与
 *   回合键（`TrajectorySearchRevealTurnContext`）命名空间不重叠，命中任一即展开。
 */
export function useTrajectoryExpansion({
  key,
  commandKind,
  defaultOpen = true,
}: {
  key?: string;
  commandKind: TrajectoryVisualRole;
  /** 无 override、无命令时的初始展开态：消息行默认展开，回合外壳默认收起。 */
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
