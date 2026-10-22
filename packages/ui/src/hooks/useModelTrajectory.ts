import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeModelTrajectory } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { decideTrajectoryRetry } from "@/ModelTrajectoryRetry.js";

interface ModelTrajectoryState {
  loading: boolean;
  data: ZCodeModelTrajectory | null;
  error: string | null;
}

const INITIAL_STATE: ModelTrajectoryState = {
  loading: false,
  data: null,
  error: null,
};

// 读取失败/空读后的自动重试上限与间隔：换模型 restartingRuntime 窗口期的一次失败
// 不应把面板永久钉死在 error/空态（数据在文件里，进程恢复后即可读回）。
const ERROR_RETRY_LIMIT = 3;
const ERROR_RETRY_DELAY_MS = 5_000;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error);
}

/**
 * 读取某个 task/session 的模型调用轨迹（model-io）。
 *
 * 路径解析与文件读取都收口在 zcodeTaskService.getModelTrajectory（host 侧），
 * 桌面读本机、手机远控读远端 host，UI 只消费结构化结果。
 *
 * 自愈（v1.0.19）：恢复路径共三条，缺一不可——
 * ① empty/error 双路径退避重试：读取「目录不存在 / 文件读失败 / sessionId 不匹配」会返回
 *    空记录而非抛错，空读与失败同等对待，共用同一份有界预算（3 次 × 5s）；
 *    预算未耗尽时保持 loading、不落终态（避免先闪错误再转圈），耗尽后才落 empty/error 终态。
 * ② onAgentRuntimeRestarted → refresh：runtime 重启（custom provider 恢复、会话重建）后
 *    代际切换，旧读取窗口失效，此时立即重读。
 * ③ 手动刷新：refresh 重置重试预算，让用户能立刻重开一轮有界退避。
 *
 * 常规换模型（不重启 runtime）不触发 ②，其读取窗口由 ① 的有界退避覆盖，
 * 窗口之外可用 ③ 手动恢复。
 */
export function useModelTrajectory(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
): ModelTrajectoryState & { refresh: () => void } {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  // ② 的订阅必须打到 workspace 作用域的服务：裸 useServices() 在远端断连代理下
  // 返回空订阅，事件会静默失效（与 useZCodeTaskService 同源解析）。
  const zcodeAgentService = useWorkspaceServices(workspacePath, undefined, workspaceIdentity)
    .zcodeAgentService;
  const [state, setState] = useState<ModelTrajectoryState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);
  const requestVersionRef = useRef(0);
  const retryCountRef = useRef(0);
  const lastTaskIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    // ③ 手动刷新（以及 ② runtime 重启）都从零预算重开一轮有界退避；
    // 自动重试路径禁止走这里——refresh 会重置预算，空读/失败将永无止境。
    retryCountRef.current = 0;
    setReloadToken((token) => token + 1);
  }, []);

  // ② 运行时换代信号：runtime 重启后旧读取窗口失效，立即重读一次。
  // 事件按 workspaceKey 过滤，只响应本 workspace 的重启。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  useEffect(() => {
    if (!workspacePath) {
      return;
    }
    const subscription = zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) {
        return;
      }
      refresh();
    });
    return () => subscription.dispose();
  }, [refresh, workspaceKey, workspacePath, zcodeAgentService]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    if (!taskId) {
      requestVersionRef.current += 1;
      retryCountRef.current = 0;
      lastTaskIdRef.current = null;
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
        }
      };
    }

    // 切换 task 是新的读取对象：上一 task 耗尽的重试预算不得牵连新 task。
    // 同一 task 内的退避重试（reloadToken 变化）必须保留预算，故只按 taskId 变化重置。
    if (lastTaskIdRef.current !== taskId) {
      lastTaskIdRef.current = taskId;
      retryCountRef.current = 0;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setState({ loading: true, data: null, error: null });

    // ① 的自动重试一律经 setReloadToken 触发，禁止经 refresh()（refresh 会重置预算）。
    const scheduleRetry = () => {
      retryTimer = setTimeout(() => {
        if (!disposed && requestVersionRef.current === requestVersion) {
          setReloadToken((token) => token + 1);
        }
      }, ERROR_RETRY_DELAY_MS);
    };

    void zcodeTaskService
      .getModelTrajectory({ taskId })
      .then((data) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        // 空读（records 为空）与失败同等对待：换模型后的读取窗口就是这样表现的。
        const decision = decideTrajectoryRetry({
          kind: data.records.length > 0 ? "success" : "empty",
          retryCount: retryCountRef.current,
          limit: ERROR_RETRY_LIMIT,
        });
        if (decision.resetBudget) {
          retryCountRef.current = 0;
        }
        if (decision.retry) {
          logger.warn("[useModelTrajectory] 模型调用轨迹为空，退避重试", {
            workspacePath,
            taskId,
            workspaceIdentity,
            retry: retryCountRef.current + 1,
          });
          retryCountRef.current += 1;
          scheduleRetry();
          return;
        }
        if (decision.terminal) {
          // 预算耗尽：落 empty 终态（数据可读但没有记录）。
          setState({ loading: false, data, error: null });
          return;
        }
        setState({ loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        const message = getErrorMessage(error);
        const decision = decideTrajectoryRetry({
          kind: "error",
          retryCount: retryCountRef.current,
          limit: ERROR_RETRY_LIMIT,
        });
        logger.warn("[useModelTrajectory] 读取模型调用轨迹失败", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
          retry: retryCountRef.current,
          terminal: decision.terminal,
        });
        if (decision.retry) {
          // 预算未耗尽：保持 loading，不落 error 终态（避免先闪红色报错再转圈）。
          retryCountRef.current += 1;
          scheduleRetry();
          return;
        }
        setState({ loading: false, data: null, error: message });
      });

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [zcodeTaskService, taskId, workspaceIdentity, workspacePath, reloadToken]);

  return { ...state, refresh };
}
