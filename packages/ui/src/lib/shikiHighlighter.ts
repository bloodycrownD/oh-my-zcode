import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
// 这里的两个导入刻意保持相对路径：本文件的 LRU 护栏要能在 node:test 里被直接 import，
// 而 `@/` 别名只有 Vite/tsc 认识，tsx 跑纯 Node 测试时无法解析。
import { logger } from "../logger.js";
import { uiMemoryDiagnosticsRegistry } from "./memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

/**
 * tokensCache 的 LRU 上限。代码块的 tokens 是整段渲染结果，单条常驻开销不小；
 * 长会话里历史恢复 + 大 diff 会把不同代码块依次塞进来，无界增长是 renderer
 * 堆里最可疑的一块。命中会刷新顺序，因此上限淘汰掉的是真正久未使用的条目。
 */
const TOKENS_CACHE_MAX_ENTRIES = 500;

/**
 * 等待高亮结果的订阅 key 上限。正常路径在 resolve/catch 里都会取走并删除整个集合，
 * 订阅与退订天然对称；这里再加一道上限，防止 highlighter promise 异常不 settle 时
 * key 与回调闭包无限堆积。超限时丢弃最旧的等待者，组件退回无高亮的 rawTokens 状态，
 * 与高亮失败的表现一致，不会把界面卡住。
 */
const SUBSCRIBERS_MAX_PENDING_KEYS = 500;

/** Map 保持插入序，队首即最久未使用条目；超限时从队首淘汰。 */
const evictTokensCacheOverflow = (): void => {
  while (tokensCache.size > TOKENS_CACHE_MAX_ENTRIES) {
    const oldestKey = tokensCache.keys().next();
    if (oldestKey.done) {
      return;
    }
    tokensCache.delete(oldestKey.value);
  }
};

/**
 * 写入或刷新一条 tokens 缓存：先 `delete` 再 `set` 把它挪到队尾（LRU 刷新序），
 * 随后立刻重查一次上限。
 */
const putTokensCache = (key: string, value: TokenizedCode): void => {
  tokensCache.delete(key);
  tokensCache.set(key, value);
  // 异步写入点是并发高亮写缓存的终点：多个 in-flight 的 resolve 回调可能
  // 在同一轮微任务里连续写入，只在同步路径淘汰会漏掉超限的那几条，
  // 所以每次 set 之后都在这里重新查一次上限。
  evictTokensCacheOverflow();
};

/** 登记一个等待高亮结果的回调。 */
const addSubscriber = (key: string, callback: (result: TokenizedCode) => void): void => {
  const existing = subscribers.get(key);
  if (existing) {
    existing.add(callback);
    return;
  }

  subscribers.set(key, new Set([callback]));
  while (subscribers.size > SUBSCRIBERS_MAX_PENDING_KEYS) {
    const oldestKey = subscribers.keys().next();
    if (oldestKey.done) {
      return;
    }
    subscribers.delete(oldestKey.value);
  }
};

/**
 * 取走并移除某 key 的全部等待者。删除与读取放在同一个函数里，保证成功与失败
 * 两条路径的退订完全对称；重复调用只会拿到 undefined，不会泄漏回调。
 */
const takeSubscribers = (key: string): Set<(result: TokenizedCode) => void> | undefined => {
  const subs = subscribers.get(key);
  subscribers.delete(key);
  return subs;
};

// 内存诊断计数器：tokensCache / subscribers 都可能是 renderer 堆的增长点，
// 把条数落到日志里，便于和堆快照对照。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  highlighters: highlighterCache.size,
  pendingSubscribers: subscribers.size,
}));

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

const getCodeTokensCacheKey = (code: string, language: BundledLanguage, theme: BundledTheme) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${theme}:${language}:${code.length}:${start}:${end}`;
};
const getHighlighter = (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cacheKey = `${theme}:${language}`;
  const cached = highlighterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: [theme],
  });

  highlighterCache.set(cacheKey, highlighterPromise);
  return highlighterPromise;
};

const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    // 命中即刷新 LRU 顺序（delete + set 挪到队尾），否则最近正在看的代码块
    // 会被当成最旧条目在超限时淘汰掉，滚动回看就变成反复重算高亮。
    putTokensCache(tokensCacheKey, cached);
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }

  if (callback) {
    addSubscriber(tokensCacheKey, callback);
  }

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      // 异步写入点：这里会与其他 in-flight 的 resolve 回调并发写缓存，
      // 因此写入统一走 putTokensCache，在 set 之后重查一次上限再淘汰。
      putTokensCache(tokensCacheKey, tokenized);

      const subs = takeSubscribers(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      // 失败路径与成功路径同样退订，避免等待者集合残留。
      takeSubscribers(tokensCacheKey);
    });

  return null;
};

/*
 * ===== 测试 seam =====
 * 真实高亮要加载 Shiki 的语言包与 wasm，单测里跑不动；而 LRU 护栏本身是纯 Map 操作。
 * 这里导出最小的注入/观测入口，让 node:test 能直接验证 T-MG1 的上限与淘汰顺序。
 * 命名统一带 ForTest 后缀，生产代码没有任何消费者。
 */
export const __getTokensCacheSizeForTest = (): number => tokensCache.size;

/** 批量注入 tokens 缓存条目（走真实写入路径并立刻应用上限淘汰），返回注入的 key 列表。 */
export const __seedTokensCacheForTest = (prefix: string, count: number): string[] => {
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = `${prefix}:${index}`;
    tokensCache.set(key, { bg: "transparent", fg: "inherit", tokens: [] });
    keys.push(key);
  }
  evictTokensCacheOverflow();
  return keys;
};

/** 模拟一次缓存命中：复用生产命中路径的 delete + set 刷新序，key 不存在时返回 false。 */
export const __touchTokensCacheForTest = (key: string): boolean => {
  const cached = tokensCache.get(key);
  if (!cached) {
    return false;
  }
  putTokensCache(key, cached);
  return true;
};

export const __hasTokensCacheEntryForTest = (key: string): boolean => tokensCache.has(key);

export const __getPendingSubscribersCountForTest = (): number => subscribers.size;

/** 清空所有缓存与订阅，保证用例之间互不干扰。 */
export const __resetShikiHighlighterCachesForTest = (): void => {
  tokensCache.clear();
  subscribers.clear();
};
