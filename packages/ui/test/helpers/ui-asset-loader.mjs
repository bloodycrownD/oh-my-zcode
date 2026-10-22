// 测试辅助：把 ui 组件链里的图片资产 import（.png/.svg 等）映射为空字符串模块。
// ProviderLogo 等组件顶层 import provider-icons/*.png，node/tsx 无法加载二进制资产；
// 仅测试环境使用，不影响运行时打包（vite 资产管道不变）。
const ASSET_RE = /\.(png|jpe?g|gif|webp|avif|svg|woff2?|ttf)(\?.*)?$/;

export async function load(url, context, nextLoad) {
  if (ASSET_RE.test(url)) {
    return { format: "module", shortCircuit: true, source: 'export default "";' };
  }
  return nextLoad(url, context);
}
