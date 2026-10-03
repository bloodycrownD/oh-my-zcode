type OAuthCallback = (url: string) => void | Promise<void>;

export function createOAuthCallbackHandler(callback: OAuthCallback) {
  return async (_event: unknown, url: string): Promise<void> => {
    try {
      await callback(url);
    } catch {
      // preload 只负责桥接 OAuth 回调，不能把 renderer 回调异常继续外抛成未处理 rejection。
      // 业务错误由 renderer 自己展示。
    }
  };
}
