// 组件级测试入口（node --import 形态）：一并注册 tsx（解析 @/ 路径别名）与
// 图片资产 mock，供根 script 与 CI 直接挂载。
// 用法：node --import ./packages/ui/test/helpers/setup-ui-component-test.mjs --test <*.test.ts>
import { register } from "node:module";

// tsx 的 tsconfig 自动发现以 cwd 为准；根 script 从仓库根运行，显式指到 ui 包。
process.env.TSX_TSCONFIG_PATH ||= "packages/ui/tsconfig.json";

// tsx 只支持 import 副作用注册（等价 --import tsx），随后再叠资产 mock loader。
await import("tsx");
register("./ui-asset-loader.mjs", import.meta.url);
