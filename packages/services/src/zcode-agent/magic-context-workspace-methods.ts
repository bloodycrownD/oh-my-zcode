import type { ZodType } from "zod";
import {
  resolveWorkspaceKey,
  zcodeProtocolMethods,
  zcodeWorkspaceArchiveMagicContextMemoriesResultSchema,
  zcodeWorkspaceListMagicContextMemoriesResultSchema,
  zcodeWorkspaceReadMagicContextConfigResultSchema,
  zcodeWorkspaceUpdateMagicContextConfigResultSchema,
} from "@zcode/shared";
import type {
  ZCodeAgentArchiveMagicContextMemoriesParams,
  ZCodeAgentListMagicContextMemoriesParams,
  ZCodeAgentUpdateMagicContextConfigParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { isProtocolMethodNotFoundError } from "./protocol-method-not-found.js";
import { buildWorkspaceRef } from "./workspace-ref.js";

/**
 * magic-context 的四个 workspace RPC 客户端方法。
 *
 * 为什么不写在 `zcodeAgentService.ts` 里：那是上游 ZCode 的 agent service，
 * 跟随上游升级时改动概率高；这四个方法是本 fork 自有的设置面板管理面，塞在
 * 里面既让上游文件变成冲突面（约 190 行），也让「MC 接触点」在审查时不可枚举。
 * 抽出来后主文件只留一行展开。
 *
 * 依赖只有 `getReadOnlyClient`：它是 `createZCodeAgentService` 内部的闭包
 * （要读 activeClientsByWorkspaceKey 与 processManager），无法搬出，因此注入。
 * `logger` 用同名的 service logger 重建——日志标签与原来逐字一致。
 */

const logger = createServiceLogger("zcode-agent-service");

// FORK（magic-context-memory-management / D2 · Step 5）：SQLITE_BUSY 是面板读/废弃与
// CLI 写通道竞争的短暂冲突（archive 本身是幂等 UPDATE，重试即恢复）。CLI 侧可能抛
// `SqliteAcquisitionBusyError`（message "SQLite writer acquisition remained busy"、
// 自有 code "SQLITE_BUSY"，magic-context `core/shared/sqlite.ts`）或原生
// better-sqlite3 的 "database is locked"；过线后协议信封只剩 numeric code + message，
// 因此在 services 出口按 message 识别并转译为可重试提示——否则 UI toast 直显英文
// 驱动原文，用户不知道「重试」是正确动作。
const SQLITE_BUSY_MESSAGE_PATTERN =
  /SQLITE_BUSY|database is locked|writer acquisition remained busy/i;

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return SQLITE_BUSY_MESSAGE_PATTERN.test(message);
}

/** 把 SQLITE_BUSY 转成可重试提示；其余错误原样返回（保持调用方既有 catch 语义）。 */
function toRetryableMagicContextError(error: unknown, action: string): unknown {
  if (!isSqliteBusyError(error)) return error;
  return new Error(`${action}失败：记忆库正忙（有其他写入进行中），请稍后重试。`, {
    cause: error,
  });
}

/**
 * 这四个方法用到的 client 形状。方法语法（而非属性语法）让参数保持双变，
 * 与真实 client 的 `request` 签名天然兼容。
 */
export interface MagicContextRequestClient {
  request<TResult>(
    method: string,
    params: Record<string, unknown>,
    schema: ZodType<TResult>,
  ): Promise<TResult>;
}

export interface MagicContextWorkspaceMethodDeps<TClient extends MagicContextRequestClient> {
  getReadOnlyClient: (params: ZCodeAgentWorkspaceTarget) => Promise<TClient>;
}

export function createMagicContextWorkspaceMethods<TClient extends MagicContextRequestClient>(
  deps: MagicContextWorkspaceMethodDeps<TClient>,
) {
  const { getReadOnlyClient } = deps;

  return {
    // FORK（S23 / D-12）：magic-context 参数域写盘 + 内存双写。
    // 走 read-only 控制面（与 `grantWorkspaceHookTrust` 同一条）：设置页在
    // provider/model 未就绪时也必须可写；而 read-only lane 在已有活动 runtime 时
    // 复用同一个 client（`getOrStartReadOnlyClient` 先查 activeClientsByWorkspaceKey），
    // 所以 CLI 侧的 `context.sessions` 与它们的 ConfigPort 就在这条连接上，热生效
    // 不会因为换了一条 lane 而落空。校验失败由 CLI 以 -32602 结构化返回，这里原样上抛。
    async updateMagicContextConfig(params: ZCodeAgentUpdateMagicContextConfigParams) {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/updateMagicContextConfig", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getReadOnlyClient(params);
        const result = await client.request(
          zcodeProtocolMethods.workspaceUpdateMagicContextConfig,
          {
            workspace: buildWorkspaceRef(params),
            config: params.config,
          },
          zcodeWorkspaceUpdateMagicContextConfigResultSchema,
        );
        logger.info(undefined, "ZCode Protocol workspace/updateMagicContextConfig 完成", {
          changed: result.changed,
          durationMs: Date.now() - startedAt,
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol workspace/updateMagicContextConfig 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    // FORK（Step 29 / D-12）：读回 effective 域，供设置分区渲染表单初值。
    // 与 update 走同一条 read-only 控制面：设置页在 provider/model 未就绪时也
    // 必须可读，且这条 lane 在已有活动 runtime 时复用同一个 client，因此读到
    // 的就是那些 session 正在用的 ConfigPort 值。
    async readMagicContextConfig(params: ZCodeAgentWorkspaceTarget) {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/readMagicContextConfig", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getReadOnlyClient(params);
        const result = await client.request(
          zcodeProtocolMethods.workspaceReadMagicContextConfig,
          { workspace: buildWorkspaceRef(params) },
          zcodeWorkspaceReadMagicContextConfigResultSchema,
        );
        logger.info(undefined, "ZCode Protocol workspace/readMagicContextConfig 完成", {
          durationMs: Date.now() - startedAt,
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol workspace/readMagicContextConfig 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    // FORK（magic-context-memory-management / D2 · Step 5）：列取当前项目的
    // magic-context 记忆（设置页「记忆」分区管理面板数据源）。走与
    // readMagicContextConfig 同一条 read-only 控制面：provider/model 未就绪时
    // 面板也必须可读。CLI 侧 effective 门/库不可达会结构化回 available:false
    // （不建库不落盘），services 原样透传；旧 CLI（-32601）按 D6 降级成
    // supported:false 零值信封（readPromptLanguage 口径）。
    async listMagicContextMemories(params: ZCodeAgentListMagicContextMemoriesParams) {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/listMagicContextMemories", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getReadOnlyClient(params);
        const result = await client.request(
          zcodeProtocolMethods.workspaceListMagicContextMemories,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.category === undefined ? {} : { category: params.category }),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(params.offset === undefined ? {} : { offset: params.offset }),
          },
          zcodeWorkspaceListMagicContextMemoriesResultSchema,
        );
        logger.info(undefined, "ZCode Protocol workspace/listMagicContextMemories 完成", {
          entryCount: result.entries.length,
          supported: result.supported,
          available: result.available,
          truncated: result.truncated,
          durationMs: Date.now() - startedAt,
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        if (isProtocolMethodNotFoundError(error)) {
          logger.info(undefined, "旧 Agent 不支持 magic-context 记忆列表，按不支持降级", {
            workspaceKey,
            workspacePath: params.workspacePath,
          });
          // 过一遍同一 schema，保证降级信封与线上信封同形（supported:false 是
          // UI 占位态的判据；reason 与 available:false 的 disabled/unavailable
          // 区分开，说明「方法不存在」而非「功能被关」）。
          return zcodeWorkspaceListMagicContextMemoriesResultSchema.parse({
            workspace: buildWorkspaceRef(params),
            supported: false,
            available: false,
            reason: "unsupported",
            entries: [],
            counts: { total: 0, active: 0, permanent: 0, archived: 0, merged: 0 },
            truncated: false,
            total: 0,
          });
        }
        logger.warn(undefined, "ZCode Protocol workspace/listMagicContextMemories 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        throw toRetryableMagicContextError(error, "读取记忆列表");
      }
    },

    // FORK（magic-context-memory-management / D2 · Step 5）：批量废弃（archive 软删）
    // 项目记忆。CLI 侧与对话内 `ctx_memory action:"archive"` 共享同一组合函数
    // （单事务成对写 archive + mutation 行），services 只转发；逐 id outcome 原样
    // 回给 UI 组 toast。旧 CLI（-32601）按 D6 抛可读错误（readMagicContextConfig
    // 口径），UI 消费 message 即可——桌面与 CLI 同包发布，该窗口极短。
    async archiveMagicContextMemories(params: ZCodeAgentArchiveMagicContextMemoriesParams) {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/archiveMagicContextMemories", {
        memoryIdCount: params.memoryIds.length,
        hasReason: params.reason !== undefined,
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getReadOnlyClient(params);
        const result = await client.request(
          zcodeProtocolMethods.workspaceArchiveMagicContextMemories,
          {
            workspace: buildWorkspaceRef(params),
            memoryIds: params.memoryIds,
            ...(params.reason === undefined ? {} : { reason: params.reason }),
          },
          zcodeWorkspaceArchiveMagicContextMemoriesResultSchema,
        );
        logger.info(undefined, "ZCode Protocol workspace/archiveMagicContextMemories 完成", {
          archivedCount: result.outcomes.filter((item) => item.outcome === "archived").length,
          outcomeCount: result.outcomes.length,
          durationMs: Date.now() - startedAt,
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        if (isProtocolMethodNotFoundError(error)) {
          logger.info(undefined, "旧 Agent 不支持 magic-context 记忆废弃", {
            workspaceKey,
            workspacePath: params.workspacePath,
          });
          throw new Error("当前 CLI 版本不支持废弃项目记忆，升级 CLI 后重试");
        }
        logger.warn(undefined, "ZCode Protocol workspace/archiveMagicContextMemories 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        throw toRetryableMagicContextError(error, "废弃项目记忆");
      }
    },
  };
}
