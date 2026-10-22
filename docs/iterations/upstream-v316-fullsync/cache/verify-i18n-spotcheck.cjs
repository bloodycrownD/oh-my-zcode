// verify-i18n 抽查（T-I1/T-I2 补充证据）
const fs = require("fs");
const execSync = require("child_process").execSync;
const zh = fs.readFileSync("packages/ui/src/i18n/locales/zh-CN.ts", "utf8");
const en = fs.readFileSync("packages/ui/src/i18n/locales/en-US.ts", "utf8");
const checks = [
  ["采纳键 chat.toolCall.* 在场", /"chat\.toolCall\./.test(zh)],
  ["采纳键 settings.memory.* 在场", /"settings\.memory\./.test(zh)],
  ["死键 conversationShare.* 绝迹（zh+en）", !/"conversationShare\./.test(zh) && !/"conversationShare\./.test(en)],
  ["轨迹键 modelTrajectory.* 在场", /"modelTrajectory\./.test(zh)],
  ["webRemoteControl.* v1 死键仍在（phase-relay-cleanup 才清）", /"webRemoteControl\.trigger"/.test(zh)],
  ["上游 request-security import 未带入", !zh.includes("request-security-edition")],
];
let fail = 0;
for (const [name, ok] of checks) { console.log(ok ? "PASS" : "FAIL", name); if (!ok) fail++; }
console.log(execSync("git diff --stat 1ff8cad9..HEAD -- packages/ui/src/i18n scripts package.json", { encoding: "utf8" }).trim());
process.exit(fail);
