#!/usr/bin/env node
/**
 * CLI-01 回归网：`sed` 只读判定由「危险指令黑名单」改为「完整脚本白名单」。
 *
 * 旧实现只拒绝 `-i/--in-place` 与脚本里形如 `w` 的写命令，于是
 * `sed -n '1e whoami' p`、`sed 's/x/y/e'`、`sed 's/x/y/w /tmp/out'`
 * 都被判为只读，Plan 模式下自动放行执行与写文件。
 *
 * 运行：`npx tsx --test scripts/test-bash-sed-readonly-policy.mjs`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const { sedCommandIsDangerous } = await import(
  new URL("../src/tool/handlers/bash-readonly-policy-callbacks.ts", import.meta.url).href
);
// 端到端探针必须打生产入口：Plan 的自动放行与 guarded 的只读判定都走这条。
const { isBashReadOnlyCommand } = await import(
  new URL("../src/tool/handlers/bash-semantics.ts", import.meta.url).href
);

test("sed 只读白名单：纯打印脚本仍放行", () => {
  assert.equal(sedCommandIsDangerous("sed -n '1,20p' file", ["-n", "1,20p", "file"]), false);
  assert.equal(sedCommandIsDangerous("sed -n 'p' file", ["-n", "p", "file"]), false);
  assert.equal(sedCommandIsDangerous("sed -n '1p'", ["-n", "1p"]), false);
  assert.equal(
    sedCommandIsDangerous("sed 's/a/b/'", ["s/a/b/"]),
    false,
    "无 quiet、无文件参数的替换不写盘",
  );
});

test("sed 只读白名单：脚本执行与写文件一律判危险", () => {
  const dangerous = [
    ["-n", "1e whoami", "p"],
    ["s/x/y/e"],
    ["s/x/y/w", "/tmp/out"],
    ["-i", "s/a/b/", "file"],
    ["s/a/b/", "file"],
    ["-n", "-E", "s/a/b/"],
    ["-e", "s/a/b/", "file"],
    ["--", "-n", "1p"],
  ];
  for (const args of dangerous) {
    assert.equal(
      sedCommandIsDangerous(args.join(" "), args),
      true,
      `应判危险：${JSON.stringify(args)}`,
    );
  }
});

test("sed 只读白名单：选项只接受安全集合", () => {
  assert.equal(sedCommandIsDangerous("sed -l 80 -n p", ["-l", "80", "-n", "p"]), true);
  assert.equal(sedCommandIsDangerous("sed --debug -n p", ["--debug", "-n", "p"]), true);
  assert.equal(sedCommandIsDangerous("sed -u -n p", ["-u", "-n", "p"]), true);
});

/**
 * 真实 sed 可执行文件：优先 PATH；Windows 上 Git for Windows 自带 sed 但通常不在 PATH，
 * 按 `git --exec-path` 反推安装根目录再找（usr/bin 与 bin 两处）。找不到返回 undefined，
 * 由调用方 skip——断言纯判定逻辑的用例不依赖它。
 */
function resolveSedExecutable() {
  const probe = spawnSync("sed", ["--version"], { encoding: "utf8" });
  if (!probe.error) return "sed";

  const gitExecPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (gitExecPath.error || gitExecPath.status !== 0) return undefined;
  const execPath = gitExecPath.stdout.trim();
  if (!execPath) return undefined;

  const roots = new Set([dirname(dirname(execPath)), dirname(dirname(dirname(execPath)))]);
  for (const root of roots) {
    for (const candidate of [
      join(root, "usr", "bin", "sed.exe"),
      join(root, "bin", "sed.exe"),
      join(root, "usr", "bin", "sed"),
      join(root, "bin", "sed"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function runSed(sed, args, cwd, input) {
  const result = spawnSync(sed, args, { cwd, encoding: "utf8", input });
  assert.equal(
    result.error,
    undefined,
    `真实 sed 启动失败：${JSON.stringify(args)} / ${result.error?.message}`,
  );
  assert.equal(result.status, 0, `真实 sed 返回非 0：${JSON.stringify(args)} / ${result.stderr}`);
  return result;
}

// SA-G15：SUMMARY 曾写「17 项，含端到端只读探针」，但脚本里既没有 17 项、也没有端到端探针。
// 这里真在临时目录跑 sed：判定侧打生产入口 isBashReadOnlyCommand，执行侧看真实落盘/执行结果，
// 两边必须一致——只读用法放行且不写盘，写盘/执行用法拦截（并证明它确实会写盘/执行命令）。
test("sed 只读白名单：真实 sed 端到端探针（只读放行 / 写盘与命令执行拦截）", (t) => {
  const sed = resolveSedExecutable();
  if (!sed) {
    t.skip("找不到可执行的 sed（PATH 与 Git for Windows 安装目录均无）");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "zcode-sed-readonly-"));
  const file = "input.txt";
  const content = "a\nb\nc\n";
  try {
    writeFileSync(join(dir, file), content, "utf8");

    // 1) 只读：-n + 范围打印。策略放行，真实 sed 只写 stdout，文件不变。
    const printCommand = `sed -n '1p' ${file}`;
    assert.equal(isBashReadOnlyCommand(printCommand), true, "只读打印必须被放行");
    assert.equal(runSed(sed, ["-n", "1p", file], dir).stdout, "a\n");
    assert.equal(readFileSync(join(dir, file), "utf8"), content, "只读用法不得改写文件");

    // 2) 只读：无文件参数的替换（读 stdin、写 stdout）。策略放行，文件不变。
    const stdinCommand = "sed 's/a/b/'";
    assert.equal(isBashReadOnlyCommand(stdinCommand), true);
    assert.equal(runSed(sed, ["s/a/b/"], dir, content).stdout, "b\nb\nc\n");
    assert.equal(readFileSync(join(dir, file), "utf8"), content);

    // 3) 带文件参数的替换（无 -i）：真实 sed 不改盘，但白名单对「非 -n 脚本 + 文件参数」
    //    仍然要求确认——这是刻意的保守口径（SUMMARY 6.4 / Open question SA-A9），
    //    断言现状是为了改动时能显式看到它。
    assert.equal(isBashReadOnlyCommand(`sed 's/a/b/' ${file}`), false);

    // 4) 危险：-i 原地改写。策略拦截，且真实 sed 确实改写文件（证明拦截有必要）。
    assert.equal(isBashReadOnlyCommand(`sed -i 's/a/b/' ${file}`), false, "-i 必须判危险");
    runSed(sed, ["-i", "s/a/b/", file], dir);
    assert.equal(readFileSync(join(dir, file), "utf8"), "b\nb\nc\n", "-i 会原地改写文件");

    // 5) 危险：s///e 执行替换结果。策略拦截；真实 sed 会把 echo 命令真的跑起来。
    writeFileSync(join(dir, file), content, "utf8");
    assert.equal(
      isBashReadOnlyCommand(`sed 's/.*/echo PWNED/e' ${file}`),
      false,
      "s///e 必须判危险",
    );
    assert.equal(runSed(sed, ["s/.*/echo PWNED/e", file], dir).stdout, "PWNED\nPWNED\nPWNED\n");
    assert.equal(readFileSync(join(dir, file), "utf8"), content, "s///e 不改盘但会执行命令");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
