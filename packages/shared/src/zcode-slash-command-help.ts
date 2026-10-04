export type BuiltinZCodeSlashCommandHelpEntry = {
  aliases?: readonly string[];
  details: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export const BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES: readonly BuiltinZCodeSlashCommandHelpEntry[] =
  [
    {
      details: [
        "Shows command-center help locally without creating a session or sending a model prompt.",
        "Pass a command name with or without the leading slash for command-specific help.",
      ],
      name: "help",
      summary: "Show this slash command help.",
      usage: "/help [command]",
    },
    {
      details: [
        "Opens a Coding Plan setup picker when called without arguments.",
        "Z.ai and BigModel browser login poll for authorization, then securely save credentials and refresh available models.",
        "Manual API key variants accept the API key as an argument.",
      ],
      name: "login",
      summary: "Set up a Coding Plan provider.",
      usage:
        "/login [zai-coding-plan|bigmodel-coding-plan|zai-coding-plan-api-key <api-key>|bigmodel-coding-plan-api-key <api-key>]",
    },
    {
      details: ["Deletes Z.ai OAuth credentials from the shared ZCode credential store."],
      name: "logout",
      summary: "Remove the shared Z.ai login credentials.",
      usage: "/logout",
    },
    {
      details: [
        "Runs a normal agent turn that inspects the current workspace and creates or updates AGENTS.md.",
        "Existing AGENTS.md files should be edited rather than overwritten.",
        "This command targets the workspace root, not the user default ~/.omz/AGENTS.md.",
      ],
      name: "init",
      summary: "Create or update workspace AGENTS.md instructions.",
      usage: "/init [notes]",
    },
    {
      details: [
        "Starts a durable expert workflow in yolo mode when called with a task.",
        "Use status, resume, or stop to manage the latest or a named workflow run.",
      ],
      name: "expert",
      summary: "Run or manage the expert workflow.",
      usage: "/expert [status|resume|stop|<task>]",
    },
    {
      aliases: ["variant"],
      details: [
        "In the TUI, type /effort or /variant to open composer suggestions.",
        "Submitting the empty command or list shows the current and selectable efforts as text.",
        "Use a listed level to switch the current session reasoning effort.",
      ],
      name: "effort",
      summary: "Show or switch the current session reasoning effort.",
      usage: "/effort [list|<level>]",
    },
    {
      details: [
        "Lists this session's dynamic workflow runs with server-decided status and resumability.",
        "cancel without a run id cancels the only in-flight run, or lists candidates when there are several.",
        "resume asks the server; a run the server refuses reports the structured reason.",
      ],
      name: "dwf",
      summary: "List, cancel, or resume dynamic workflow runs.",
      usage: "/dwf [list|cancel [runId]|resume <runId>]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use latest or a specific checkpoint id to bypass the picker.",
      ],
      name: "fork",
      summary: "Fork a new session from a workspace checkpoint.",
      usage: "/fork [latest|checkpointId]",
    },
    {
      aliases: ["language"],
      details: [
        "Shows the current UI locale when called without arguments.",
        "Use auto, en-US, or zh-CN to switch and persist the UI locale.",
      ],
      name: "locale",
      summary: "Show or switch the UI locale.",
      usage: "/locale [auto|en-US|zh-CN]",
    },
    {
      details: [
        "Lists MCP server status by default.",
        "Use connect or disconnect with a configured server name to manage the session connection.",
      ],
      name: "mcp",
      summary: "Show or manage configured MCP servers.",
      usage: "/mcp [list|status|connect <server>|disconnect <server>]",
    },
    {
      aliases: ["plugin"],
      details: [
        "Opens a TUI plugin panel when called without arguments.",
        "Rows show ✓ for enabled plugins and ○ for disabled plugins.",
        "Use enable or disable with a plugin id to persist the switch in user config.",
        "Plugin capability changes apply to new sessions.",
      ],
      name: "plugins",
      summary: "Open the plugin manager.",
      usage: "/plugins [list|enable <plugin>|disable <plugin>]",
    },
    {
      details: [
        "Shows the current permission mode when submitted without arguments.",
        "Interactive TUI composer input opens a local picker before submit.",
        "Switchable modes are plan, build, edit, and yolo.",
        "Picker rows and explicit input submit /mode <mode> commands.",
      ],
      name: "mode",
      summary: "Show or switch the current permission mode.",
      usage: "/mode [plan|build|edit|yolo]",
    },
    {
      details: [
        "Shows the current and selectable models when called without arguments or with list.",
        "Use a provider/model id to select a model with its default reasoning effort; use /effort to change the effort.",
      ],
      name: "model",
      summary: "Show or switch the current session model.",
      usage: "/model [list|provider/model]",
    },
    {
      aliases: ["clear"],
      details: ["Starts a fresh root session and resets the TUI session projection."],
      name: "new",
      summary: "Start a fresh session in the TUI.",
      usage: "/new",
    },
    {
      aliases: ["continue"],
      details: [
        "In the TUI, opens a session picker when called without arguments.",
        "Resumes a specific session id when provided.",
        "/continue resumes the latest root session for the current directory.",
      ],
      name: "resume",
      summary: "Resume a saved session.",
      usage: "/resume [sessionId]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use status to show the latest checkpoint, or latest/a checkpoint id to restore directly.",
      ],
      name: "rewind",
      summary: "Inspect or restore workspace checkpoints.",
      usage: "/rewind [latest|checkpointId]",
    },
    {
      details: [
        "Without a name, lists discoverable skills for the current working directory.",
        "With a name, rewrites the next prompt so the Skill tool must load that skill first.",
      ],
      name: "skill",
      summary: "List skills, or force the next prompt to load one.",
      usage: "/skill [<skill-name> [task]]",
    },
    {
      aliases: ["target"],
      details: [
        "Shows the current session goal when called without arguments.",
        "Setting a new objective overwrites an existing goal; replace is an explicit alias.",
        "Use pause, resume, or clear to manage the current goal.",
      ],
      name: "goal",
      summary: "Show or set the current session goal.",
      usage: "/goal [pause|resume|clear|replace <objective>|<objective>]",
    },
    {
      details: [
        "Loads the dynamic-workflows skill, then writes a workflow script and submits it with CreateWorkflow.",
        "Runs as a normal agent turn; the workflow starts only after you confirm the script.",
        "In the desktop app the command is offered only while dynamic workflows are enabled for this client.",
      ],
      name: "workflow",
      summary: "Design and launch a dynamic workflow for a task.",
      usage: "/workflow [what the workflow should accomplish]",
    },
    // ── magic-context 本地控制命令（Step 22） ─────────────────────────────────
    // 这一组是**本地命令**：它们在 CLI/TUI 里就地执行，直接读 magic-context.db 或
    // 触发一次排队，**不**发一条模型提示。因此它们不是 bootstrap 展开的 prompt
    // 命令，也不进 App 的 `/` 面板（见 bootstrap/slash-command-surface.ts 的说明）。
    {
      details: [
        "Prints a text snapshot read straight from magic-context.db: the protected-token floor and last context usage, the compartment count and the last compacted message ordinal, and the active/dropped/compacted tag counts with the pending-operation queue depth.",
        "Read-only: it never writes, never compacts and never triggers a model turn.",
        "Shows the Magic Context status is unavailable notice when the store cannot be opened.",
      ],
      name: "ctx-status",
      summary: "Show the Magic Context status snapshot for this session.",
      usage: "/ctx-status",
    },
    {
      details: [
        'Queues the given tag numbers for reclaim. Accepts "3-5", "1,2,9" and "1-5,8,12-15".',
        "Stamping is not a delete: the item stays readable until Magic Context clears stamped items in one sweep, and the newest tags stay protected.",
        "The same invocation repeated with the same command id is answered from the idempotency ledger and is not queued twice.",
      ],
      name: "ctx-reduce",
      summary: "Queue context tags the work ahead no longer needs.",
      usage: "/ctx-reduce <tag-ids>",
    },
    {
      details: [
        "Recovers content that is no longer on the desk. Takes tag=N (a §N§ tag or a [dropped §N§] placeholder) to return one item whole, or message=N / start-end message ordinals to return a range.",
        "Tag numbers and message ordinals are never interchangeable: an ordinal counts whole messages, a tag counts each text and tool result separately.",
        "Ranges are capped at about 15K tokens; an oversized range returns the head and says where to continue.",
      ],
      name: "ctx-expand",
      summary: "Recover dropped or compacted context content.",
      usage: "/ctx-expand [tag=N | message=N | <start>-<end>]",
    },
    {
      details: [
        "Triggers one compartment recomputation pass for this session. Memories are not changed.",
        "This is the simplified first version: it schedules the recomputation and reports what the next pass will rebuild, rather than running a synchronous full rebuild.",
      ],
      name: "ctx-recomp",
      summary: "Trigger one compartment recomputation pass (simplified).",
      usage: "/ctx-recomp [full | <start>-<end>]",
    },
  ] as const;
