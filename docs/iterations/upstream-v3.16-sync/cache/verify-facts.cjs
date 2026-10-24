const { execSync } = require("child_process");
const fs = require("fs");
const up = (p) => execSync(`git show "3c5b2276:${p}"`, { encoding: "utf8", maxBuffer: 10485760 });
const grepFile = (label, text, re) => text.split(/\r?\n/).forEach((l, i) => { if (re.test(l)) console.log(`${label}:${i + 1}: ${l.trim()}`); });

// 1) upstream tray renderer
grepFile("TRAY", up("packages/desktop/src/main/desktopTray.ts"), /renderAntialiasedStatusDotPixels|renderTaskbarBadgePixels|blendBadgeIntoBitmap|不可读|只画/);
// 2) upstream lifecycle renderer usage
grepFile("LIFE", up("packages/desktop/src/main/desktopWindowLifecycle.ts"), /renderTaskbar|renderAntialiased|BadgePixels|StatusDot|setOverlayIcon/);
// 2b) upstream unreadBadge exports + who uses renderTaskbarBadgePixels in production upstream-wide
grepFile("UB-UP", up("packages/desktop/src/main/unreadBadge.ts"), /export function/);
try {
  const hits = execSync(`git grep -n "renderTaskbarBadgePixels" 3c5b2276 -- "packages/desktop/src"`, { encoding: "utf8" });
  console.log("GREP-PROD(renderTaskbarBadgePixels in upstream src):\n" + hits);
} catch (e) { console.log("GREP-PROD: no hits in src"); }
// 3) omz nodeReplImageGrid
grepFile("NRIG-OMZ", fs.readFileSync("packages/ui/src/ToolCallBlocks/renderers/nodeReplImageGrid.tsx", "utf8"), /base64|image\.src/);
// 4) omz unreadBadge
grepFile("UB-OMZ", fs.readFileSync("packages/desktop/src/main/unreadBadge.ts", "utf8"), /sumWindowUnreadCounts|function/);
// 5) omz chromeState
grepFile("CS-OMZ", fs.readFileSync("packages/desktop/src/main/desktopWindowChromeState.ts", "utf8"), /WINDOWS_11_FIRST_BUILD|supportsNativeWindowsRoundedCorners/);
// 6) upstream locale fullView keys exact list
const en = up("packages/ui/src/i18n/locales/en-US.ts");
const keys = [];
en.split(/\r?\n/).forEach((l, i) => { const m = l.match(/["']?(sidePane\.fullView\.[A-Za-z]+|settings\.shortcuts\.command\.toggleSidePaneFullView)["']?\s*:/); if (m) keys.push(`${i + 1}: ${m[1]}`); });
console.log("LOCALE-KEYS(" + keys.length + "):\n" + keys.join("\n"));
