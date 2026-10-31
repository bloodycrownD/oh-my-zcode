import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/**
 * 左下角共享槽位：整个 UI 中唯一消费全局通知的挂载点，保持 feature 模块之间互不 import。
 *
 * FORK (upgrade-316): marketing-touch（领 token banner / 营销触达）已整体移除，
 * 原先「banner 独占槽位」的仲裁逻辑随之删除；槽位只剩 highspeed 全局通知一条来源，
 * 不再需要跨系统优先级。不可见时 GlobalNoticeSurface 返回 null，不产生多余 DOM。
 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  // 未注入时走 GlobalNoticeSurface 默认的 browserGlobalNoticeStore。
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
