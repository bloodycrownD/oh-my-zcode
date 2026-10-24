import type { PaneSplitSide } from "@/v4/paneLayoutTree.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";

interface WorkbenchPointerDropTargetController {
  canDrop?: (payload: WorkbenchSessionDragPayload) => boolean;
  onDrop: (side: PaneSplitSide, payload: WorkbenchSessionDragPayload) => void;
  onPreview: (side: PaneSplitSide | null) => void;
}

interface WorkbenchPointerDropTarget {
  controller: WorkbenchPointerDropTargetController;
  element: HTMLElement;
}

const targets = new Set<WorkbenchPointerDropTarget>();
let previewedTarget: WorkbenchPointerDropTarget | null = null;

function clearPreview(): void {
  previewedTarget?.controller.onPreview(null);
  previewedTarget = null;
}

function registerWorkbenchPointerDropTarget(
  element: HTMLElement,
  controller: WorkbenchPointerDropTargetController,
): () => void {
  const target = { controller, element };
  targets.add(target);
  return () => {
    if (previewedTarget === target) {
      clearPreview();
    }
    targets.delete(target);
  };
}

export { registerWorkbenchPointerDropTarget };
