// 照搬上游 v3.16.2（upstream-v316-fullsync P7 末批，拍板 B）并 omz 化：
// legacySingleRoot 的可用性回传（onLegacyCapability）随 backlog-sweep Step 4 落地——
// ProjectEditor 需要它决定单根退回设备的升级提示；列表自身的创建闸门与文案属 Step 6。
import { formatProjectError } from "@/project-sidebar/view.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type {
  IProjectService,
  IRemoteProjectService,
  RemoteProjectHost,
  VirtualProject,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteProjectList({
  host,
  service,
  remoteService,
  onClose,
  onSaved,
  initialRoots,
  device,
  embedded = false,
  onBeforeAdd,
  onLegacyCapability,
  renderCreate,
}: {
  host?: RemoteProjectHost;
  device?: ProjectDevice;
  embedded?: boolean;
  onBeforeAdd?(isCurrent: () => boolean): Promise<RemoteProjectHost>;
  onLegacyCapability?(legacy: boolean): void;
  renderCreate?(
    projects: VirtualProject[],
    add: (project: VirtualProject) => Promise<void>,
    close: () => void,
  ): ReactNode;
  service: IProjectService;
  remoteService: IRemoteProjectService;
  onClose(): void;
  onSaved(isCurrent?: () => boolean): Promise<void>;
  initialRoots?: string[];
}) {
  const hostId = device?.id ?? host!.id;
  const scope = `${hostId}:${host?.membershipId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const current = () => active.current && scopeRef.current === scope;
  // 回调以 ref 转发：父级每次渲染重建闭包不能触发重新读取目录，也不能漏掉最新回调。
  const capabilityCallback = useRef(onLegacyCapability);
  capabilityCallback.current = onLegacyCapability;
  const sidebar = useOptionalProjectDirectory();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const [projects, setProjects] = useState<VirtualProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(initialRoots !== undefined);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setProjects([]);
    void service
      .readTree({ hostId, includeDeleted: true })
      .then((tree) => {
        if (active) setProjects(tree.projects.filter((project) => project.hostId === hostId));
        // 能力回传：单根退回设备不能新建项目组织入口（Step 6 落列表自身的可见闸门）。
        capabilityCallback.current?.(Boolean(tree.legacySingleRoot));
      })
      .catch((cause) => {
        if (active) setError(formatProjectError(cause, intl.formatMessage));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [service, hostId, scope, retry, intl]);
  const add = async (project: VirtualProject) => {
    if (!current()) throw new Error("project.creation-cancelled");
    // 原因：返回草稿或成员换代后，旧选择不得再登记入口或关闭新的流程。
    const selectedHost = onBeforeAdd ? await onBeforeAdd(current) : host;
    if (!current()) return;
    const directory = await remoteService.readDirectory();
    if (!current()) throw new Error("project.creation-cancelled");
    if (
      !directory.hosts.some(
        (item) => item.id === hostId && item.membershipId === selectedHost?.membershipId,
      )
    )
      throw new Error("remote-project.host-removed");
    await remoteService.addEntry({
      hostId,
      expectedMembershipId: selectedHost?.membershipId,
      project: { projectId: project.id, name: project.name, roots: project.roots },
    });
    if (!current()) return;
    sidebar?.preferences.prepend(project);
    await onSaved(current);
    if (current()) onClose();
  };
  if (host && !embedded && creating && !loading && !error && renderCreate)
    return renderCreate(projects, add, () => setCreating(false));
  const content = (
    <>
      {/* 内嵌页的返回入口原在列表底部，列表变长后会被挤到下方；放到标题左侧与目录浏览器的返回习惯一致。 */}
      {embedded ? (
        <div className="flex min-w-0 items-center gap-1.5 pr-8">
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-1 text-foreground-subtle"
            data-testid="remote-project-back"
            aria-label={msg("backToCreate")}
            title={msg("backToCreate")}
            onClick={onClose}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <DialogTitle>{msg("addRemoteProject")}</DialogTitle>
        </div>
      ) : (
        <DialogTitle>{msg("addRemoteProject")}</DialogTitle>
      )}
      <DialogDescription>
        {device?.label ?? (host ? remoteHostLabel(host) : hostId)}
      </DialogDescription>
      {/* 多行名称曾被 max-height 下的 auto 轨道压到最小行高；按内容定高再滚动，避免上下裁切。 */}
      <div className="grid auto-rows-max max-h-72 gap-1 overflow-y-auto">
        {projects
          .filter((project) => !project.deleted)
          .map((project) => (
            <Button
              key={project.id}
              variant="ghost"
              className="h-auto min-h-12 justify-start whitespace-normal text-left"
              data-project-id={project.id}
              disabled={saving}
              data-testid="remote-project-pick"
              onClick={() => {
                setSaving(true);
                setError(null);
                void add(project)
                  .catch((cause) => {
                    if (current()) setError(formatProjectError(cause, intl.formatMessage));
                  })
                  .finally(() => {
                    if (current()) setSaving(false);
                  });
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words">{project.name}</span>
                <span className="block break-all font-mono text-ui-sm text-foreground-subtle">
                  {project.roots.map((root) => root.rootPath).join(", ")}
                </span>
              </span>
            </Button>
          ))}
      </div>
      {loading ? <p>{intl.formatMessage({ id: "common.loading" })}</p> : null}
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!loading && !error && !projects.some((project) => !project.deleted) ? (
        <p className="text-ui-sm text-foreground-subtle">{msg("noExistingProjects")}</p>
      ) : null}
      {error ? (
        <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      ) : null}
      {embedded ? null : (
        <Button
          disabled={loading || saving || Boolean(error)}
          data-testid="remote-project-new"
          onClick={() => setCreating(true)}
        >
          {msg("new")}
        </Button>
      )}
    </>
  );
  return embedded ? (
    content
  ) : (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">{content}</DialogContent>
    </Dialog>
  );
}
