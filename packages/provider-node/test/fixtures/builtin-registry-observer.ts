import {
  ProviderConfigMap,
  type ProviderSource,
  type AccountProviderConfigSnapshot,
} from "@zcode/provider";
import { NodeProviderRegistryRuntime } from "../../src/provider-registry-runtime.js";

// 真实子进程只消费共享文件，模拟不拥有下载器的 Worker。
// FORK: AccountProviderService / createAccountSource 已随 zhipu-account 计费面删除；
// Account 改为跟随 config revision 的本地恒空快照，保持「Account 与 Registry 同版发布」的观察语义。
const runtime = new NodeProviderRegistryRuntime({
  zcodeBuiltinFilePath: process.argv[2]!,
  personalFilePath: process.argv[3]!,
  personalPollingIntervalMs: false,
  // FORK（D-4）：账号 Overlay 已整删，快照退化为恒空形状。
  accountSource: {
    async read(): Promise<AccountProviderConfigSnapshot> {
      const config = await runtime.configService.read();
      return {
        revision: "observer-account",
        basedOnZCodeBuiltinRevision: config.zcodeBuiltinRevision,
        providers: ProviderConfigMap.empty(),
      };
    },
    onDidChange(): () => void {
      return () => undefined;
    },
  } satisfies ProviderSource<AccountProviderConfigSnapshot>,
});
function report() {
  const snapshot = runtime.registryService.getSnapshot()!;
  process.send?.({
    pid: process.pid,
    builtin: snapshot.config.zcodeBuiltinRevision,
    account: snapshot.account.basedOnZCodeBuiltinRevision,
  });
}
runtime.registryService.onDidChange(report);
await runtime.start();
report();
process.on("message", () => {
  runtime.dispose();
  process.disconnect();
});
process.on("disconnect", () => {
  runtime.dispose();
});
