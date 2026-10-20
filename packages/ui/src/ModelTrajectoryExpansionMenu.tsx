import { Settings2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Switch } from "@/components/ui/switch.js";
import type { IntlShape } from "@/ModelTrajectoryPaneParts.js";
import {
  TRAJECTORY_EXPANSION_KINDS,
  type TrajectoryExpansionCommands,
} from "@/ModelTrajectoryExpansion.js";
import type { TrajectoryVisualRole } from "@/ModelTrajectoryRoleStyles.js";

export function ModelTrajectoryExpansionMenu({
  commands,
  onToggle,
  reasoningEnabled = true,
  intl,
}: {
  commands: TrajectoryExpansionCommands;
  onToggle: (kind: TrajectoryVisualRole) => void;
  /** 全局「显示思考过程」开关（B-3）：关闭时 reasoning 项禁用，且面板已做去 reasoning 投影。 */
  reasoningEnabled?: boolean;
  intl: IntlShape;
}) {
  const label = intl.formatMessage({ id: "modelTrajectory.customExpansion" });
  const reasoningDisabledTitle = intl.formatMessage({ id: "modelTrajectory.reasoningDisabled" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          data-trajectory-custom-expansion=""
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-foreground"
          aria-label={label}
          title={label}
        >
          <Settings2Icon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {TRAJECTORY_EXPANSION_KINDS.map((kind) => {
          const disabled = kind === "reasoning" && !reasoningEnabled;
          return (
            <DropdownMenuItem
              key={kind}
              data-trajectory-expansion-kind={kind}
              data-trajectory-expansion-disabled={disabled || undefined}
              className="justify-between"
              disabled={disabled}
              title={disabled ? reasoningDisabledTitle : undefined}
              onSelect={(event) => {
                event.preventDefault();
                if (disabled) return;
                onToggle(kind);
              }}
            >
              <span>{expansionKindLabel(kind, intl)}</span>
              <Switch
                size="sm"
                checked={commands[kind].expanded}
                disabled={disabled}
                className="pointer-events-none"
                aria-hidden="true"
                tabIndex={-1}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function expansionKindLabel(kind: TrajectoryVisualRole, intl: IntlShape): string {
  switch (kind) {
    case "turn":
      return intl.formatMessage({ id: "modelTrajectory.turn" });
    case "system":
    case "user":
    case "assistant":
      return intl.formatMessage({ id: `modelTrajectory.role.${kind}` });
    case "reasoning":
      return intl.formatMessage({ id: "modelTrajectory.reasoning" });
    case "tool-call":
      return intl.formatMessage({ id: "modelTrajectory.toolCall" });
    case "tool-result":
      return intl.formatMessage({ id: "modelTrajectory.role.tool" });
  }
}
