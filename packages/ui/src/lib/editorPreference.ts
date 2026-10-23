import type { EditorInfo } from "@zcode/shared";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_SELECTED_EDITOR_STORAGE_KEY = "zcode-last-editor-id";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastSelectedEditorId(
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  const rawValue = storage?.getItem(LAST_SELECTED_EDITOR_STORAGE_KEY);
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    return null;
  }

  return rawValue;
}

export function persistLastSelectedEditorId(
  editorId: string,
  storage: StorageLike | null = getBrowserStorage(),
) {
  storage?.setItem(LAST_SELECTED_EDITOR_STORAGE_KEY, editorId);
}

/**
 * 只有工作区级入口（IDE/终端/文件管理器）的选择才能写进全局「上次选择的编辑器」偏好。
 *
 * `fileApplication` 项（Preview/Acrobat/Word 等）是按文件扩展名临时出现的，
 * 选中它只代表「这次用这个 App 打开这个文件」，不代表工作区的默认编辑器；
 * 一旦落盘，读取侧（WorkspaceEditorButtonGroup / PreviewPane）就会把
 * 「VS Code」静默换成 Finder/资源管理器，且无法自愈。
 */
export function shouldPersistEditorSelection(editor: Pick<EditorInfo, "fileApplication">): boolean {
  return !editor.fileApplication;
}
