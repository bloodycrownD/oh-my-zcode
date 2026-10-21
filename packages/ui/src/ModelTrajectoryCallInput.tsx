// 回合内输入区块：wire 消息列表 + B-4 占位行过滤（计数与 toggle 同行）。
//
// 为什么独立成文件：B10 给输入区加上占位过滤状态后，ModelTrajectoryPaneParts.tsx
// 超出 oxlint max-lines(400) 上限；本模块只承接输入区渲染与占位过滤，响应区仍在 PaneParts。
// 依赖方向：PaneParts → 本模块（CallInputSection / TrajectoryRowDivider）；
// 本模块不反向导入 PaneParts，避免循环依赖（AGENTS.md 禁止循环导入）。
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import { createContext, Fragment, useContext, useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TrajectoryClampedPreview } from "@/ModelTrajectoryClampedPreview.js";
import { ExpandableTrajectoryMessage } from "@/ModelTrajectoryExpandableMessage.js";
import { formatTrajectoryDateTime, formatTrajectoryDuration } from "@/ModelTrajectoryFormat.js";
import { messageClipboardText } from "@/ModelTrajectoryMessageView.js";
import { ContentPartView } from "@/ModelTrajectoryPaneDetails.js";
import { trajectoryRoleTextClass } from "@/ModelTrajectoryRoleStyles.js";
import { TrajectorySectionTitle } from "@/ModelTrajectorySectionTitle.js";
import { filterTrajectoryInputRows } from "@/ModelTrajectoryToolJoin.js";
import { trajectoryInputRowKey } from "@/ModelTrajectoryTurns.js";
import { classifyTrajectoryWireRows } from "@/ModelTrajectoryWireFilter.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/**
 * B-4 占位行过滤开关的上下文。spec 拍板：唯一所有者是 ModelTrajectoryPane——
 * Pane 局部 state、默认隐藏、不持久化、不进设置页；输入区只消费，不维护第二份状态。
 */
export interface TrajectoryWireFilterContextValue {
  hidePlaceholders: boolean;
  setHidePlaceholders?: (hide: boolean) => void;
}

export const TrajectoryWireFilterContext = createContext<TrajectoryWireFilterContextValue>({
  // 没有 Provider 的渲染场景保持与面板一致的默认行为。
  hidePlaceholders: true,
});

/** 无配对信息时的空集合常量（保持 memo 依赖稳定）。 */
const EMPTY_TOOL_CALL_IDS: ReadonlySet<string> = new Set<string>();

/**
 * 一次调用的输入区（spec B-4）：wire 占位行默认隐藏，行内显示「已隐藏 N 条」。
 * 隐藏行不改变 expansionKey 与奇偶底色——原始下标始终参与 key，开关切换不会丢展开状态。
 */
export function CallInputSection({
  index,
  record,
  inputMessages,
  expansionKeyPrefix,
  pairedResultToolCallIdsInInput,
  intl,
}: {
  index: number;
  record: ZCodeModelTrajectoryRecord;
  inputMessages: ZCodeModelTrajectoryMessage[];
  expansionKeyPrefix?: string;
  /** 该 record 输入消息里已被配对消费的 tool-result id 集合（配对卡已展示结果，行不再重复）。 */
  pairedResultToolCallIdsInInput?: ReadonlySet<string>;
  intl: IntlShape;
}) {
  const { hidePlaceholders, setHidePlaceholders } = useContext(TrajectoryWireFilterContext);
  // 行级分类来自 WireFilter 纯函数（唯一分类实现，防双轨漂移）；
  // messageIndex 保留原始下标——expansionKey 与奇偶底色不随开关切换变化。
  // N-3：已被配对消费的 tool-result 行不再重复展示（结果已在配对卡的 result 格）——
  // 剔除只发生在渲染产物上，inputMessages 本身不动，占位计数与 hasInput 判定均不受影响。
  const { rows: visibleInputRows, hiddenCount: placeholderCount } = useMemo(() => {
    const { rows, hiddenCount } = classifyTrajectoryWireRows(inputMessages);
    const visible = hidePlaceholders ? rows.filter((row) => !row.placeholder) : rows;
    const { visibleRows } = filterTrajectoryInputRows(
      visible,
      pairedResultToolCallIdsInInput ?? EMPTY_TOOL_CALL_IDS,
    );
    return { rows: visibleRows, hiddenCount };
  }, [inputMessages, hidePlaceholders, pairedResultToolCallIdsInInput]);
  const hiddenCount = hidePlaceholders ? placeholderCount : 0;

  return (
    <section
      data-trajectory-section=""
      className="col-span-full grid grid-cols-subgrid overflow-hidden rounded-lg border border-card-border"
    >
      <TrajectorySectionTitle
        kind="input"
        label={intl.formatMessage({ id: "modelTrajectory.inputSection" })}
      />
      {placeholderCount > 0 ? (
        <WireFilterRow
          hiddenCount={hiddenCount}
          hidePlaceholders={hidePlaceholders}
          onToggle={setHidePlaceholders ? () => setHidePlaceholders(!hidePlaceholders) : undefined}
          intl={intl}
        />
      ) : null}
      {visibleInputRows.map((row) => (
        <Fragment key={`${index}:${row.messageIndex}`}>
          <TrajectoryRowDivider />
          <MessageBlock
            message={row.message}
            callStartedAt={record.startedAt}
            callDurationMs={record.durationMs}
            isAlt={row.messageIndex % 2 === 1}
            expansionKey={
              expansionKeyPrefix
                ? trajectoryInputRowKey(expansionKeyPrefix, row.messageIndex)
                : undefined
            }
            intl={intl}
          />
        </Fragment>
      ))}
    </section>
  );
}

/** B-4 过滤计数行：显示「已隐藏 N 条」，toggle 是行内的轻量按钮。 */
function WireFilterRow({
  hiddenCount,
  hidePlaceholders,
  onToggle,
  intl,
}: {
  hiddenCount: number;
  hidePlaceholders: boolean;
  onToggle?: () => void;
  intl: IntlShape;
}) {
  const toggleLabel = intl.formatMessage({
    id: hidePlaceholders
      ? "modelTrajectory.turn.showPlaceholderRows"
      : "modelTrajectory.turn.hidePlaceholderRows",
  });

  return (
    <div
      data-trajectory-wire-filter-row=""
      data-trajectory-wire-hidden-count={hiddenCount}
      className="col-span-full flex min-w-0 items-center gap-1.5 px-3 py-1 text-ui-xs text-foreground-subtlest"
    >
      {hiddenCount > 0 ? (
        <span>
          {intl.formatMessage(
            { id: "modelTrajectory.turn.hiddenCount" },
            { count: String(hiddenCount) },
          )}
        </span>
      ) : null}
      {onToggle ? (
        <Button
          data-trajectory-wire-filter-toggle=""
          type="button"
          variant="ghost"
          size="xs"
          className="h-4 px-1 text-ui-xs text-foreground-subtle"
          onClick={onToggle}
          title={toggleLabel}
        >
          {toggleLabel}
        </Button>
      ) : null}
    </div>
  );
}

function MessageBlock({
  message,
  callStartedAt,
  callDurationMs,
  isAlt,
  expansionKey,
  intl,
}: {
  message: ZCodeModelTrajectoryMessage;
  callStartedAt: string;
  callDurationMs?: number;
  isAlt: boolean;
  expansionKey?: string;
  intl: IntlShape;
}) {
  // 只有已知角色才有 i18n key，未知角色直接展示原始 role，避免触发缺失 key。
  const knownRole = ["system", "user", "assistant", "tool"].includes(message.role);
  const roleLabel = knownRole
    ? intl.formatMessage({ id: `modelTrajectory.role.${message.role}` })
    : message.role;

  if (
    (message.role === "system" || message.role === "user" || message.role === "tool") &&
    message.parts.length > 0
  ) {
    return (
      <ExpandableTrajectoryMessage
        message={message}
        role={message.role}
        roleLabel={roleLabel}
        callDurationLabel={
          typeof callDurationMs === "number" ? formatTrajectoryDuration(callDurationMs) : "—"
        }
        callDatetimeLabel={formatTrajectoryDateTime(callStartedAt)}
        callDatetimeTitle={callStartedAt}
        isAlt={isAlt}
        expansionKey={expansionKey}
        intl={intl}
      />
    );
  }

  return (
    <div
      data-trajectory-message-role={message.role}
      data-trajectory-search-target-key={expansionKey}
      data-trajectory-row-alt={isAlt || undefined}
      className={cn(
        "col-span-full grid min-h-8 min-w-0 grid-cols-subgrid px-3",
        isAlt && "bg-surface/30",
      )}
    >
      <span
        data-trajectory-role-label={knownRole ? message.role : "unknown"}
        className={cn(
          "pr-1 pt-0.5 font-mono text-ui-sm uppercase",
          knownRole
            ? trajectoryRoleTextClass(
                message.role === "tool"
                  ? "tool-result"
                  : (message.role as "system" | "user" | "assistant"),
              )
            : "text-foreground-subtlest",
        )}
      >
        {roleLabel}
      </span>
      {/* 路径 B（spec N-5）：扁平行内容走 clamp 容器（6 行封顶 + 全屏入口）。
          搜索命中时容器解除 clamp，保证高亮不被裁掉。
          fullContentText 按消息的复制文本口径给出，全屏视图与复制按钮内容一致。 */}
      <TrajectoryClampedPreview
        expansionKey={expansionKey}
        fullContentText={messageClipboardText(message)}
        intl={intl}
      >
        <div data-trajectory-search-field="content" className="flex min-w-0 flex-col gap-1.5">
          {message.parts.length === 0 ? (
            <span className="text-ui-sm text-foreground-subtlest">—</span>
          ) : (
            message.parts.map((part, partIndex) => (
              <ContentPartView key={partIndex} part={part} intl={intl} />
            ))
          )}
        </div>
      </TrajectoryClampedPreview>
    </div>
  );
}

export function TrajectoryRowDivider() {
  return <div data-trajectory-row-divider="" className="col-span-full h-px bg-border/50" />;
}
