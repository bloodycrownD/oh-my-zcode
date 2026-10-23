/**
 * T-UF6（backlog-sweep Step 17）：fileApplications 选择器纯逻辑 + 归并/接线形状。
 *
 * 形态：desktop 纯逻辑测试（node --test + node:assert），`fileApplications.ts` 只依赖 node 内建，
 * 不 import electron，可直接加载。真机 GUI 拉起归 T-QA6（manual_user），这里只锁选择器语义：
 * ①应用列表归并——按平台登记表、id 唯一、IDE 基座与文件应用分开（文件应用不进工作区编辑器列表）；
 * ②首选判定——同一扩展名按登记顺序取首个（find 语义），appPath 先于 appPathCandidates；
 * ③路径匹配——扩展名大小写/反斜杠/无扩展名/点文件边界。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
  type FileApplicationDef,
} from "../src/main/fileApplications.js";

const desktopSrc = (relative: string) =>
  fileURLToPath(new URL(`../src/${relative}`, import.meta.url));

test("T-UF6 平台登记表：三平台各自成表、id 唯一、未知平台为空", () => {
  const darwin = getFileApplicationDefs("darwin");
  const win32 = getFileApplicationDefs("win32");
  const linux = getFileApplicationDefs("linux");

  for (const [platform, defs] of [
    ["darwin", darwin],
    ["win32", win32],
    ["linux", linux],
  ] as const) {
    assert.ok(defs.length > 0, `${platform} 必须有文件应用登记`);
    assert.equal(
      new Set(defs.map((def) => def.id)).size,
      defs.length,
      `${platform} 文件应用 id 不得重复`,
    );
  }

  assert.deepEqual(getFileApplicationDefs("aix"), [], "未知平台必须返回空表");
  // 三平台的 PDF 入口都至少在册一个（否则「打开方式」对 PDF 完全无候选）。
  for (const defs of [darwin, win32, linux]) {
    assert.ok(
      defs.some((def) => def.fileExtensions.includes("pdf")),
      "每个平台至少要有一个 PDF 应用",
    );
  }
  // Windows 的 WPS 走版本目录枚举；Linux 拆成三个形状应用。
  assert.ok(win32.find((def) => def.id === "wps")?.windowsVersionRoots?.length);
  assert.ok(linux.some((def) => def.id === "wps-presentation"));
  assert.ok(linux.some((def) => def.id === "wps-spreadsheets"));
});

test("T-UF6 路径匹配：扩展名大小写/反斜杠/无扩展名边界", () => {
  const pdfApp = getFileApplicationDefs("darwin").find((def) => def.id === "preview")!;
  assert.equal(matchesFileApplication(pdfApp, "/tmp/report.pdf"), true);
  assert.equal(matchesFileApplication(pdfApp, "/tmp/REPORT.PDF"), true, "扩展名比较必须小写化");
  assert.equal(
    matchesFileApplication(pdfApp, "C:\\Users\\a\\report.Pdf"),
    true,
    "反斜杠路径同样可匹配",
  );
  assert.equal(matchesFileApplication(pdfApp, "/tmp/report.docx"), false);
  assert.equal(matchesFileApplication(pdfApp, "/tmp/report"), false, "无扩展名不得命中");
  // extname 语义：前导点属于文件名本身，`.pdf` 这样的点文件没有扩展名。
  assert.equal(matchesFileApplication(pdfApp, "/tmp/.pdf"), false, "点文件不算 pdf");
  assert.equal(matchesFileApplication(pdfApp, "/tmp/archive.pdf.bak"), false);
  assert.equal(matchesFileApplication(pdfApp, undefined), false, "无路径（工作区列表）不得命中");
  assert.equal(matchesFileApplication(pdfApp, ""), false);
});

test("T-UF6 首选判定：同一扩展名按登记顺序取首个", () => {
  const firstFor = (platform: NodeJS.Platform, filePath: string) =>
    getFileApplicationDefs(platform).find((def) => matchesFileApplication(def, filePath))?.id;
  const firstForExtension = (platform: NodeJS.Platform, extension: string) =>
    getFileApplicationDefs(platform).find((def) => def.fileExtensions.includes(extension))?.id;

  // Windows：PDF 首选 Acrobat（登记表第一项），Office 各自首选 MS 系。
  assert.equal(firstFor("win32", "C:\\a\\b.pdf"), "adobe-acrobat");
  assert.equal(firstFor("win32", "C:\\a\\b.docx"), "word");
  assert.equal(firstFor("win32", "C:\\a\\b.pptx"), "powerpoint");
  assert.equal(firstFor("win32", "C:\\a\\b.xlsx"), "excel");
  assert.equal(firstFor("win32", "C:\\a\\b.mp4"), "windows-media-player");
  // macOS：PDF 首选系统 Preview。
  assert.equal(firstFor("darwin", "/a/b.pdf"), "preview");
  assert.equal(firstFor("darwin", "/a/b.docx"), "word");
  // Linux：PDF 首选 evince，PPTX 首选 WPS Presentation（不是通用的 wps）。
  assert.equal(firstFor("linux", "/a/b.pdf"), "evince");
  assert.equal(firstForExtension("linux", "pptx"), "wps-presentation");
});

test("T-UF6 路径候选：appPath 是首选，appPathCandidates 依次兜底", () => {
  const darwinWord = getFileApplicationDefs("darwin").find((def) => def.id === "word")!;
  assert.equal(
    darwinWord.appPath,
    "/Applications/Microsoft Word.app",
    "bundle 相对路径要补成 /Applications",
  );
  assert.equal(darwinWord.appPathCandidates?.length, 1);
  assert.ok(
    darwinWord.appPathCandidates![0]!.endsWith(join("Applications", "Microsoft Word.app")),
    "用户自装目录 ~/Applications 是第二候选",
  );

  const win32Word = getFileApplicationDefs("win32").find((def) => def.id === "word")!;
  assert.ok(
    win32Word.appPath.endsWith(join("Microsoft Office", "root", "Office16", "WINWORD.EXE")),
  );
  assert.ok(
    win32Word.appPathCandidates?.some((candidate) =>
      candidate.endsWith(join("Microsoft Office", "Office16", "WINWORD.EXE")),
    ),
    "第二候选是旧布局 Office16",
  );

  const linuxVlc = getFileApplicationDefs("linux").find((def) => def.id === "vlc")!;
  assert.equal(linuxVlc.appPath, "/usr/bin/vlc");
  assert.deepEqual(linuxVlc.executableNames, ["vlc"]);
  // 只有 LibreOffice 三件需要 --writer/--impress/--calc 区分组件。
  const launchArgsOwners = getFileApplicationDefs("linux")
    .filter((def) => def.launchArgs?.length)
    .map((def) => def.id)
    .sort();
  assert.deepEqual(launchArgsOwners, [
    "libreoffice-calc",
    "libreoffice-impress",
    "libreoffice-writer",
  ]);
});

test("T-UF6 解析：appPath 命中即返回，PATH 目录按 executableNames 兜底", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omz-fileapp-"));
  try {
    const preferred = join(dir, "preferred-bin");
    const fallback = join(dir, "fallback-bin");
    const pathOnly = join(dir, "path-only-bin");
    await writeFile(preferred, "");
    await writeFile(fallback, "");
    await writeFile(pathOnly, "");

    const def: FileApplicationDef = {
      id: "probe",
      name: "Probe",
      appPath: preferred,
      appPathCandidates: [fallback],
      command: null,
      fileExtensions: ["pdf"],
      executableNames: ["path-only-bin"],
    };

    assert.equal(
      await resolveFileApplicationPath(def, "linux", dir),
      preferred,
      "appPath 必须先于 appPathCandidates 与 PATH",
    );

    const pathOnlyDef: FileApplicationDef = {
      ...def,
      appPath: join(dir, "missing-bin"),
      appPathCandidates: [],
    };
    // PATH 兜底只在 darwin/linux 生效（`platform === "linux"` 分支，按 ":" 切分）。
    // Windows 主机的绝对路径自带盘符冒号，无法在 win32 宿主上构造合法的 POSIX searchPath，故跳过。
    if (process.platform !== "win32") {
      assert.equal(
        await resolveFileApplicationPath(pathOnlyDef, "linux", dir),
        pathOnly,
        "appPath 缺失时必须回退到 PATH 里的 executableNames",
      );
    }
    assert.equal(
      await resolveFileApplicationPath(
        { ...pathOnlyDef, executableNames: ["absent-bin"] },
        "linux",
        process.platform === "win32" ? "" : dir,
      ),
      null,
      "全都缺失时必须返回 null（未安装的可选应用不进列表）",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T-UF6 归并与接线形状：IDE 基座过滤文件应用、打开链路透传 path", async () => {
  const editors = await readFile(desktopSrc(join("main", "editors.ts")), "utf8");
  assert.ok(
    editors.includes("...getFileApplicationDefs()"),
    "三平台都必须把文件应用并入打开方式候选",
  );
  assert.ok(
    editors.includes('filter((def) => !("fileExtensions" in def))'),
    "工作区编辑器列表必须过滤掉文件应用（只按文件类型出）",
  );
  assert.ok(editors.includes("export async function getInstalledEditors(filePath?: string)"));
  assert.ok(editors.includes("matchesFileApplication(def, filePath)"));
  assert.ok(editors.includes("cachedFileApps"), "文件应用探测结果要按 id 缓存");

  const openInEditor = await readFile(desktopSrc(join("main", "openInEditor.ts")), "utf8");
  assert.ok(openInEditor.includes("const fileApp = getFileApplicationDefs().find("));
  for (const guard of [
    "options?.remoteTarget",
    'options?.pathKind === "directory"',
    "win32.isAbsolute(path)",
    "matchesFileApplication(fileApp, path)",
    "unsupported file application target",
    "application is not installed",
  ]) {
    assert.ok(openInEditor.includes(guard), `文件应用打开守卫缺失：${guard}`);
  }
  assert.ok(openInEditor.includes("child.unref()"), "阅读器必须 detached 启动，不能等待退出");

  const platformContract = await readFile(
    desktopSrc(join("main", "desktopMainIpcPlatform.ts")),
    "utf8",
  );
  assert.ok(
    platformContract.includes(
      'getInstalledEditors(typeof filePath === "string" ? filePath : undefined)',
    ),
    "IPC 层必须把 filePath 透传到探测并丢弃非字符串载荷",
  );
});
