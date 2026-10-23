// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批，拍板 B：Remote* 组件与同步链回填）。
// omz：ProjectEditor 为 P4 本机形态（无 host/initialRoots/remoteService 设备面）——
// 远端创建表单的设备选择随 P3 vproj-storage 批回补。
import type { ComponentProps } from "react";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { RemoteProjectList } from "@/project-sidebar/RemoteProjectList.js";

/** 旧连接/项目入口继续保留新建能力；创建表单只复用列表，避免两个草稿 owner。 */
export function RemoteProjectPicker(
  props: Omit<ComponentProps<typeof RemoteProjectList>, "renderCreate">,
) {
  return (
    <RemoteProjectList
      {...props}
      renderCreate={(projects, add, close) => (
        <ProjectEditor
          project={null}
          projects={projects}
          service={props.service}
          onClose={close}
          onSaved={add}
        />
      )}
    />
  );
}
