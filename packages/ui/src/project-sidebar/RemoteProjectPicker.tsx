// 照搬上游 v3.16.2 project-sidebar/RemoteProjectPicker.tsx（backlog-sweep Step 4 真链）。
// 与上游差异：无。创建表单必须拿到 host（hostId 来源）与 initialRoots（进入创建态的信号）——
// 不传时 RemoteProjectList 不会切创建态，ProjectEditor 保存也不带 hostId（服务端按 local 路由）。
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
          host={props.host}
          initialRoots={props.initialRoots}
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
