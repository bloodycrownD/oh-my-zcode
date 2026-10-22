import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeModelTrajectory } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

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

// 读取失败后的自动重试上限与间隔：换模型 restartingRuntime 窗口期的一次失败
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
 * 自愈（v1.0.19）：换模型 restartingRuntime 窗口期的一次失败会把面板钉死在
 * error/empty 态（taskId 不变则主 effect 永不再跑）。两层兜底：
 * ① 模型切换 stage 回到 idle 时自动 refresh；② 读取失败后短退避自动重试。
 */
export function useModelTrajectory(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
): ModelTrajectoryState & { refresh: () => void } {
  const zcodeTaskService = useZCodeTaskService(workspacePath, undefined, workspaceIdentity);
  const [state, setState] = useState<ModelTrajectoryState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);
  const requestVersionRef = useRef(0);
  const retryCountRef = useRef(0);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // 兜底一：模型切换（含 custom provider 重启运行时）从进行中回到 idle 时刷新一次。
  // 仅订阅单个字符串字段，消息流等 store 高频变更不会惊动本 hook。
  const modelSwitchStage = useZCodeSessionStore((state) =>
    workspacePath
      ? selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).modelSwitchStage
      : "idle",
  );
  const prevModelSwitchStageRef = useRef(modelSwitchStage);
  useEffect(() => {
    const prev = prevModelSwitchStageRef.current;
    prevModelSwitchStageRef.current = modelSwitchStage;
    if (prev && prev !== "idle" && modelSwitchStage === "idle") {
      refresh();
    }
  }, [modelSwitchStage, refresh]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    if (!taskId) {
      requestVersionRef.current += 1;
      retryCountRef.current = 0;
      setState(INITIAL_STATE);
      return () => {
        disposed = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
        }
      };
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    setState({ loading: true, data: null, error: null });

    void zcodeTaskService
      .getModelTrajectory({ taskId })
      .then((data) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        retryCountRef.current = 0;
        setState({ loading: false, data, error: null });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }
        const message = getErrorMessage(error);
        logger.warn("[useModelTrajectory] 读取模型调用轨迹失败", {
          workspacePath,
          taskId,
          workspaceIdentity,
          error: message,
          retry: retryCountRef.current,
        });
        setState({ loading: false, data: null, error: message });
        // 兜底二：失败后短退避自动重试，覆盖重启窗口期的瞬时不可用。
        if (retryCountRef.current < ERROR_RETRY_LIMIT) {
          retryCountRef.current += 1;
          retryTimer = setTimeout(() => {
            if (!disposed && requestVersionRef.current === requestVersion) {
              setReloadToken((token) => token + 1);
            }
          }, ERROR_RETRY_DELAY_MS);
        }
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
