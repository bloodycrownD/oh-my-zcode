// @vitest-environment jsdom
// FORK（D-4）：上游的额度错误分类（团队套餐业务错误原文 / credential 与 generic 走
// 翻译文案 + lucide-info 警示 + 检查 API Key 入口）随 Coding Plan 额度面整删，
// App Usage 失败一律原文展示（见 UsageStatsErrorNotice.tsx 的组件注释）。
// 本文件锁定：任意错误原文透传、不落 usage.error.stats.* 翻译键、无检查 API Key 入口。

import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { UsageStatsErrorNotice } from "../src/settings/usage-stats/UsageStatsErrorNotice.js";

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("../src/lib/settingsNavigation.js", () => ({
  setPendingSettingsSection: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

function renderNotice(error: string): string {
  return renderToStaticMarkup(
    createElement(UsageStatsErrorNotice, {
      error,
    } satisfies ComponentProps<typeof UsageStatsErrorNotice>),
  );
}

describe("UsageStatsErrorNotice 原文透传", () => {
  it.each([
    "仅企业主账号可查询企业汇总数据",
    "您当前暂无有效的团队套餐授权记录，无法创建API Key",
    "token expired",
    "Request timed out after 15000ms",
  ])("原文展示 %s，不做额度错误分类", (error) => {
    const html = renderNotice(error);

    expect(html).toContain(error);
    expect(html).not.toContain("usage.error.stats.credential");
    expect(html).not.toContain("usage.error.stats.generic");
    expect(html).not.toContain("settings.usage.checkApiKey");
    expect(html).toContain("text-destructive");
  });
});
