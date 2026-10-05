import { BUILTIN_CLIENT_SCENES } from "./builtin-templates.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

/**
 * FORK（D-6）：网络拉取 `/api/v1/client/scenes` 整删，改读随包内置模板清单。
 * 响应形状与原远端一致，两个消费方（AutomationsSection 模板区、useDraftSuggestedPromptItems
 * 的兜底）零改动。
 */
export function createClientScenesService(): IClientScenesService {
  return {
    list: async (): Promise<ClientScenesResponse> => ({
      code: 0,
      msg: "ok",
      data: BUILTIN_CLIENT_SCENES.map((scene) => ({
        ...scene,
        options: Object.fromEntries(
          Object.entries(scene.options).map(([key, option]) => [
            key,
            { ...option, items: option.items ? [...option.items] : undefined },
          ]),
        ),
      })),
    }),
  };
}