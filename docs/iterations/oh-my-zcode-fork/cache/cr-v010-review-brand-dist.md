# CR v0.10.0 评审输出 — node review-brand-dist

- 模式: scope (readonly)
- BASE_SHA: 1fa2d0e / HEAD_SHA: aba59a9
- 检查维度: A + B + C + C-orch + G
- Spec: docs/iterations/oh-my-zcode-fork/spec.md (S32-S35 + D-2/D-10)
- 证据包: cache/cr-v010-evidence-brand-dist.md
- fix-spec: docs/iterations/oh-my-zcode-fork/cr-fix-spec-v0.1.0.md
- 状态: 完成
- **本结论由主代理手工等效审查产出（标注：手工审查）**——子代理连续 7 次网络失败后按 skill 失败处置规则降级；E5 主发现均已由主代理回读验证（验证记录见各条）。

## must-fix

### review-brand-dist/B-1 — P0 — CDN 旧 id 别名容忍是不可达死代码：真实环境官方插件市场刷新仍然失败
- 文件：`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:356-382`、`apps/zcode-cli/packages/contracts/src/plugins/index.ts:22-24`、`apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts:121-128`
- 维度：B（正确性）+ A（T-P2 验收不实）
- 问题【已验证：主代理回读 marketplace.ts:350-390 全段 + contracts/plugins/index.ts:22】：
  - 实测 CDN（cdn-zcode.z.ai/zcode/official-plugin/marketplace.json）顶层 `name` 仍是 `zcode-plugins-official`（E5 网络实测）。
  - 刷新路径 `:366-373`：`trustedId === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE && loaded.manifest.name !== canonical` → **先抛错**；`:375` 只在 `name === canonical` 时才调 `writeCdnOfficialMarketplacePartitionSync`。因此 4c8a580 加在 official-marketplace.ts:125-128 的旧名别名分支**永远不可达**（调用前提已是新名）。
  - `isOfficialMarketplaceId`（contracts:22-24）只认新 id，旧名不享受任何宽容。
  - E2E B7 的「CDN 别名容忍成立」结论失实：沙箱无 cdn-marketplace.json、known_marketplaces.json 无 lastRefreshFailure——刷新根本没发生（bundled 分片撑住了插件列表）。
  - 后果：每个真实用户在 CDN 重新发布前，官方市场刷新必失败（D-2 决定保留端点，CDN 侧不可控）。
- 改法（信任边界别名归一）：
  1. `contracts/src/plugins/index.ts` 增加别名常量并让判定接受双 id：
     ```ts
     export const LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_IDS = ["zcode-plugins-official"] as const;
     export function isOfficialMarketplaceId(id: string): boolean {
       return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE
         || (LEGACY_OFFICIAL_PLUGIN_MARKETPLACE_IDS as readonly string[]).includes(id);
     }
     ```
  2. `marketplace.ts:366-373` 的守卫改为「manifest 名不在 canonical∪legacy 集合才抛」；`:375` 的 canonical 判定改为 `isOfficialMarketplaceId(loaded.manifest.name)`，让旧名 manifest 也能进 `writeCdnOfficialMarketplacePartitionSync`（其内部 assert 已容忍双名；`rebuildOfficialMarketplaceSync:81` 本就把合并 manifest 的 `name` 归一为 canonical——持久化与 UI 引用不变）。
  3. `:356` 保留名保留字检查不变（isOfficialMarketplaceId 扩集后语义仍自洽：reserved 名单含旧名，非 trusted 不得冒用）。
  4. 注释登记过渡语义：CDN 重新发布新名后 legacy 集合可摘除。
- 验收/测试：adapters 侧新增单测（node:test 仿 test-feature-flag 模式）：manifest name=zcode-plugins-official + trustedId=canonical → 刷新成功、partition 落盘、merged name=canonical、插件条目合并；manifest name=第三方名 → 仍抛 reserved 错。**真实网络冒烟**（隔离 HOME）：启动后触发市场刷新，断言 `marketplaces/cdn-marketplace.json` 出现且 known_marketplaces 无 lastRefreshFailure。
- 来源：evidence-brand-dist §发现1 + 主代理代码回读验证

### review-brand-dist/C-1 — P2 — darwin SEA 配置是修复前陈旧产物（magic-context=0）
- 文件：`apps/zcode-cli/packages/cli/dist/sea-config-darwin-arm64.json`（5737 assets，magic-context 命中 0；对照 win-x64 7182/1393）
- 维度：C（产物卫生）
- 问题【已验证：dist 下 darwin/win 两份 sea-config 并存，E5 计数如上】：S35 修复只重建了 win-x64 目标，darwin 产物停留在修复前，发布若打包它会复现 M1。
- 改法：发布前对全部 target 重跑 `build:sea`；或在 dist 清理流程中删除非本次构建的陈旧 sea-config。短期：直接删除该陈旧文件并在发布 SOP（UPSTREAM-SYNC 或 build 脚本）写明「sea-config 属构建产物，发布前须全 target 重建」。
- 验收：`build:sea --all`（或在 mac/linux 宿主）全 target 产出一致包含 magic-context 资产；dist 无 magic-context=0 的 sea-config。
- 来源：evidence-brand-dist §发现2

### review-brand-dist/A-1 — P2 — EXEMPT-2b 的加载点计数与登记不符（7 处 vs 5 处）
- 文件：`docs/.iteration-state.yaml` phase3.exempt 节（「5 处静态 require」）；产物事实：dist/zcode.cjs 内 5 静态 require @187163/545099/545158/545796/545906 + 2 动态 import() @272595/573119
- 维度：A（登记准确性）
- 问题【已验证：E5 对产物 grep 计数，主代理采信（与 M1 修复报告的「5 处」出自同一产物，动态 2 处为修复时新增发现）】：EXEMPT 登记少计 2 处动态 import——将来做 SEA loader 时按 5 处清单改会漏 2 处。
- 改法：iteration-state 与 UPSTREAM-SYNC.md 的 EXEMPT-2b 条目更正为「5 静态 require + 2 动态 import 共 7 处加载点」。纯文档。
- 验收：两处文档一致。
- 来源：evidence-brand-dist §发现3

### review-brand-dist/A-2 — P2 — install 演练证据真实存在（对 E5 发现3 后半的订正）——登记澄清即可
- 文件：`.e2e-s35/install-drill2.txt`、`.e2e-s35/prompt-drill.txt`
- 维度：A（验收留痕索引）
- 问题【已验证：主代理复核 .e2e-s35/ 两文件实存在盘，内容含 file:// 安装、S35FIX-MARKER-OK、BASH-DONE、magic-context.db、real ~/.omz absent】：E5 在错误的沙箱（.e2e-phase3-final/）找修复后证据而误报「无落盘证据」。M1 修复后的 install 演练证据成立。需要做的只是在终验报告中补一行证据路径勘误，避免后人同样找不到。
- 改法：`cache/phase3-final-e2e-report.md` 追加勘误注记：「M1 修复后的 install 演练证据在 .e2e-s35/（install-drill2.txt / prompt-drill.txt），非本目录」。
- 验收：报告含勘误。
- 来源：主代理复核（推翻 E5 发现3 后半）

### review-brand-dist/C-2 — P2 — 用户可见品牌残留 4 处
- 文件与问题【E5 取证，主代理采信（均有 file:line 与行为说明）】：
  1. `cli/src/env.ts:136`：隐式 beta 触发键仍是 `zcode-beta`，落点却已改 `~/.omz-beta`——fork 发行链只产 `omz`，触发不可达，属死逻辑。
  2. `cli/src/tui-runtime-loader.ts:120-138` 与 `sea-playwright-runtime.ts:120-134`：SEA 缓存根仍 `…/zcode/sea-assets`（三平台）——数据目录已迁 `.omz`，缓存根旧名不一致。
  3. `i18n/locales/{en-US,zh-CN}.ts:290/286`：TUI 启动串「Starting ZCode…」未跟随 bin 改名。
  4. `README.md:88`/`README.en.md:82`：「`npm i -g oh-my-zcode`」但根 package.json `private:true` 且 npm publish 未做——安装承诺不可兑现。
- 改法：1) 删除 `zcode-beta` 死触发（或改为 `omz-beta` 并登记）；2) 缓存根改 `.omz/sea-assets`（与 S32 数据目录约定对齐；旧缓存自然失效可接受，属缓存）；3) 启动串改「Starting omz…」双语；4) README 安装节改为「经 install.sh / release 产物安装」并在决定 npm publish 后恢复该句（或在 README 注明 planned）。
- 验收：grep `zcode-beta`/`zcode/sea-assets`/`Starting ZCode` 归零（或仅剩登记注释）；README 不再承诺未发布的安装渠道。
- 来源：evidence-brand-dist §发现4

### review-brand-dist/C-3 — P2 — S34 合规口径三处矛盾 + 5 处机械替换注释不一致 + L1 重放规则措辞
- 文件与问题【E5 取证，关键点主代理采信】：
  1. `LICENSE.magic-context:15-18`「src/core 文件按其自身头注释是逐字移植件」与事实相反（上游本无 per-file 头；226 个文件无头）。
  2. `.reference` 路径两种口径：LICENSE.magic-context:9（仓内相对，不存在）vs UPSTREAM-SYNC.md:11（`<repo>/../.reference/`，实际存在）。
  3. `UPSTREAM-SYNC.md:80/:83` 同一文件两个路径（helpers/ vs methods/）。
  4. `UPSTREAM-SYNC.md:64` L1 重放规则「`~/.zcode` 一律改写成 `~/.omz`」按字面会误改工作区级 `.zcode`，与双轨实现相反；NOTICE.md:12 品牌行未注明工作区级保持。
  5. S32 机械替换留下 5 处注释/代码不一致：`services/src/skills/skillsService.ts:134-138/:1209`、`contracts/src/tools/saved-workflow.ts:43-46`（即 review-protocol/C-orch-1 同源）、`shared/src/storage.ts:6`、`services/src/skills/skills.ts:25/31/39`。
- 改法：逐处订正——LICENSE 措辞改为「上游以根 LICENSE 声明许可（无 per-file 头）；本包 33 个曾误标 Apache-2.0 的头注释已订正为 MIT」；.reference 路径统一为 `<repo>/../.reference/`；UPSTREAM-SYNC L1 规则补「**仅用户级 HOME 下**的 .zcode；工作区级 `<cwd>/.zcode` 刻意保留」；5 处注释按代码事实改回。
- 验收：文档两两一致；`rg "\.omz/workflows"` 等锚点核对通过（与 review-protocol/C-orch-1 联动）。
- 来源：evidence-brand-dist §发现5 + review-protocol 交叉

## open_questions

- **OQ-1**：`zcode-beta` 死触发的处置（删除 vs 改名 `omz-beta`）——C-2.1 默认按删除执行，若 owner 认为将来要复用 beta 通道则改名保留。
- **OQ-2**：SEA 缓存根改名后旧 `zcode/sea-assets` 缓存失效（用户重新下载）——默认接受（缓存语义）；若不可接受需做一次性迁移提示。

## spec_deviations

- SD-1（open）：T-P2「插件市场在改名后仍可用」验收不实（B-1 证实刷新路径必败）→ 随 B-1 修复 + 真实网络冒烟后 close。
- SD-2（fixed）：工作区级 `.zcode` 保留、electron 桌面身份不改、`--all` SEA 豁免（EXEMPT-2a）均已登记。
- SD-3（open）：npm publish 未做（设计如此），但 README 提前承诺 npm 安装（C-2.4）→ 随 C-2 修复 close。

## 结论

**scope-ready: no** — 1 条 P0（B-1，真实用户市场刷新必败）+ 5 条 P2。B-1 是 v0.1.0 对外可用性的硬缺口，优先级最高；其余为品牌/合规口径收尾。
