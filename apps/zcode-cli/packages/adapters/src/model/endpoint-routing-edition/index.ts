import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

/**
 * FORK(upgrade-316)：上游把静态 endpoint routing 的实现放在
 * `official-coding-plan-gateway`（官方计费面，fork 已整体移除该文件）。
 * 上游语义是**条件路由**：只有命中 coding-plan 网关域名的请求才改写 origin。
 *
 * fork 下线官方账号/计费面后，不存在任何需要改写 origin 的模型请求；
 * 恒 routed:false（原样放行）才是与 fork 行为等价的实现。dev 真机实测：
 * 之前的「恒 routed:true + 固定 zcode.z.ai」把 bigmodel-api / 第三方 provider
 * 的请求全部改写到 zcode.z.ai，导致跨 provider 一致 404（Model request failed）。
 */
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    resolve(requestUrl: string) {
      return Promise.resolve({ routed: false as const, url: requestUrl });
    },
  };
}
