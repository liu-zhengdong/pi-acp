# pi-acp

`pi-acp` connects the [`pi`](https://github.com/earendil-works/pi) coding agent to clients that support the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/overview/introduction).

It translates ACP JSON-RPC 2.0 messages over stdio into commands for `pi --mode rpc`. It then streams pi events back to the client.

本仓库基于 [regadas/pi-acp](https://github.com/regadas/pi-acp)，保留其与原始 [svkozak/pi-acp](https://github.com/svkozak/pi-acp) 的 Git 历史及 MIT 署名。新增能力是通过配套的 pi-mcp-adapter，为 ACP 会话增量接入外部 MCP 服务。

本 fork 尚未发布 npm 包，包名暂沿用 `@regadas/pi-acp`；请从本仓库构建，不要将 npm 的同名或无作用域包当作本实现。

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

This independently maintained version is not currently published in the ACP Registry or on npm. The Registry entry and unscoped `pi-acp` npm package install the upstream project, not this repository.

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

需要加载 [配套 pi-mcp-adapter](https://github.com/liu-zhengdong/pi-mcp-adapter)，其运行时注册回执必须支持 `toolExposure: "proxy-only"`。仅安装上游 2.34.0 不满足此条件；请在专用 Pi 配置目录中引用构建／检出的扩展，不覆盖日常全局安装。

客户端在 `session/new`、`session/load` 或 `session/resume` 中传入标准 `mcpServers` 描述，支持 stdio、Streamable HTTP 与 SSE。适配器会校验描述，通过 Pi 内部扩展命令进行运行时注册；注册命令不进入模型对话。

- 新建或重新启动的、带外部 MCP 的 Pi 子进程使用 `PI_MCP_TOOL_EXPOSURE=proxy-only`，不修改父进程环境或 MCP 配置文件。业务工具经固定 `mcp`／可选 `mcpScript` 发现和调用，不新增业务工具或 namespace 工具。
- 原有 MCP 服务仍可通过代理调用；名称冲突拒绝接入，不覆盖配置。失败时回滚本次注册，关闭时仅释放桥接持有的服务。
- 简短使用说明追加到下一轮上下文，具体参数从代理的发现／描述结果读取，不改写 system prompt。服务地址、headers 和 env 不加入这段说明。
- 服务列表以当前 ACP 请求为准；恢复时重新提供连接描述，不新增 pi-acp 自有的 MCP 配置存储。上游已有 Session 映射和 MCP adapter 的元数据缓存行为保持原样。
- 空列表保留原有启动方式，不强制安装 MCP adapter。已按普通模式运行的 Pi 不能原地变成固定代理模式；需要先关闭该会话的进程，再以非空列表恢复。代理模式只约束本 adapter 的 MCP 工具，不约束其他扩展。
- 本功能接入会话建立／恢复的服务列表，不提供运行中添加新 MCP 端点的独立 ACP 方法。已接入服务的工具目录变化继续使用 MCP 的通知与刷新机制。

本地确定性验收入口（真实 Pi 和 MCP adapter，模型输出为本地夹具，不调用外部模型）：

```bash
npm run build
PI_ACP_MCP_EXTENSION=/absolute/path/to/pi-mcp-adapter/index.ts npm run smoke:mcp
```

验收使用临时 Pi 配置，检查原服务保留、三种传输、动态工具、关闭后恢复、实际模型 `tools` 和 system prompt 的稳定性，以及坏输入拒绝。输出证据目录和源码哈希；脚本不改动用户原配置。

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

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally. Bash tool calls are rendered through Zed's `_meta.terminal_output` convention only when the client negotiates it; otherwise output is plain tool content.
- Terminal login is advertised only to clients that declare the (unstable) `clientCapabilities.auth.terminal` capability; Zed's `_meta["terminal-auth"]` launch banner additionally requires its matching client `_meta` flag.
- ACP MCP 依赖支持固定代理回执的配套 Pi 扩展；能力声明不代表环境已经安装它。缺少／不兼容 adapter、名称冲突、超大或畸形描述均明确失败，不返回缺少所请求工具的降级会话。
- ACP fork、steering/follow-up 方法、additional directories、subagent lineage、goals/AIR、交互终端 stdin 和 sandbox/approval modes 尚未声明，当前 Pi RPC 无法安全提供这些完整语义。 Adapter `/steering` and `/follow-up` commands only configure pi queue delivery modes.
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
