// Source Server 更新制品的唯一解析入口（backlog-sweep：补上 management.updateSource 的
// resolveRelease 缺口）。上游同文件在 desktop host，本仓按分层落在 services：只依赖
// @zcode/shared 与 Node 标准库，desktop host 注入远程资源目录与网络出口（不改写 settings）。
//
// 与上游的差异：
// - 描述文件名走本仓品牌口径 `omz-server-release.json`（shared SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME）；
// - 失败一律收敛为「未知」：无网络、上游 404、描述文件缺失或校验失败时抛
//   SourceServerReleaseUnavailableError，绝不伪造版本/SHA 让面板误以为有可安装更新。
/* eslint-disable max-lines -- 描述文件解析、缓存校验与下载共用同一条 fail-closed 失败边界。 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ZCODE_VERSION,
  normalizeRemoteAssetInstallMode,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerArtifactPolicy,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";

/**
 * 结构化投影 `@zcode/server` 的 SourceServerProbeResult / ServerReleaseAsset。
 * services 不能反向 import server（server 已依赖 services），这里只保留消费字段。
 */
export interface SourceServerReleaseProbe {
  platform: string;
  arch: string;
  installed: boolean;
  installPath?: string;
  installedVersion?: string;
  installedArchiveSha256?: string;
  daemonStatus?: Record<string, unknown> & { state: string; port?: number };
}

export interface SourceServerReleaseAsset {
  localArchivePath?: string;
  target: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  urls: string[];
}

/** 远程资源目录由 desktop host 提供（与 ConnectRemoteWorkspace / InitLocal 同一份配置）。 */
export interface SourceServerReleaseAssetDirs {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
}

export interface CreateSourceServerReleaseResolverOptions {
  /** 每次解析重新读取：窗口 Host 可能先收到 InitLocal 配置，随后由连接消息刷新。 */
  resolveAssetDirs: () => SourceServerReleaseAssetDirs;
  /** Desktop Host 必须传设置页代理 transport；缺省时退回 global fetch（standalone 语义）。 */
  fetch?: typeof globalThis.fetch;
  /** 底层网络/校验原因只进日志，不塞进用户可见错误，避免面板猜成另一种连接失败。 */
  logWarn?: (message: string, error: Error) => void;
}

export type SourceServerReleaseResolver = (
  probe: SourceServerReleaseProbe,
  target: Exclude<RemoteTarget, { kind: "server" }>,
  options?: { metadataOnly?: boolean },
) => Promise<SourceServerReleaseAsset>;

/**
 * 更新发布信息不可确定时的公开错误码。它不是 PublicZCodeErrorCode（那组码用于连接兼容性
 * 语义），面板按 `settings.source.error.<code>` 直接映射可读文案；连接状态里的 errorCode
 * 仍由 Manager 归一为 remote-connection-unknown，正好表达「未知」。
 */
export const SOURCE_SERVER_RELEASE_UNAVAILABLE_ERROR_CODE =
  "source-server-release-unavailable" as const;

export class SourceServerReleaseUnavailableError extends Error {
  public readonly code = SOURCE_SERVER_RELEASE_UNAVAILABLE_ERROR_CODE;
  /** 网络/上游可能恢复；面板可以提示稍后重试，但不能宣称已有可用更新。 */
  public readonly retryable = true;

  public constructor(
    message = "Source Server update release is unknown because release metadata is unavailable",
  ) {
    super(message);
    this.name = "SourceServerReleaseUnavailableError";
  }
}

interface ResolvedDescriptor {
  descriptor: SourceServerReleaseDescriptor;
  releaseBases: string[];
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== ZCODE_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${ZCODE_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

// 以下 3 个 URL 拼接函数与 @zcode/server/remote/remoteAssetCdn 同构（services 不能反向依赖
// server）；发布路径规则必须与 remote deploy 保持一致，改动时两处一起改。
function resolveRemoteCdnBaseUrls(options: {
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
}): string[] {
  const candidates = [...(options.remoteCdnBaseUrls ?? []), options.remoteCdnBaseUrl ?? ""]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(candidates));
}

function buildReleaseBaseCandidates(remoteCdnBaseUrls: string[], version: string): string[] {
  const candidates = remoteCdnBaseUrls.flatMap((remoteCdnBaseUrl) => {
    const normalizedBase = remoteCdnBaseUrl.replace(/\/+$/, "");
    if (normalizedBase.endsWith(`/${version}`)) return [normalizedBase];
    return [`${normalizedBase}/${version}`, normalizedBase];
  });
  return Array.from(new Set(candidates));
}

function buildReleaseAssetUrlCandidates(
  releaseBaseCandidates: string[],
  fileCandidates: string[],
): string[] {
  const urls: string[] = [];
  for (const fileCandidate of fileCandidates) {
    const normalizedFileCandidate = normalizeRelativePath(fileCandidate);
    for (const releaseBaseCandidate of releaseBaseCandidates) {
      urls.push(joinCdnUrl(releaseBaseCandidate, normalizedFileCandidate));
    }
  }
  return Array.from(new Set(urls));
}

function normalizeRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("[source-server] release asset path is empty");
  if (trimmed.includes("\\")) {
    throw new Error(`[source-server] release asset path must not contain backslash: ${rawPath}`);
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/u.test(trimmed)) {
    throw new Error(`[source-server] release asset path must be relative: ${rawPath}`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`[source-server] release asset path is invalid: ${rawPath}`);
  }
  return posix.normalize(trimmed);
}

function joinCdnUrl(baseUrl: string, relativePath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const encodedRelativePath = relativePath
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
  return `${normalizedBase}/${encodedRelativePath}`;
}

function encodePathSegment(segment: string): string {
  // 兼容已编码输入，避免把 %2B 再编码成 %252B。
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function resolveArchiveUrls(releaseBases: string[], archive: SourceServerReleaseArchive): string[] {
  const absolute = archive.urls.filter((url) => /^https?:\/\//u.test(url));
  const relative = archive.urls.filter((url) => !/^https?:\/\//u.test(url));
  return Array.from(
    new Set([...absolute, ...buildReleaseAssetUrlCandidates(releaseBases, relative)]),
  );
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    // 缓存描述文件不是权威来源；先移除旧文件再 rename，Windows 上不会因目标存在而失败。
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

async function resolveRemoteDescriptor(
  assetDirs: SourceServerReleaseAssetDirs,
  cacheRoot: string | null,
  fetchImpl: typeof globalThis.fetch,
): Promise<ResolvedDescriptor> {
  const releaseBases = buildReleaseBaseCandidates(
    resolveRemoteCdnBaseUrls(assetDirs),
    ZCODE_VERSION,
  );
  const descriptorUrls = buildReleaseAssetUrlCandidates(releaseBases, [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ]);
  const cachedDescriptorPath = cacheRoot
    ? join(cacheRoot, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)
    : null;
  let lastError: unknown;
  for (const url of descriptorUrls) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text);
      if (cachedDescriptorPath) await writeTextAtomic(cachedDescriptorPath, text);
      return { descriptor, releaseBases };
    } catch (error) {
      lastError = error;
    }
  }
  if (cachedDescriptorPath && (await pathExists(cachedDescriptorPath))) {
    // 上游不可达时只复用上一份通过版本校验的 descriptor；archive 仍要按 SHA/size 校验。
    return {
      descriptor: readDescriptor(await readFile(cachedDescriptorPath, "utf8")),
      releaseBases,
    };
  }
  throw new Error("Unable to resolve Source Server release descriptor", { cause: lastError });
}

async function downloadArchive(
  archive: SourceServerReleaseArchive,
  urls: string[],
  cacheRoot: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, archive.fileName);
  if (await verifyArchive(cached, archive)) return cached;
  await rm(cached, { force: true });
  let lastError: unknown;
  for (const url of urls) {
    const temporary = `${cached}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(temporary, { mode: 0o600 }),
      );
      if (!(await verifyArchive(temporary, archive))) {
        throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
      }
      await rename(temporary, cached);
      return cached;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
    cause: lastError,
  });
}

async function resolveReleaseAsset(
  probe: SourceServerReleaseProbe,
  assetDirs: SourceServerReleaseAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
  fetchImpl: typeof globalThis.fetch,
  options: { metadataOnly?: boolean },
): Promise<SourceServerReleaseAsset> {
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    throw new Error(`Unsupported Source Server release target: ${probe.platform}-${probe.arch}`);
  }
  const target = `${probe.platform}-${probe.arch}`;
  const installMode =
    remoteTarget.kind === "ssh"
      ? normalizeRemoteAssetInstallMode(remoteTarget.assetInstallMode)
      : "local-download-upload";
  const cacheRoot = assetDirs.remoteCacheDir?.trim()
    ? join(assetDirs.remoteCacheDir, "source-server", ZCODE_VERSION)
    : null;

  if (
    remoteTarget.kind === "ssh" &&
    assetDirs.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!assetDirs.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(assetDirs.mockCdnDir, "releases", ZCODE_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // 开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: ZCODE_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  if (installMode === "local-download-upload" && assetDirs.mockCdnDir) {
    // 开发态只信任本轮 staging 写入 mock-cdn 且通过 descriptor SHA/size 校验的本地产物。
    const local = await resolveLocalDescriptor(
      join(assetDirs.mockCdnDir, "releases", ZCODE_VERSION),
      target,
    );
    if (local) {
      return {
        localArchivePath: local.archivePath,
        target,
        version: ZCODE_VERSION,
        sha256: local.archive.sha256,
        sizeBytes: local.archive.sizeBytes,
        urls: local.archive.urls,
      };
    }
  }

  const resolvedDescriptor = await resolveRemoteDescriptor(assetDirs, cacheRoot, fetchImpl);
  const archive = findArchive(resolvedDescriptor.descriptor, target);
  const urls = resolveArchiveUrls(resolvedDescriptor.releaseBases, archive);
  if (installMode === "remote-download" || options.metadataOnly) {
    return {
      target,
      version: ZCODE_VERSION,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      urls,
    };
  }
  if (!cacheRoot) {
    throw new Error(`Source Server release cache is unavailable: ${archive.fileName}`);
  }
  return {
    localArchivePath: await downloadArchive(archive, urls, cacheRoot, fetchImpl),
    target,
    version: ZCODE_VERSION,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls,
  };
}

/**
 * 创建 Host 侧 release resolver。
 *
 * 失败语义（需求硬约束）：所有底层失败（无网络、上游不可达、描述文件缺失/损坏）都收敛为
 * `SourceServerReleaseUnavailableError` —— 面板显示「无法确定更新」，Manager 状态归一为
 * unknown。绝不返回带猜测版本/SHA 的 release，避免把「查不到」伪装成「有更新」。
 */
export function createSourceServerReleaseResolver(
  options: CreateSourceServerReleaseResolverOptions,
): SourceServerReleaseResolver {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (probe, target, resolutionOptions = {}) => {
    try {
      return await resolveReleaseAsset(
        probe,
        options.resolveAssetDirs(),
        target,
        fetchImpl,
        resolutionOptions,
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      options.logWarn?.("[source-server] release resolution failed", failure);
      if (error instanceof SourceServerReleaseUnavailableError) throw error;
      throw new SourceServerReleaseUnavailableError();
    }
  };
}
