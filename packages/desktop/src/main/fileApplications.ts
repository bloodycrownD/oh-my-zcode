import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname, join, win32 } from "node:path";

/**
 * 文档/媒体类「文件应用」登记表 —— 与 IDE 类编辑器分开维护。
 *
 * IDE 面向工作区（目录），文件应用面向具体文件类型（PDF/Office/音视频），
 * 二者的候选路径规则、启动参数和可用性判定都不同，因此独立成件。
 * `editors.ts` 负责把它并进打开方式列表，`openInEditor.ts` 负责按类型匹配后拉起。
 */
export interface FileApplicationDef {
  id: string;
  name: string;
  appPath: string;
  appPathCandidates?: string[];
  command: null;
  fileExtensions: readonly string[];
  executableNames?: string[];
  windowsVersionRoots?: string[];
  launchArgs?: string[];
}

const queryAppPath = (key: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "reg.exe",
      ["query", key, "/ve"],
      { windowsHide: true, timeout: 2000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
const OFFICE = ["docx", "pptx", "xlsx"];
const MEDIA = ["mp3", "mp4"];

function mac(
  id: string,
  name: string,
  bundle: string,
  fileExtensions: string[],
): FileApplicationDef {
  const appPath = bundle.startsWith("/") ? bundle : `/Applications/${bundle}.app`;
  return {
    id,
    name,
    appPath,
    // 用户自装应用可能落在 ~/Applications，和 /Applications 同构但不在系统目录。
    appPathCandidates: [join(homedir(), "Applications", basename(appPath))],
    command: null,
    fileExtensions,
  };
}

function windows(
  id: string,
  name: string,
  relativePaths: string[],
  fileExtensions: string[],
  executableNames: string[],
): FileApplicationDef {
  const roots = [
    ...new Set(
      [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        `${process.env.SystemDrive || "C:"}\\Program Files`,
        `${process.env.SystemDrive || "C:"}\\Program Files (x86)`,
        process.env.LOCALAPPDATA,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  // 同一相对路径要在所有安装根下展开，候选顺序即首选顺序（首个存在者胜出）。
  const paths = roots.flatMap((root) => relativePaths.map((path) => win32.join(root, path)));
  return {
    id,
    name,
    appPath: paths[0] ?? "",
    appPathCandidates: paths.slice(1),
    command: null,
    fileExtensions,
    executableNames,
  };
}

function linux(
  id: string,
  name: string,
  executable: string,
  fileExtensions: string[],
  launchArgs?: string[],
): FileApplicationDef {
  return {
    id,
    name,
    appPath: `/usr/bin/${executable}`,
    command: null,
    executableNames: [executable],
    fileExtensions,
    launchArgs,
  };
}

export function getFileApplicationDefs(
  platform: NodeJS.Platform = process.platform,
): FileApplicationDef[] {
  if (platform === "darwin")
    return [
      mac("preview", "Preview", "/System/Applications/Preview.app", ["pdf"]),
      mac("adobe-acrobat", "Adobe Acrobat", "Adobe Acrobat DC/Adobe Acrobat", ["pdf"]),
      mac("adobe-reader", "Adobe Acrobat Reader", "Adobe Acrobat Reader", ["pdf"]),
      mac("pdf-expert", "PDF Expert", "PDF Expert", ["pdf"]),
      mac("word", "Microsoft Word", "Microsoft Word", ["docx"]),
      mac("pages", "Pages", "Pages", ["docx"]),
      mac("powerpoint", "Microsoft PowerPoint", "Microsoft PowerPoint", ["pptx"]),
      mac("keynote", "Keynote", "Keynote", ["pptx"]),
      mac("excel", "Microsoft Excel", "Microsoft Excel", ["xlsx"]),
      mac("numbers", "Numbers", "Numbers", ["xlsx"]),
      mac("wps", "WPS Office", "wpsoffice", ["pdf", ...OFFICE]),
      {
        ...mac("libreoffice-writer", "LibreOffice Writer", "LibreOffice", ["docx"]),
        launchArgs: ["--writer"],
      },
      {
        ...mac("libreoffice-impress", "LibreOffice Impress", "LibreOffice", ["pptx"]),
        launchArgs: ["--impress"],
      },
      {
        ...mac("libreoffice-calc", "LibreOffice Calc", "LibreOffice", ["xlsx"]),
        launchArgs: ["--calc"],
      },
      mac("music", "Music", "/System/Applications/Music.app", ["mp3"]),
      mac("quicktime", "QuickTime Player", "/System/Applications/QuickTime Player.app", MEDIA),
      mac("iina", "IINA", "IINA", MEDIA),
      mac("vlc", "VLC", "VLC", MEDIA),
    ];
  if (platform === "win32") {
    const wps = windows(
      "wps",
      "WPS Office",
      ["Kingsoft/WPS Office/ksolaunch.exe", "Kingsoft/WPS Office/wps.exe"],
      ["pdf", ...OFFICE],
      ["ksolaunch.exe", "wps.exe"],
    );
    // WPS 的版本目录名形如 12.1.0.15990，实际 exe 在 <版本>/office6 下，只能运行时枚举。
    wps.windowsVersionRoots = [
      win32.join(process.env.LOCALAPPDATA || "", "Kingsoft", "WPS Office"),
      ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
        .filter((root): root is string => Boolean(root))
        .map((root) => win32.join(root, "Kingsoft", "WPS Office")),
    ];
    return [
      windows(
        "adobe-acrobat",
        "Adobe Acrobat",
        ["Adobe/Acrobat DC/Acrobat/Acrobat.exe"],
        ["pdf"],
        ["Acrobat.exe"],
      ),
      windows(
        "adobe-reader",
        "Adobe Acrobat Reader",
        ["Adobe/Acrobat Reader DC/Reader/AcroRd32.exe", "Adobe/Reader 11.0/Reader/AcroRd32.exe"],
        ["pdf"],
        ["AcroRd32.exe"],
      ),
      windows(
        "foxit",
        "Foxit PDF Reader",
        ["Foxit Software/Foxit PDF Reader/FoxitPDFReader.exe"],
        ["pdf"],
        ["FoxitPDFReader.exe"],
      ),
      windows(
        "word",
        "Microsoft Word",
        ["Microsoft Office/root/Office16/WINWORD.EXE", "Microsoft Office/Office16/WINWORD.EXE"],
        ["docx"],
        ["WINWORD.EXE"],
      ),
      windows(
        "powerpoint",
        "Microsoft PowerPoint",
        ["Microsoft Office/root/Office16/POWERPNT.EXE", "Microsoft Office/Office16/POWERPNT.EXE"],
        ["pptx"],
        ["POWERPNT.EXE"],
      ),
      windows(
        "excel",
        "Microsoft Excel",
        ["Microsoft Office/root/Office16/EXCEL.EXE", "Microsoft Office/Office16/EXCEL.EXE"],
        ["xlsx"],
        ["EXCEL.EXE"],
      ),
      wps,
      {
        ...windows(
          "libreoffice-writer",
          "LibreOffice Writer",
          ["LibreOffice/program/soffice.exe"],
          ["docx"],
          ["soffice.exe"],
        ),
        launchArgs: ["--writer"],
      },
      {
        ...windows(
          "libreoffice-impress",
          "LibreOffice Impress",
          ["LibreOffice/program/soffice.exe"],
          ["pptx"],
          ["soffice.exe"],
        ),
        launchArgs: ["--impress"],
      },
      {
        ...windows(
          "libreoffice-calc",
          "LibreOffice Calc",
          ["LibreOffice/program/soffice.exe"],
          ["xlsx"],
          ["soffice.exe"],
        ),
        launchArgs: ["--calc"],
      },
      windows(
        "edge",
        "Microsoft Edge",
        ["Microsoft/Edge/Application/msedge.exe"],
        ["pdf"],
        ["msedge.exe"],
      ),
      windows(
        "windows-media-player",
        "Windows Media Player",
        ["Windows Media Player/wmplayer.exe"],
        MEDIA,
        ["wmplayer.exe"],
      ),
      windows("vlc", "VLC", ["VideoLAN/VLC/vlc.exe"], MEDIA, ["vlc.exe"]),
      windows(
        "potplayer",
        "PotPlayer",
        ["DAUM/PotPlayer/PotPlayerMini64.exe", "DAUM/PotPlayer/PotPlayerMini.exe"],
        ["mp4"],
        ["PotPlayerMini64.exe", "PotPlayerMini.exe"],
      ),
    ];
  }
  if (platform === "linux")
    return [
      linux("evince", "Evince", "evince", ["pdf"]),
      linux("okular", "Okular", "okular", ["pdf"]),
      linux("firefox", "Firefox", "firefox", ["pdf"]),
      linux("wps", "WPS Office", "wps", ["docx"]),
      linux("wps-presentation", "WPS Presentation", "wpp", ["pptx"]),
      linux("wps-spreadsheets", "WPS Spreadsheets", "et", ["xlsx"]),
      linux("libreoffice-writer", "LibreOffice Writer", "libreoffice", ["docx"], ["--writer"]),
      linux("libreoffice-impress", "LibreOffice Impress", "libreoffice", ["pptx"], ["--impress"]),
      linux("libreoffice-calc", "LibreOffice Calc", "libreoffice", ["xlsx"], ["--calc"]),
      linux("vlc", "VLC", "vlc", MEDIA),
      linux("mpv", "mpv", "mpv", MEDIA),
    ];
  return [];
}

export function matchesFileApplication(def: FileApplicationDef, filePath?: string): boolean {
  // Windows 路径的分隔符和扩展名大小写都不稳定，统一按 POSIX 形式取 extname 后小写比较。
  const extension = filePath ? extname(filePath.replace(/\\/g, "/")).slice(1).toLowerCase() : "";
  return def.fileExtensions.includes(extension);
}

export async function resolveFileApplicationPath(
  def: FileApplicationDef,
  platform: NodeJS.Platform = process.platform,
  searchPath = process.env.PATH || "",
): Promise<string | null> {
  const candidates = [def.appPath, ...(def.appPathCandidates ?? [])];
  if (platform === "linux") {
    // Linux 发行版安装位置各异，registry 那套不可用，直接扫 PATH。
    candidates.push(
      ...searchPath
        .split(":")
        .filter(Boolean)
        .flatMap((root) => (def.executableNames ?? []).map((name) => join(root, name))),
    );
  }
  async function findPath(): Promise<string | null> {
    for (const path of candidates) {
      try {
        await access(path, platform === "linux" ? constants.X_OK : constants.F_OK);
        return path;
      } catch {
        /* 未安装的可选应用不进入列表。 */
      }
    }
    return null;
  }
  const direct = await findPath();
  if (direct || platform !== "win32") return direct;
  // 非标准安装位置的 Windows 应用只能从注册表 App Paths 里找。
  for (const name of def.executableNames ?? []) {
    for (const hive of ["HKCU", "HKLM"]) {
      try {
        const stdout = await queryAppPath(
          `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`,
        );
        const path = stdout
          .match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/)?.[1]
          ?.trim()
          .replace(/^"|"$/g, "")
          // REG_EXPAND_SZ 的路径含 %VAR%，注册表原样返回，这里按当前进程环境展开。
          .replace(/%([^%]+)%/g, (_, key: string) => process.env[key] || `%${key}%`);
        if (path && (await stat(path)).isFile()) return path;
      } catch {
        /* 非标准安装位置通过系统 App Paths 查找，缺失是正常情况。 */
      }
    }
  }
  for (const root of def.windowsVersionRoots ?? []) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
        for (const name of def.executableNames ?? [])
          candidates.push(win32.join(root, entry.name, "office6", name));
      }
    } catch {
      /* WPS 版本目录可能不存在。 */
    }
  }
  return findPath();
}
