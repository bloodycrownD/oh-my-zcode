# baseline 对比：before(main ba7c240) vs after(feature d11a97c)

采样口径：`scripts/dev/long-session-perf-sample.mjs`，会话 `sess_edd74a25`（979 msgs，title「PERF-基线导入-勿动-…」，
workspace `C:\Users\BloodyCrown\.omz\workspace\default`），两段窗口各 30s（stream 空闲 + scroll 驱动），
滚动容器 `[data-testid="v4-timeline"]`。

- before：`baseline-before.json`（用户 9229 实例，renderer dev server `localhost:5174`，main 代码）
- after：`baseline-after.json`（本节点新起隔离实例，CDP 9335，renderer dev server `localhost:5188`，feature 代码 d11a97c，
  `window.__zcodePerfProbe` 已挂载 → 代码差确认成立）

## 1. 核心数字（scroll 窗口 30s）

| 指标 | before | after | 变化 |
| --- | --- | --- | --- |
| longtask 次数 | 121 | 43 | **−64.5%（2.81x）** |
| longtask 总耗时 | 12293 ms | 3553 ms | **−71.1%（3.46x）** |
| longtask 最大值 | 330 ms | 316 ms | −4.2% |
| ≥500ms longtask | 0 | 0 | 持平 |
| 窗口内 JS heap | 153.6 MB → 235.4 MB（**+81.8 MB**） | 158.4 MB → 154.7 MB（**−3.7 MB**） | 增长被消除 |
| 滚动步数 | 225 | 249 | +10.7% |
| 滚动行程（driver 起点 maxScrollTop） | 34759 px | 71264 px | **2.05x** |
| scrollHeight / clientHeight | 35502 / 743 | 72007 / 743 | 行高口径不同，见 §3 |

stream（空闲）窗口：before longtask 0；after longtask 0。两边均无 >500ms 阻塞。

## 2. 长会话一致性

| 项 | before | after |
| --- | --- | --- |
| data-total-row-count | 1719 | 1719 |
| data-window-row-count | 1719 | 1719 |
| DOM 行数（虚拟化后） | 191 | 80 |
| longSession.ok | true | true |

**totalRowCount 完全一致（1719）**，两边都是真长会话，判定未被削弱。

## 3. 归一化补充指标（因滚动行程不同）

after 的滚动行程是 before 的 2.05 倍（滚动容器 scrollHeight 35502 → 72007，说明 feature 改了渲染单元/行高），
绝对值对比对 after 更不利，因此补充按行程归一：

| 归一指标 | before | after | 改善 |
| --- | --- | --- | --- |
| 每 1000px longtask 次数 | 3.48 | 0.60 | **5.8x** |
| 每 1000px longtask 总耗时 | 353.7 ms | 49.9 ms | **7.1x** |

## 4. 结论：PRD 验收线判定

PRD 验收线「滚动窗口 longtask **下降一个数量级**（≥10x）」：

- 次数：2.81x —— **未达标**
- 总耗时：3.46x —— **未达标**
- 行程归一后：5.8x（次数）/ 7.1x（耗时）—— **仍未达标，但已接近**

判定：**未通过「下降一个数量级」**。实测为 2.8x–3.5x（绝对值）/ 5.8x–7.1x（行程归一）的改善，
属于「显著改善但差一个量级」。若要把验收线从 10x 调整为可达成的水平，建议改成
「次数与总耗时均下降 ≥3x，且窗口内 heap 不再增长」——本次 after 满足该线。

补充：内存侧（窗口内 heap 由 +81.8MB 变为 −3.7MB）是本次最干净的收益，达标且无争议。

## 5. 复现备注（踩坑点）

1. **产物必须重建**：worktree 磁盘上的 `packages/desktop/out/`（host/main/preload）与
   `apps/zcode-cli/packages/cli/dist/zcode.cjs` 都是前一晚构建的，**早于** feature 分支上
   `af8c129 feat(bootstrap): turn 目录投影服务端段` 等提交。若直接复用，
   `conversationTurnDirectoryV4` 会缺失（bundle 内搜不到 `getTurnDirectory`）。
   本次已重建：`node scripts/build.mjs --desktop-agent`（CLI）+ `tsup`（desktop host，一次性）。
2. **隔离实例**：`--remote-debugging-port=9335` + `ZCODE_DESKTOP_USER_DATA_DIR=%TEMP%\zcode-perf-after-userdata`
   + `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1`，不设 `ZCODE_AGENT_SERVER_COMMAND`（靠 findUpward 命中 worktree 的 zcode.cjs），
   不设 `ELECTRON_RUN_AS_NODE`。
3. **探针 JSON 形态两版不同**：`baseline-before.json` 的 `probe` 是 `{segments, memory, rowCount, dumpedAt}`，
   `baseline-after.json` 的 `probe` 是**数组**（d11a97c 改了采样脚本）。对比脚本需同时兼容两种形态，
   否则 before 的 heap 会读成 null。
4. **同口径要求**：after 必须在会话**已完全加载**（windowRowCount == totalRowCount == 1719）时采。
   首轮采样是在会话刚打开、仍在分页拉取更早行时做的（stream 窗口 windowRowCount 仅 300），
   与 before 的前置条件不一致，已重跑一次作为最终 after 数据。
5. **日志噪声**：`zcode-agent.conversationFileChangesV4` 报
   `ENOENT ... .omz\cli\artifacts\sess_edd74a25`（19 次）与分享面板里的「发现无法分享的内容」是同一个原因——
   导入会话没有 artifacts 目录，属环境噪声，与本特性无关。
   `zcode-agent.conversationTurnDirectoryV4 OK (9.3ms / 2.5ms)` 表明新网关方法端到端可用。