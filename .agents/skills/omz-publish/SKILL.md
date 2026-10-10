---
name: omz-publish
description: 发布 oh-my-zcode 版本——CHANGELOG 定稿、版本 bump、git tag、GitHub Release 工作流。用户要求发版/publish/打 tag/bump 版本时使用。
---

# oh-my-zcode 发版

**Git tag、根 package.json version、桌面端关于页显示的版本必须一致。**
tag 形如 `v1.0.5` → 根 package.json version 为 `1.0.5`（桌面 appVersion 唯一来源就是根 package.json，见 `packages/desktop/scripts/build-metadata.mjs`）。

## 版本号规则（硬性）

**新版本号一律为上一发布版本的 patch 位 +1（只允许 `+0.0.1`），与功能体量无关，agent 不得按 minor/major 语义自行升级。** 上一版本看 `git tag` 最新 `v*`（或 CHANGELOG 最新 `## [x.y.z]`）。版本号策略若需变更，由用户明确拍板后更新本条。

## 发版方式（手动三件套，不使用 release-it）

`.release-it.mjs` 已删除：它的 conventional-changelog 自动生成是 commit 流水账，changelog 改为手写（见 [omz-changelog](../omz-changelog/SKILL.md)）。机械三件套 = 手动 bump + 手动提交 + 手动打 tag 推送。

## Checklist（在 `main` 上完成后再打 tag）

```
- [ ] CHANGELOG.md 定稿本版本 `## [x.y.z]` 段（从 [Unreleased] 挪入并加 compare 链接与日期；CI 会写入 Release 正文）
- [ ] 确认新版本号 = 上一 tag 的 patch +1（+0.0.1 规则）
- [ ] bump 根 package.json version（桌面端唯一版本来源；CLI 发版走独立 `pnpm release:cli`，不在此流程）
- [ ] 按改动范围跑验证：至少根 `pnpm typecheck` + 相关测试；大版本跑全套门禁（根 typecheck/lint、cd apps/zcode-cli && pnpm typecheck 27/27、magic-context test:all、根 test:v4-perf、desktop 差分 typecheck-desktop-full、architecture check）
- [ ] main 提交版本 bump + CHANGELOG（commit 勿含敏感文件）
- [ ] git tag vX.Y.Z
- [ ] git push origin vX.Y.Z   # 触发 Release Desktop 工作流
- [ ] git push origin main      # 同步 main；不触发 CI
- [ ] （可选）gh run watch 盯工作流至完成，gh release view vX.Y.Z 核验资产与正文
```

## 命令

```bash
git tag v1.0.6
git push origin v1.0.6    # 触发 Release；上传 tag，不更新远程 main ref
git push origin main      # 同步远程 main
```

Release 失败需重跑：`git tag -f v1.0.6 && git push origin v1.0.6 --force`（仍只保留一个 tag 名）。

## CI（`.github/workflows/release-desktop.yml`）

- **唯一**发布工作流；仅 `push` 匹配 `v*` tag 时运行（push/PR 不触发）
- 并行构建三平台：**macOS**（dmg+zip，arm64/x64）/ **Windows**（NSIS 安装器 + zip 便携版）/ **Linux**（AppImage/deb/rpm/pacman）
- Release 正文：checkout CHANGELOG.md 后用 awk 提取对应版本段写入（两种节头都认：`## [1.0.5](compare) (date)` 与 `## v1.0.4（date）`；无段落回落 GitHub 自动 notes）
- 产物发布到 GitHub Releases：`bloodycrownD/oh-my-zcode`；单资产 2GiB 上限，超限跳过上传并打 warning（Artifacts 仍有）
- macOS 默认未签名；`ZCODE_MAC_ADHOC_SIGN` / 正式签名链路见 electron-builder.config.js 注释

## 已知边界

- 应用内**没有自动更新**（无 electron-updater）；若未来要加：macOS 需先解决正式签名，Windows 未签名包更新体验为重跑安装器
- 发布后想改 Release 正文：`gh release edit vX.Y.Z --notes-file <段落文件>`（段落从 CHANGELOG 提取，注意**边界认任意 `## ` 头**，别只匹配带方括号的格式——历史节头是 `## vX.Y.Z（日期）`）

## Git

**仅在用户明确要求时** `git commit` / `push`；不要擅自提交。

## 暂不要

- 不要恢复 release-it / conventional-changelog 自动生成（changelog 手写是定稿流程）
- 未讨论前不改 release-desktop.yml 的产物矩阵与触发条件
