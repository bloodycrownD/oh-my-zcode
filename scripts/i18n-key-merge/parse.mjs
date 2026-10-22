/**
 * i18n locale 文件解析与序列化。
 *
 * 解析目标形态（omz 与上游一致）：扁平 `const xx: Record<string, string> = { "k": "v", ... }`。
 * 值字面量支持双引号/单引号/无插值反引号三种（上游 bots.setup 等键用单引号内嵌双引号）；
 * 上游文件头 request-security-edition 的 import 在 prelude 中、spread 合并逻辑按 spread
 * token 跳过，均不采纳。
 */

const ANCHOR = "Record<string, string> = {";

/**
 * 解析 locale 源码为 { prelude, entries: [key, value][] }。
 * prelude：文件头注释 + const 声明（含结尾 "{"），供序列化复用。
 */
export function parseLocale(source, label) {
  const anchorIdx = source.indexOf(ANCHOR);
  if (anchorIdx < 0) {
    throw new Error(`[${label}] 未找到结构锚点 ${JSON.stringify(ANCHOR)}，文件结构可能已变化`);
  }
  const prelude = source.slice(0, anchorIdx + ANCHOR.length);
  const bodyStart = anchorIdx + ANCHOR.length;
  const bodyEnd = source.indexOf("\n};", bodyStart);
  if (bodyEnd < 0) {
    throw new Error(`[${label}] 未找到对象收尾 "\\n};"`);
  }
  const body = source.slice(bodyStart, bodyEnd);

  const entries = [];
  const seen = new Set();
  let pos = 0;
  const fail = (msg) => {
    const ctx = body.slice(Math.max(0, pos - 70), pos + 70).replace(/\n/g, "\\n");
    throw new Error(`[${label}] 解析错误 @${pos}: ${msg}\n  上下文: ${ctx}`);
  };

  const readString = (quote) => {
    // pos 停在开引号；粘性正则取完整字面量（含转义）。
    const bodyChar = quote === '"' ? '[^"\\\\]' : quote === "'" ? "[^'\\\\]" : "[^`\\\\]";
    const re = new RegExp(`${quote}((?:${bodyChar}|\\\\.)*)${quote}`, "y");
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) fail("字符串字面量解析失败");
    pos = re.lastIndex;
    if (quote === "`" && m[1].includes("${")) {
      fail("模板字符串含 ${} 插值，超出纯 Record 键值范围");
    }
    return unescapeTs(m[1]);
  };

  while (pos < body.length) {
    const ch = body[pos];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pos++;
      continue;
    }
    if (ch === "/" && body[pos + 1] === "/") {
      while (pos < body.length && body[pos] !== "\n") pos++;
      continue;
    }
    if (ch === "/" && body[pos + 1] === "*") {
      const end = body.indexOf("*/", pos + 2);
      if (end < 0) fail("未闭合的块注释");
      pos = end + 2;
      continue;
    }
    if (ch === ".") {
      if (!body.startsWith("...", pos)) fail("意外的 '.'");
      pos += 3;
      // spread 合并逻辑（requestSecurityMessagesXxx）：跳过标识符，不采纳其键。
      while (pos < body.length && /[\w$]/.test(body[pos])) pos++;
      continue;
    }
    if (ch === ",") {
      pos++;
      continue;
    }
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      fail(`意外字符 ${JSON.stringify(ch)}（仅支持字符串字面量键值）`);
    }
    const key = readString(ch);
    while (pos < body.length && /\s/.test(body[pos])) pos++;
    if (body[pos] !== ":") fail("键后缺少 ':'");
    pos++;
    while (pos < body.length && /\s/.test(body[pos])) pos++;
    if (body[pos] !== '"' && body[pos] !== "'" && body[pos] !== "`") {
      fail("值不是字符串字面量（双引号/单引号/无插值反引号）");
    }
    const value = readString(body[pos]);
    if (seen.has(key)) fail(`重复键 ${key}`);
    seen.add(key);
    entries.push([key, value]);
  }

  return { prelude, entries };
}

/** TS 双引号字符串转义还原（\n \t \r \b \f \v \0 \xNN \uNNNN \u{...} 行续接与恒等转义）。 */
function unescapeTs(raw) {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const d = raw[++i];
    switch (d) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "x":
        out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      case "u":
        if (raw[i + 1] === "{") {
          const end = raw.indexOf("}", i + 2);
          out += String.fromCodePoint(Number.parseInt(raw.slice(i + 2, end), 16));
          i = end;
        } else {
          out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
          i += 4;
        }
        break;
      case "\n":
        break; // 行续接
      default:
        out += d; // \" \\ \' \/ 等
    }
  }
  return out;
}

/** 序列化：一行一键值（oxfmt 之后会自行折行重排，语义不变）。 */
export function serialize(parsed, entries) {
  const constName = parsed.constName ?? parsed.prelude.match(/const (\w+):/)?.[1] ?? "locales";
  const lines = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  return `${parsed.prelude}\n${lines.join("\n")}\n};\n\nexport default ${constName};\n`;
}
