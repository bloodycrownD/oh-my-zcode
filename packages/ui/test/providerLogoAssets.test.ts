import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface ProviderLogoSourceManifest {
  logos: Array<{ file: string }>;
}

const assetDirectory = new URL("../src/assets/provider-icons/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("model-provider-logo-sources.json", assetDirectory), "utf8"),
) as ProviderLogoSourceManifest;

function readPngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readSvgSize(source: string): { width: number; height: number } {
  const viewBox = source.match(/viewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/u);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  const width = source.match(/\bwidth=["']([\d.]+)/u)?.[1];
  const height = source.match(/\bheight=["']([\d.]+)/u)?.[1];
  if (!width || !height) throw new Error("SVG 缺少可机械验证的固有尺寸");
  return { width: Number(width), height: Number(height) };
}

describe("Provider built-in logo assets", () => {
  it("Z.AI PNG 是 128x128 的方形应用图原样素材，不再误用同名旧 SVG", () => {
    // FORK(upgrade-316)：上游断言该 logo 与 desktop/build/icons/128x128.png 逐字节一致；
    // fork 已把应用图标换成自有品牌（两文件尺寸不同），Z.AI 供应商 Logo 保持上游原样，
    // 等式不再成立——改为只约束素材自身的方形尺寸，不与应用图标耦合。
    const packaged = readFileSync(new URL("model-provider-zai-app.png", assetDirectory));
    expect(readPngSize(packaged)).toEqual({ width: 128, height: 128 });
  });
  it("来源清单中的每个内置 Logo 素材本身都是方形", () => {
    for (const { file } of manifest.logos) {
      const assetUrl = new URL(file, assetDirectory);
      const size = file.endsWith(".png")
        ? readPngSize(readFileSync(assetUrl))
        : readSvgSize(readFileSync(assetUrl, "utf8"));
      expect(size, file).toEqual({ width: size.width, height: size.width });
    }
  });
});
