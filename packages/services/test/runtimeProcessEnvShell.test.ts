import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  initializeRuntimeProcessEnv,
  normalizeRuntimeProcessEnv,
} from "../src/runtime-tools/runtimeCommandEnv.ts";

// FORK (upstream-v3.15.1-backport) T-WIN-1（含 cr 携带项 C2）：spec §2.1 P5 #29——Windows 下
// git-bash / WSL 注入的 `SHELL=/usr/bin/bash` 必须归一成 ComSpec/cmd.exe。
//
// 失效形态：Windows 上没有 MSYS 虚拟路径 /usr/bin/bash（会被解析成 <当前盘符>:\usr\bin\bash），
// agent runtime 及其**stdio MCP 子进程**读到这个 SHELL 后全部启动失败。
//
// 断言口径（C2 明确指定，勿改）：**不断言 `buildRuntimeProcessEnvPatch` 的输出**——patch 里不含
// SHELL（SHELL 不是需要下发的 runtime 工具环境变量）。要断言的是两处：
//   1) `normalizeRuntimeProcessEnv(env, "win32")` 的返回值；
//   2) `initializeRuntimeProcessEnv` 对真实 `process.env` 的**写回**（Host 只返回环境副本，
//      不写回的话子进程仍会继承 git-bash 注入的 SHELL）。

test("T-WIN-1 normalizeRuntimeProcessEnv：无效 POSIX SHELL 回退 ComSpec / cmd.exe", () => {
  // 无 ComSpec 时回退字面量 cmd.exe。
  const withoutComSpec = normalizeRuntimeProcessEnv({ SHELL: "/usr/bin/bash" }, "win32");
  // POSIX 主机上 /usr/bin/bash 可能真实存在（此时函数按「可解析」保持原值）——同一个判据的
  // 两侧都钉住，避免跨平台假红。
  assert.equal(withoutComSpec.SHELL, existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "cmd.exe");

  // 用一个保证不存在的 POSIX 路径：判据确定性（不依赖宿主是否装了 bash）。
  assert.equal(
    normalizeRuntimeProcessEnv({ SHELL: "/usr/bin/bash-not-installed-here" }, "win32").SHELL,
    "cmd.exe",
  );

  // ComSpec 在场时优先用系统 cmd 的真实路径。
  const withComSpec = normalizeRuntimeProcessEnv(
    { ComSpec: "C:\\Windows\\system32\\cmd.exe", SHELL: "/bin/bash" },
    "win32",
  );
  assert.equal(withComSpec.SHELL, "C:\\Windows\\system32\\cmd.exe");

  // 大小写混写的 SHELL 也归一成唯一的大写键（与 PATH 同规）。
  const mixedCase = normalizeRuntimeProcessEnv(
    { Shell: "/bin/sh", SHELL: "/usr/bin/bash" },
    "win32",
  );
  assert.deepEqual(
    Object.keys(mixedCase).filter((key) => key.toUpperCase() === "SHELL"),
    ["SHELL"],
  );
});

test("T-WIN-1 真实 Windows 路径与其它平台不受影响", () => {
  // 用户自配的真实路径（含 git-bash 的 bash.exe 绝对路径）保持原值。
  const realPath = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(normalizeRuntimeProcessEnv({ SHELL: realPath }, "win32").SHELL, realPath);
  // 非 POSIX 绝对路径（相对名 / 裸命令名）同样不动。
  assert.equal(normalizeRuntimeProcessEnv({ SHELL: "bash" }, "win32").SHELL, "bash");
  // 非 win32 平台整体直通（POSIX 上 /usr/bin/bash 是合法 shell）。
  assert.equal(
    normalizeRuntimeProcessEnv({ SHELL: "/usr/bin/bash" }, "linux").SHELL,
    "/usr/bin/bash",
  );
  // 没有 SHELL 时不凭空造一个键。
  assert.equal("SHELL" in normalizeRuntimeProcessEnv({ PATH: "C:\\A" }, "win32"), false);
});

test("T-WIN-1 initializeRuntimeProcessEnv 把归一结果写回真实 process.env（Windows 专属）", (t) => {
  if (process.platform !== "win32") {
    t.skip("SHELL 写回是 win32 专属分支（见 initializeRuntimeProcessEnv），POSIX 主机不适用");
    return;
  }
  const envSnapshot = { ...process.env };
  try {
    // git-bash / WSL 启动 Host 的形态。
    process.env.SHELL = "/usr/bin/bash";
    // 传空 patch 跳过登录 shell 快照采集（本用例只钉 SHELL 写回这一维；采集会 spawn 一个 shell）。
    initializeRuntimeProcessEnv({});

    assert.equal(
      process.env.SHELL,
      process.env.ComSpec?.trim() || "cmd.exe",
      "写回后子进程读到的 SHELL 必须是可解析的 Windows shell",
    );
    // 唯一键：不能同时留着小写/混写的旧键（Windows 子进程只认其中一项）。
    assert.deepEqual(
      Object.keys(process.env).filter((key) => key.toUpperCase() === "SHELL"),
      ["SHELL"],
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});
