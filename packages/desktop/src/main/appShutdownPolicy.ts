interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
};

const WINDOWS_SHUTDOWN_POLICY: AppShutdownPolicy = {
  // 普通退出给 Host 内部 3.5 秒进程树兜底留出执行时间。
  forceKillDelayMs: 4_000,
  waitTimeoutMs: 4_500,
};

export function resolveAppShutdownPolicy(platform: NodeJS.Platform): AppShutdownPolicy {
  if (platform === "win32") {
    return WINDOWS_SHUTDOWN_POLICY;
  }
  return STRICT_SHUTDOWN_POLICY;
}