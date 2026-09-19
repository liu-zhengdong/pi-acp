# pi-acp

`pi-acp` connects the [`pi`](https://github.com/earendil-works/pi) coding agent to clients that support the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/overview/introduction).

It translates ACP JSON-RPC 2.0 messages over stdio into commands for `pi --mode rpc`. It then streams pi events back to the client.

本仓库基于 [regadas/pi-acp](https://github.com/regadas/pi-acp)，保留其与原始 [svkozak/pi-acp](https://github.com/svkozak/pi-acp) 的 Git 历史及 MIT 署名。新增能力包括 ACP 会话的外部 MCP 接入，以及运行中的 Pi 原进程发现、连接与消息投递。

本 fork 使用独立 npm 包名 `@liuser/pi-acp`，CLI 仍叫 `pi-acp`；不要将 `@regadas/pi-acp` 或无作用域同名包当作本实现。

```bash
npm install -g @liuser/pi-acp
pi install npm:@liuser/pi-mcp-adapter
```

第二条安装提供 MCP 能力的配套 Pi 扩展。仅使用后台 ACP 会话时，第一条 CLI 安装已经足够；需要日常 TUI 原进程接入时，再启用本包的通用 Pi 扩展，见下文。已有无作用域 MCP adapter 时，应先用 `pi remove npm:pi-mcp-adapter` 移除旧包的加载项，再安装 scoped 版本；MCP 配置和认证不需要迁移。

## 上游同步

GitHub Actions 每 6 小时检查 `regadas/pi-acp` 的最新稳定 GitHub Release，发现本仓库尚未包含的提交后创建草稿 PR。不会自动合入、发布 npm 或替换安装。

审阅差异、解决冲突后，点击 **Ready for review** 触发 CI，再决定合入。每个 tag 使用独立分支；已关闭的 PR 不重复创建，用户修改过的分支不被强推。仅 npm 发版但未创建 GitHub Release 的更新不在检测范围内。

手动检查：Actions → **上游版本同步** → **Run workflow**。默认 `dry_run=true`，只显示检查结果；取消勾选才会创建分支和 PR。

```bash
gh workflow run upstream-sync.yml -R liu-zhengdong/pi-acp --ref main -f dry_run=true
```

仓库需启用 Actions，并允许 GitHub Actions 创建 PR（设置项同时包含审批权限，但本流程不审批）。工作流只使用仓库 `GITHUB_TOKEN`；不需要个人 token。GitHub 对长期无活动的公共仓库可能停用定时工作流，届时需在 Actions 页面重新启用。

## Status

`pi-acp` 面向 ACP v1，使用 `@agentclientprotocol/sdk` 的 builder API，提供消息执行及会话列表、加载、恢复、关闭和删除。非空 `mcpServers` 通过支持固定代理模式的 pi-mcp-adapter 接入；缺少或不兼容的 adapter 会明确报错。接入条件见 [ACP 会话 MCP 服务](#acp-会话-mcp-服务)，其余边界见 [Limitations](#limitations)。

Development is centered around [Zed](https://zed.dev) editor support, and other clients may have varying levels of compatibility. Expect some minor breaking changes.

## Features

- Streams assistant text as ACP `agent_message_chunk` and extended thinking as `agent_thought_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Bash output uses Zed's negotiated `_meta.terminal_output` display convention when the client advertises it (`clientCapabilities._meta.terminal_output: true`); other clients receive the output as standard text content, so nothing is lost
  - Tool-result image content is preserved as ACP image content
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Stable ACP v1 session lifecycle
  - `session/list` discovers all known pi sessions or filters them by cwd
  - `session/load` restores a session and replays the complete active-branch history (via pi's `get_entries`) before responding: user text and images, assistant text, thinking, and tool calls, tool results, visible custom messages, and `!command` shell executions, including pre-compaction history
  - `session/resume` restores a session without replaying history
  - Model and thinking-level selection go through standard ACP session config options (`session/set_config_option`); available thinking levels come from pi's RPC API, with a model-metadata fallback only for pi 0.80.x. Legacy ACP session modes are not used
  - `session/close` cancels live work and releases the session subprocess while preserving history
  - `session/delete` idempotently closes and removes a persisted pi session
- Session persistence
  - pi stores its own sessions under its agent directory (normally `~/.pi/agent/sessions/...`)
  - `pi-acp` stores atomic per-session records under `~/.pi/pi-acp/session-map.json.d/` so concurrent adapter processes do not lose each other's mappings. An existing legacy `session-map.json` remains a read-only migration fallback; deletion tombstones prevent legacy entries from reappearing
- Slash commands are advertised from pi's authoritative `get_commands` result, plus a small set of adapter built-ins
- Pi owns project trust, prompt/template expansion, skills, extensions, and resource loading; the adapter does not scan project resources before pi applies trust policy
- Text embedded resources and valid image resources are preserved. Malformed images, audio, and unsupported binary MIME types are rejected before any prompt is sent
- Pi extension select/confirm UI maps to ACP permissions. Input/editor UI maps to unstable form elicitation only when the client negotiates it; otherwise pi receives cancellation
- Prompt responses publish cumulative token usage and context-window/cost updates when pi reports finite values
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js >= 22.19.0
- pi >= 0.80.4 installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

本 fork 已发布 npm 包 `@liuser/pi-acp`，安装命令见文首。尚未作为本 fork 独立登记到 ACP Registry；Registry 既有入口和无作用域 `pi-acp` npm 包不能当作本仓库版本。

### From source

```bash
git clone https://github.com/liu-zhengdong/pi-acp.git
cd pi-acp
npm ci
npm run build
```

To expose the existing `pi-acp` executable on your `PATH`, link the package:

```bash
npm link
```

Then configure a custom agent in [Zed](https://zed.dev/docs/agents/external-agents/):

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Alternatively, point Zed directly to the built entry point without linking it:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
}
```

### ACP 会话 MCP 服务

需要加载 [配套 pi-mcp-adapter](https://github.com/liu-zhengdong/pi-mcp-adapter)，npm 包为 `@liuser/pi-mcp-adapter`（本功能从 2.34.1 提供），运行时注册回执必须支持 `toolExposure: "proxy-only"`。仅安装上游无作用域包 2.34.0 不满足此条件。可通过 Pi 包管理器安装，也可在专用 Pi 配置目录中引用检出的扩展。

客户端在 `session/new`、`session/load` 或 `session/resume` 中传入标准 `mcpServers` 描述，支持 stdio、Streamable HTTP 与 SSE。适配器会校验描述，通过 Pi 内部扩展命令进行运行时注册；注册命令不进入模型对话。

- 新建或重新启动的、带外部 MCP 的 Pi 子进程使用 `PI_MCP_TOOL_EXPOSURE=proxy-only`，不修改父进程环境或 MCP 配置文件。业务工具经固定 `mcp`／可选 `mcpScript` 发现和调用，不新增业务工具或 namespace 工具。
- 原有 MCP 服务仍可通过代理调用；名称冲突拒绝接入，不覆盖配置。失败时回滚本次注册，关闭时仅释放桥接持有的服务。
- 简短使用说明追加到下一轮上下文，具体参数从代理的发现／描述结果读取，不改写 system prompt。服务地址、headers 和 env 不加入这段说明。
- 服务列表以当前 ACP 请求为准；恢复时重新提供连接描述，不新增 pi-acp 自有的 MCP 配置存储。上游已有 Session 映射和 MCP adapter 的元数据缓存行为保持原样。
- 空列表保留原有启动方式，不强制安装 MCP adapter。已按普通模式运行的 Pi 不能原地变成固定代理模式；需要先关闭该会话的进程，再以非空列表恢复。代理模式只约束本 adapter 的 MCP 工具，不约束其他扩展。
- 会话建立／恢复使用上述标准服务列表；运行中的增量接入使用下文 `runtime/v1`。已接入服务的工具目录变化继续使用 MCP 的通知与刷新机制。

本地确定性验收入口（真实 Pi 和 MCP adapter，模型输出为本地夹具，不调用外部模型）：

```bash
npm run build
PI_ACP_MCP_EXTENSION=/absolute/path/to/pi-mcp-adapter/index.ts npm run smoke:mcp
```

验收使用临时 Pi 配置，检查原服务保留、三种传输、动态工具、关闭后恢复、实际模型 `tools` 和 system prompt 的稳定性，以及坏输入拒绝。输出证据目录和源码哈希；脚本不改动用户原配置。

### 原进程接入与运行控制

本功能在 Pi 0.85.1 上实测。后台 RPC 沿用原入口；TUI 需要预先启用本包的通用扩展。从源码构建后，在该仓库执行：

```bash
pi install .
PI_MCP_TOOL_EXPOSURE=proxy-only pi
```

Pi 与 ACP 端需使用同一个 `PI_ACP_DIR`。MCP 接入还要求已经启用配套 adapter；扩展安装不替用户切换已有进程的工具暴露模式。未加载通用扩展的进程不会被发现。安装最新已发布 CLI 不代表含有尚未发布的本分支能力。

ACP `initialize` 的 `_meta["pi-acp/runtime/v1"]` 声明以下命名空间方法，不改变标准 `session/load` 等方法的含义：

| 方法                  | 参数与作用                                                                          |
| --------------------- | ----------------------------------------------------------------------------------- |
| `_pi/runtime/list`    | `{}`：列出本机 TUI 和当前 ACP 进程托管的 RPC，不返回连接凭据                        |
| `_pi/runtime/attach`  | `{runtimeId}` 或 `{sessionId}`：后者只选择本 ACP 托管的 RPC；返回完整状态           |
| `_pi/runtime/status`  | `{runtimeId,generation}`：读取当前 sessionId、sessionFile、cwd、busy、model、pid    |
| `_pi/runtime/deliver` | 目标字段加 `{sessionId,id,source,text,delivery,triggerTurn?}`：追加有来源的外部消息 |
| `_pi/runtime/mcp`     | 目标字段加 `{sessionId,mcpServers}`：增量注册服务                                   |
| `_pi/runtime/detach`  | `{runtimeId,generation}`：断开接入，不终止 TUI                                      |

### 运行事件

ACP `initialize` 通过 `_meta["pi-acp/runtime-events/v1"]` 声明 `_pi/runtime/events`。已接入的控制连接以 `{runtimeId,generation,sessionId,after?,limit?}` 分页读取事件；`after` 默认 0，`limit` 默认 50、最大 100。返回 `{runtimeId,generation,sessionId,items,nextAfter,hasMore,gap}`。

事件含序号、时间和类型：会话开始、回合开始／结束、工具开始／结束、完成的用户／助手文本及外部投递。工具开始保留参数，结束保留文本结果和错误标记；不采集逐 token 更新、思考内容、图片或工具 details。参数和结果可能包含工作区敏感正文，客户端应仅向获授权的审阅者展示。

缓冲按运行代际隔离，最多 512 条且不超过 1 MiB；单条文本最多 8,192 个字符，单页约 64 KiB。返回 `truncated` 表示文本截断，`gap` 表示早期事件已被淘汰，客户端不得补造缺失轨迹。扩展仅保留近期内存事件，长期保存由客户端负责。旧代际、无效游标及未接入的控制连接均被拒绝。

### 投递与连接语义

投递 `id` 使用 UUID，`delivery` 为 `steer` 或 `followUp`。`triggerTurn` 默认 true；false 仅抑制空闲时开启新回合，忙时仍按指定队列插入。返回 `accepted` 是入队确认，不是已读或处理完成。相同 ID 的相同内容在当前代际内去重，改写内容重用 ID 会被拒绝；去重表有界，不承诺跨崩溃的恰好一次执行。消息是 custom message，不展开外部正文中的 slash 命令，也不把另起的消息执行归到某个标准 ACP prompt 的返回值。

MCP 忙时只允许增量新增，不替换或移除现有服务；冲突拒绝、失败回滚。新服务说明作为消息进入后续模型上下文，工具参数仍按需通过固定代理描述；不修改 tools 或基础 system（包括自定义 SYSTEM.md）。地址、headers、env 不放入说明。

本机私有 IPC 与短期登记由 pi-acp 管理，无额外守护进程。一个实例同时只接受一个 ACP 控制连接，用户自己的终端仍可操作。断开时只释放本连接持有的服务，忙时等待安全清理；标准 `session/close` 仍负责关闭自己托管的后台进程。`/new`、`/reload` 后实例身份保留、代际更新，旧请求明确拒绝，客户端重新发现并接入。

历史会话迁移使用 `_pi/session/import`，参数 `{cwd,sessionFile}` 均为绝对路径，返回 `{sessionId}` 后再调用标准恢复入口。只读校验 Pi 会话头的 ID／工作目录后记录映射，不复制历史，不绕过单写者约束。

```bash
npm run build
PI_ACP_MCP_EXTENSION=/absolute/path/to/pi-mcp-adapter/index.ts npm run smoke:runtime
```

该入口使用真实 Pi TUI、本地确定性模型和真实 MCP，覆盖忙时接入与工具调用、消息来源、tools/system、回滚与旧代际拒绝；不代表模型自主决策质量。当前完整联调平台为 macOS，Windows 命名管道路径尚未实测。

### 具名身份与单实例

客户端可将长期身份与 Pi 会话、进程分开。ACP `initialize` 的 `_meta["pi-acp/identity/v1"]` 声明以下能力：

| 方法                 | 参数与作用                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `_pi/identity/start` | `{identityId,agentDirectory,cwd,sessionFile?}`：以独立配置创建／恢复后台 RPC，返回 `{runtimeId}`，再经 `runtime/v1` 接入 |
| `_pi/identity/stop`  | `{identityId}`：停止当前 ACP 连接启动的该身份 RPC；不终止外部 TUI                                                        |

`identityId` 为客户端持久分配的 UUID；`agentDirectory` 与 `cwd` 为已存在的绝对目录。配置目录需要预先启用本包通用扩展；有外部 MCP 时还需配套固定代理 adapter。启动时强制使用身份自己的配置与会话目录，最后会话位置保存在 pi-acp 状态目录中。实例状态额外返回 `identityId`；普通 Pi 为 `null`，不会因发现或连接自动获得长期身份。

原生 TUI 入口由同一包的 `@liuser/pi-acp/dist/identity.js` 导出 `runNamedTui({identityId,agentDirectory,cwd,sessionFile?})`，由客户端解析业务身份后调用，不接受任意 Pi 参数。TUI 和 RPC 共用占用机制：从启动前到实际进程退出全程持有；断开 ACP、网络超时、忙碌或切换会话都不释放身份。重启默认恢复该身份的最后会话，历史会话初次迁移可提供 `sessionFile`。

占用记录位于同一 `PI_ACP_DIR/identities/`；不同状态目录不属于同一个互斥范围。重复启动返回占用 PID 与工作目录，不抢占已有进程。只有已知父子进程均退出才回收旧记录；启动中断、损坏记录或残留 guard 采用保守拒绝，需要先确认相关进程状态再人工处理。这里是受信任单用户环境的生命周期约束，不是对有本机文件权限者的安全沙箱。

本机真实 Pi 验证由 Atrium 的 `npm run test:pi` 覆盖：实际 CLI、TUI/RPC 交叉占用、原生 `/new`、退出重启及同一聊天延续；本仓库单元测试另覆盖坏输入、损坏／模糊占用和身份指针不向子进程继承。当前具名流程在 macOS 实测，Windows 具名 TUI 尚未验证。

### Environment variables

- `PI_ACP_DIR=/path/to/state` overrides the adapter-owned state directory (default: `~/.pi/pi-acp`).
- `PI_CODING_AGENT_DIR=/path/to/agent` overrides pi's global agent directory for settings, sessions, prompts, extensions, and skills (default: `~/.pi/agent`).
- `PI_CODING_AGENT_SESSION_DIR` selects pi's custom session directory. Otherwise merged global/project `sessionDir` settings apply, then pi's cwd-encoded default. `~` expands and relative custom paths resolve from the session cwd.

### Slash commands

`pi-acp` supports slash commands:

Pi discovers and expands file prompts, skills, and extension commands after applying its own project trust policy. `pi-acp` advertises the resulting command list without reading prompt files itself.

#### Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - maps to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to the thinking (`thought_level`) config option selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

Pi-provided skill and extension commands appear when pi includes them in `get_commands`.

## Authentication (ACP client support)

This agent supports **Terminal Auth** for ACP clients that negotiate it.
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run typecheck
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)
- `src/runtime/*` – 通用原进程入口、私有 IPC 与按 ACP 连接隔离的控制门面

源码 Git 依赖使用 `prepare` 构建 dist；注册表安装使用打包后的 dist，不要求用户编译。

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally. Bash tool calls are rendered through Zed's `_meta.terminal_output` convention only when the client negotiates it; otherwise output is plain tool content.
- Terminal login is advertised only to clients that declare the (unstable) `clientCapabilities.auth.terminal` capability; Zed's `_meta["terminal-auth"]` launch banner additionally requires its matching client `_meta` flag.
- ACP MCP 依赖支持固定代理回执的配套 Pi 扩展；能力声明不代表环境已经安装它。缺少／不兼容 adapter、名称冲突、超大或畸形描述均明确失败，不返回缺少所请求工具的降级会话。
- 标准 ACP fork、steering/follow-up 方法、additional directories、subagent lineage、goals/AIR、交互终端 stdin 和 sandbox/approval modes 尚未声明；本包的外部消息投递走独立 `runtime/v1`，不宣称具备这些完整标准语义。 Adapter `/steering` and `/follow-up` commands only configure pi queue delivery modes.
- On Windows, native executables launch directly. `.cmd`/`.bat` launchers necessarily pass through `cmd.exe`; pi-acp builds an escaped argument boundary and never enables Node's `shell` mode.
- Additional workspace directories are not supported: the `sessionCapabilities.additionalDirectories` capability is not advertised, and `session/new`, `session/load`, and `session/resume` requests carrying a non-empty `additionalDirectories` list are rejected with `invalid params` instead of silently dropping the extra roots. The session's `cwd` remains the only workspace root.
- Pi session files do not coordinate concurrent writers: each pi process keeps its own in-memory view while appending to the shared history. `pi-acp` inherits this constraint, so simultaneously operating on the same persisted session from multiple `pi-acp` or pi processes is unsupported. Atomic adapter mapping records prevent cross-process map updates from being lost, but they are not a session-ownership lease; keep one active writer per persisted session to prevent divergent or damaged history.
- Assistant text streams as `agent_message_chunk`; extended thinking streams separately as `agent_thought_chunk`.
- Prompt queueing is a local FIFO in the adapter (one pi prompt at a time, like pi's `one-at-a-time`). Because pi extensions can start their own runs, dispatch waits for observed out-of-band pi activity to settle and fails closed if that admission wait expires. Every prompt also carries pi's non-interrupting `streamingBehavior: 'followUp'` so an unobserved dispatch race is queued by pi instead of rejected; pi output remains unowned until the prompt's response or queued user-message boundary. Ambiguous nested run lifecycles are quarantined rather than attributed to the wrong ACP turn. If an extension command starts and finishes a run before pi acknowledges the command prompt, that run's turn-bound stream is suppressed because Pi RPC exposes no correlation ID. Adapter-handled built-in commands (`/compact`, `/name`, ...) share the same FIFO: they wait for an active prompt and hold later prompts back while they run. pi's `abort` stops an agent run but cannot cancel an in-flight manual RPC (compaction, export, ...), so `session/cancel` fails closed instead: a command still waiting on pi has its channel quarantined, the request settles as `cancelled` with no partial result reported, and the next request restores the session on a fresh pi subprocess. A command with no pi work in flight is settled locally and leaves the subprocess untouched.
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)). This project originated from [svkozak/pi-acp](https://github.com/svkozak/pi-acp) and retains its original copyright and license attribution; independently maintained changes are attributed separately.

### Auxiliary manual probes

`npm run smoke` remains an isolated, non-provider initialize/new/builtin/cancel/shutdown check.
After `npm run build`, the other `scripts/smoke-*.mjs` entrypoints are manual probes, not CI coverage.
Use disposable `PI_CODING_AGENT_DIR`, `PI_ACP_DIR`, and `PI_CODING_AGENT_SESSION_DIR` directories.
`smoke-compact.mjs`, `smoke-export.mjs`, and `smoke-acp-load.mjs` can generate provider traffic and require
`PI_ACP_MANUAL_PROVIDER=1` plus configured credentials. All probes assert responses and have finite deadlines.
