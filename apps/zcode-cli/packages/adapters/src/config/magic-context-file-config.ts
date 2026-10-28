/**
 * FORK（S23 / D-12）：`magicContext` 参数域写盘的独立模块。
 *
 * 为什么单独成文件：`file-config.adapter.ts` 是上游 ZCode 的配置文件适配器，跟随上游
 * 升级时改动概率高；而 `magicContext` 这套写盘语义是本 fork 独有的（纯新增），夹在
 * 上游文件里只会扩大冲突面。
 *
 * 依赖方向固定为「adapter → 本模块」单向：本模块**不** import `file-config.adapter.ts`，
 * 写盘需要的 IO 能力（路径展开、读 JSON、原子写、记录判据）由调用方以端口注入。
 * 反向 import 会让 adapter 转出 `MagicContextPatchResult` 时成环
 * （architecture-policy.yaml 的 forbidCycles）。
 *
 * 行为不变量（与原实现逐点一致）：
 *   1. **整域替换**而非单字段合并——调用方（`workspace/updateMagicContextConfig`
 *      handler）必须先过 `MagicContextConfigSchema`，schema 的 `.default()` 保证传进来
 *      的是完整域，整域替换因此无损；在写盘层再实现一次 merge，就是把包内 schema
 *      的语义复制成第二份，漂移方向不可接受。
 *   2. **幂等短路**：内容相同就不写盘（键序无关深比较）。参数域写盘发生在每次 UI
 *      保存上，重写一个字节没变的文件只会无谓地更新 mtime——而某些同步工具按 mtime
 *      触发扫描。
 *   3. 只写 `magicContext` 顶层键，其余顶层键原样保留，不做项目级/环境级联写入；
 *      写盘走调用方注入的 `atomicWriteJson`（临时文件 + rename，避免半截文件被下一次
 *      `loadFileConfig` 读成非法 JSON）。
 *
 * 未知键的 strip 不在这里：它发生在调用方的 `MagicContextConfigSchema.safeParse`
 * （`z.object` 校验时丢弃白名单外的键），写盘层拿到的是已 strip 的完整域。
 *
 * 签名保持 `config: unknown`：写盘层只搬运 JSON 值，不耦合 `@zcode/magic-context`
 * 的 schema 类型。
 */

/**
 * FORK（S23 / D-12）：`magicContext` 参数域写盘的结果。
 *
 * 只回报「写到了哪里」——域值由**协议层**统一回显（`workspace/updateMagicContextConfig`
 * 的 result 带 `config` 字段，取自写盘之后的 `ConfigPort`），写盘层再回显一份就成了
 * 第二份出口：两份出口迟早会分叉，而分叉的那份没人测。这里刻意只给 `path` + `changed`，
 * 调用方要的「写成功 + 后续从 ConfigPort 读到的就是这个值」这条保证由协议层兑现。
 */
export interface MagicContextPatchResult {
  path: string;
  /** 是否真的改动了文件内容（幂等重写返回 false）。 */
  changed: boolean;
}

/**
 * 写盘所需的 IO 端口。
 *
 * 由 `file-config.adapter.ts` 注入其既有私有件，本模块不自带实现——复制一份会让
 * 「原子写」「缺文件读成空对象」这些语义出现两个所有者。
 */
export interface MagicContextFileConfigPorts {
  atomicWriteJson: (filePath: string, value: Record<string, unknown>) => Promise<void>;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  readJsonConfigFileOrEmpty: (filePath: string) => Promise<Record<string, unknown>>;
  resolvePath: (path: string) => string;
}

/**
 * FORK（S23 / D-12）：把整个 `magicContext` 参数域写进用户级 config.json 顶层。
 */
export async function writeMagicContextToConfigFile(
  filePath: string,
  config: unknown,
  io: MagicContextFileConfigPorts,
): Promise<MagicContextPatchResult> {
  const resolvedPath = io.resolvePath(filePath);
  const parsed = await io.readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchMagicContext(parsed, config);
  const changed = !isDeepEqualJson(parsed.magicContext, next.magicContext, io.isRecord);

  if (changed) {
    await io.atomicWriteJson(resolvedPath, next);
  }
  return {
    path: resolvedPath,
    changed,
  };
}

function patchMagicContext(
  parsed: Record<string, unknown>,
  config: unknown,
): Record<string, unknown> {
  return {
    ...parsed,
    magicContext: config,
  };
}

/** 键序无关的 JSON 深比较（配置域都是纯 JSON 值）。 */
function isDeepEqualJson(
  left: unknown,
  right: unknown,
  isRecord: (value: unknown) => value is Record<string, unknown>,
): boolean {
  if (left === right) return true;
  if (!isRecord(left) || !isRecord(right)) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) => rightKeys[index] === key && isDeepEqualJson(left[key], right[key], isRecord),
  );
}
