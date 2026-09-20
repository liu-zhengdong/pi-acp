#!/usr/bin/env node

// src/index.ts
import { ndJsonStream as ndJsonStream2 } from "@agentclientprotocol/sdk";

// src/runtime/transport.ts
import { randomUUID } from "crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join as join2 } from "path";
import { connect } from "net";
import { Duplex } from "stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

// src/acp/paths.ts
import { homedir } from "os";
import { join, resolve } from "path";
function getPiAcpDir() {
  return process.env.PI_ACP_DIR ? resolve(process.env.PI_ACP_DIR) : join(homedir(), ".pi", "pi-acp");
}
function getPiAcpSessionMapPath() {
  return join(getPiAcpDir(), "session-map.json");
}

// src/pi-rpc/mcp-servers.ts
var MCP_COMMAND = "pi-acp-mcp";
var MCP_WIDGET = "pi-acp-mcp-result";
var MAX_MCP_REQUEST_BYTES = 1024 * 1024;
var McpConfigurationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "McpConfigurationError";
  }
  code;
};
function invalid(index, field) {
  throw new McpConfigurationError("INVALID_MCP_SERVERS", `MCP \u670D\u52A1 ${index + 1} \u7684 ${field} \u65E0\u6548`);
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function pairs(value, index, field) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) invalid(index, field);
  const seen = /* @__PURE__ */ new Set();
  return value.map((entry) => {
    if (!record(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") invalid(index, field);
    const name = entry.name;
    const validName = field === "env" ? /^[^=\s\0]+$/.test(name) : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
    const key = field === "headers" ? name.toLowerCase() : name;
    if (!validName || seen.has(key) || entry.value.includes("\0")) invalid(index, field);
    if (field === "headers" && /[\r\n]/.test(entry.value)) invalid(index, field);
    seen.add(key);
    return { name, value: entry.value };
  });
}
function parseMcpServers(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) throw new McpConfigurationError("INVALID_MCP_SERVERS", "mcpServers \u5FC5\u987B\u662F\u6570\u7EC4");
  const names = /* @__PURE__ */ new Set();
  const servers = value.map((entry, index) => {
    if (!record(entry)) invalid(index, "\u5B9A\u4E49");
    if (typeof entry.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entry.name) || ["__proto__", "prototype", "constructor"].includes(entry.name) || names.has(entry.name))
      invalid(index, "name\uFF08\u5FC5\u987B\u552F\u4E00\u4E14\u4E0D\u542B\u7A7A\u767D\u6216\u63A7\u5236\u5B57\u7B26\uFF09");
    names.add(entry.name);
    if (entry.type === "http" || entry.type === "sse") {
      if (typeof entry.url !== "string" || entry.command !== void 0) invalid(index, "url");
      try {
        const url = new URL(entry.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
          invalid(index, "url");
      } catch {
        invalid(index, "url");
      }
      return { name: entry.name, type: entry.type, url: entry.url, headers: pairs(entry.headers, index, "headers") };
    }
    if (entry.type !== void 0 && entry.type !== "stdio") invalid(index, "type");
    if (typeof entry.command !== "string" || !entry.command.trim() || entry.command.includes("\0") || entry.url !== void 0)
      invalid(index, "command");
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) invalid(index, "args");
    return { name: entry.name, command: entry.command, args: [...args], env: pairs(entry.env, index, "env") };
  });
  if (Buffer.byteLength(JSON.stringify(servers)) > MAX_MCP_REQUEST_BYTES)
    throw new McpConfigurationError("INVALID_MCP_SERVERS", "mcpServers \u8D85\u8FC7 1 MiB \u4E0A\u9650");
  return servers;
}

// src/runtime/transport.ts
var RUNTIME_CAPABILITY = "pi-acp/runtime/v1";
var runtimeMethods = {
  list: "_pi/runtime/list",
  attach: "_pi/runtime/attach",
  status: "_pi/runtime/status",
  events: "_pi/runtime/events",
  deliver: "_pi/runtime/deliver",
  mcp: "_pi/runtime/mcp",
  detach: "_pi/runtime/detach"
};
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}
function string(value, max = 4096) {
  if (typeof value !== "string" || !value.length || value.length > max) throw new Error("Invalid string");
  return value;
}
function uuid(value) {
  const id = string(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid identity");
  return id;
}
function runtimeDirectory() {
  const dir = join2(getPiAcpDir(), "runtimes");
  mkdirSync(dir, { recursive: true, mode: 448 });
  const stat2 = lstatSync(dir);
  if (!stat2.isDirectory() || process.getuid && stat2.uid !== process.getuid())
    throw new Error("Unsafe runtime directory");
  if (process.platform !== "win32") chmodSync(dir, 448);
  return dir;
}
function recordPath(id) {
  return join2(runtimeDirectory(), `${uuid(id)}.json`);
}
function readRuntime(id) {
  const path = recordPath(id), stat2 = lstatSync(path);
  if (!stat2.isFile() || stat2.size > 16384 || process.getuid && (stat2.uid !== process.getuid() || stat2.mode & 63))
    throw new Error("Unsafe runtime record");
  const r = object(JSON.parse(readFileSync(path, "utf8")));
  if (uuid(r.runtimeId) !== id || !Number.isSafeInteger(r.pid) || Number(r.pid) <= 0 || !["rpc", "tui"].includes(String(r.mode)))
    throw new Error("Invalid runtime record");
  uuid(r.generation);
  uuid(r.sessionId);
  if (r.identityId !== void 0 && r.identityId !== null) uuid(r.identityId);
  string(r.cwd);
  string(r.endpoint);
  string(r.token, 128);
  if (r.ownerPid !== null && (!Number.isSafeInteger(r.ownerPid) || Number(r.ownerPid) <= 0))
    throw new Error("Invalid runtime owner");
  const expected = socketEndpoint(id);
  if (r.endpoint !== expected) throw new Error("Unexpected runtime endpoint");
  return r;
}
function discoverRuntimes() {
  return readdirSync(runtimeDirectory()).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 256).flatMap((name) => {
    try {
      const r = readRuntime(name.slice(0, -5));
      process.kill(r.pid, 0);
      if (r.mode === "rpc" && r.ownerPid !== process.pid) return [];
      const { endpoint: _endpoint, token: _token, ...publicRecord } = r;
      return [publicRecord];
    } catch {
      return [];
    }
  });
}
function socketEndpoint(id) {
  uuid(id);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-acp-${id}`;
  const dir = `/tmp/pi-acp-${process.getuid()}`;
  mkdirSync(dir, { recursive: true, mode: 448 });
  const stat2 = lstatSync(dir);
  if (!stat2.isDirectory() || stat2.uid !== process.getuid()) throw new Error("Unsafe socket directory");
  chmodSync(dir, 448);
  return join2(dir, `${id}.sock`);
}
function socketStream(socket) {
  let bytes = 0;
  socket.on("data", (chunk) => {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) >= 0) {
      if (bytes + end - start > MAX_MCP_REQUEST_BYTES + 16384) {
        socket.destroy(new Error("Runtime record too large"));
        return;
      }
      bytes = 0;
      start = end + 1;
    }
    bytes += chunk.length - start;
    if (bytes > MAX_MCP_REQUEST_BYTES + 16384) socket.destroy(new Error("Runtime record too large"));
  });
  const streams = Duplex.toWeb(socket);
  return ndJsonStream(streams.writable, streams.readable);
}
async function runtimeRequest(connection, method, params) {
  const deadline = setTimeout(() => connection.close(new Error("Runtime request timed out")), 1e4).unref();
  try {
    return await connection.agent.request(method, params);
  } finally {
    clearTimeout(deadline);
  }
}
var RuntimeClient = class _RuntimeClient {
  constructor(record2, socket) {
    this.record = record2;
    this.socket = socket;
    this.connection = client({ name: "pi-acp-runtime-client" }).connect(socketStream(socket));
    void this.connection.closed.catch(() => void 0);
  }
  record;
  socket;
  connection;
  static async open(id) {
    const record2 = readRuntime(id);
    if (record2.mode === "rpc" && record2.ownerPid !== process.pid)
      throw new Error("Runtime belongs to another ACP process");
    const socket = connect(record2.endpoint);
    socket.on("error", () => void 0);
    const peer = new _RuntimeClient(record2, socket);
    try {
      await runtimeRequest(peer.connection, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { token: record2.token }
      });
      return peer;
    } catch (error) {
      peer.close();
      throw error;
    }
  }
  request(method, params = {}) {
    return runtimeRequest(this.connection, method, {
      ...params,
      runtimeId: this.record.runtimeId,
      generation: this.record.generation
    });
  }
  close() {
    this.connection.close();
    this.socket.destroy();
  }
};

// src/runtime/events.ts
var EVENTS_CAPABILITY = "pi-acp/runtime-events/v1";

// src/acp/app.ts
import {
  agent as acpAgent,
  methods as methods2,
  RequestError as RequestError10
} from "@agentclientprotocol/sdk";

// src/acp/agent.ts
import {
  PROTOCOL_VERSION as PROTOCOL_VERSION2,
  RequestError as RequestError9
} from "@agentclientprotocol/sdk";

// src/acp/auth.ts
var PI_SETUP_METHOD_ID = "pi_terminal_login";
function getAuthMethods(opts) {
  const supportsTerminalAuth = opts?.supportsTerminalAuth ?? false;
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? false;
  if (!supportsTerminalAuth) return [];
  const method = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login",
    type: "terminal",
    args: ["--terminal-login"],
    env: {}
  };
  if (supportsTerminalAuthMeta) {
    const launch = terminalAuthLaunchSpec();
    method._meta = {
      ...method._meta ?? {},
      "terminal-auth": {
        ...launch,
        label: "Launch pi"
      }
    };
  }
  return [method];
}
function terminalAuthLaunchSpec() {
  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }
  return { command: "pi-acp", args: ["--terminal-login"] };
}

// src/acp/builtin-commands.ts
import { RequestError } from "@agentclientprotocol/sdk";
import { open } from "fs/promises";
import { join as join3 } from "path";
import { pathToFileURL } from "url";
function builtinAvailableCommands() {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" }
    },
    { name: "autocompact", description: "Toggle automatic context compaction", input: { hint: "on|off|toggle" } },
    { name: "export", description: "Export session to an HTML file in the session cwd" },
    { name: "session", description: "Show session stats (messages, tokens, cost, session file)" },
    { name: "name", description: "Set session display name", input: { hint: "<name>" } },
    {
      name: "steering",
      description: "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "follow-up",
      description: "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    }
  ];
}
var AUTOCOMPACT_ON_ALIASES = /* @__PURE__ */ new Set(["on", "true", "enable", "enabled"]);
var AUTOCOMPACT_OFF_ALIASES = /* @__PURE__ */ new Set(["off", "false", "disable", "disabled"]);
var EXPORT_PREFLIGHT_LIMIT = 64 * 1024;
async function hasExportableSessionFile(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(EXPORT_PREFLIGHT_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").trim().length > 0;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function runBuiltinCommand(session, cmd, args, ctx) {
  if (cmd === "compact") {
    const customInstructions = args.join(" ").trim() || void 0;
    const res = await session.proc.compact(customInstructions);
    const r = res && typeof res === "object" ? res : null;
    const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
    const summary = typeof r?.summary === "string" ? r.summary : null;
    const headerLines = [
      `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
      tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
    ].filter(Boolean);
    const text = headerLines.join("\n") + (summary ? `

${summary}` : "");
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text }
      }
    });
    return { stopReason: "end_turn" };
  }
  if (cmd === "session") {
    const stats = await session.proc.getSessionStats();
    const lines = [];
    if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`);
    if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
    if (typeof stats?.totalMessages === "number") lines.push(`Messages: ${stats.totalMessages}`);
    if (typeof stats?.cost === "number") lines.push(`Cost: ${stats.cost}`);
    const t = stats?.tokens;
    if (t && typeof t === "object") {
      const parts = [];
      if (typeof t.input === "number") parts.push(`in ${t.input}`);
      if (typeof t.output === "number") parts.push(`out ${t.output}`);
      if (typeof t.cacheRead === "number") parts.push(`cache read ${t.cacheRead}`);
      if (typeof t.cacheWrite === "number") parts.push(`cache write ${t.cacheWrite}`);
      if (typeof t.total === "number") parts.push(`total ${t.total}`);
      if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
    }
    const text = lines.length ? lines.join("\n") : `Session stats:
${JSON.stringify(stats, null, 2)}`;
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text }
      }
    });
    return { stopReason: "end_turn" };
  }
  if (cmd === "name") {
    const name = args.join(" ").trim();
    if (!name) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Usage: /name <name>" }
        }
      });
      return { stopReason: "end_turn" };
    }
    try {
      await session.proc.setSessionName(name);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      const hint = /set_session_name/i.test(msg) ? " This requires a newer pi version that supports `set_session_name` in RPC mode." : "";
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Failed to set session name: ${msg}${hint}` }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (ctx.cancelled()) return { stopReason: "end_turn" };
    await session.syncSessionInfo(name, ctx.cancelled);
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Session name set: ${name}` }
      }
    });
    return { stopReason: "end_turn" };
  }
  if (cmd === "steering") {
    const modeRaw = String(args[0] ?? "").toLowerCase();
    const state = await session.proc.getState();
    const current = String(state?.steeringMode ?? "");
    if (!modeRaw) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Steering mode: ${current || "unknown"}`
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Usage: /steering all | /steering one-at-a-time"
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (ctx.cancelled()) return { stopReason: "end_turn" };
    await session.proc.setSteeringMode(modeRaw);
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Steering mode set to: ${modeRaw}` }
      }
    });
    return { stopReason: "end_turn" };
  }
  if (cmd === "follow-up") {
    const modeRaw = String(args[0] ?? "").toLowerCase();
    const state = await session.proc.getState();
    const current = String(state?.followUpMode ?? "");
    if (!modeRaw) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Follow-up mode: ${current || "unknown"}`
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Usage: /follow-up all | /follow-up one-at-a-time"
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (ctx.cancelled()) return { stopReason: "end_turn" };
    await session.proc.setFollowUpMode(modeRaw);
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` }
      }
    });
    return { stopReason: "end_turn" };
  }
  if (cmd === "export") {
    const state = await session.proc.getState();
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
    const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;
    if (!sessionFile || messageCount === 0 || !await hasExportableSessionFile(sessionFile)) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Nothing to export yet (no session messages). Send a prompt first."
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const outputPath = join3(session.cwd, `pi-session-${safeSessionId}.html`);
    if (ctx.cancelled()) return { stopReason: "end_turn" };
    let resultPath = "";
    try {
      const result = await session.proc.exportHtml(outputPath);
      resultPath = result.path;
    } catch (e) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Export failed: ${String(e instanceof Error ? e.message : e)}`
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (!resultPath) {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Export failed: no output path returned by pi."
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    const uri = pathToFileURL(resultPath).href;
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Session exported: "
        }
      }
    });
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "resource_link",
          name: `pi-session-${safeSessionId}.html`,
          uri,
          mimeType: "text/html",
          title: "Session exported"
        }
      }
    });
    return { stopReason: "end_turn" };
  }
  if (cmd === "autocompact") {
    const mode = (args[0] ?? "toggle").toLowerCase();
    let enabled;
    if (AUTOCOMPACT_ON_ALIASES.has(mode)) {
      enabled = true;
    } else if (AUTOCOMPACT_OFF_ALIASES.has(mode)) {
      enabled = false;
    } else if (mode === "toggle") {
      const state = await session.proc.getState();
      enabled = !state?.autoCompactionEnabled;
    } else {
      await ctx.sendSessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Unknown argument: ${args[0]}. Usage: /autocompact on | off | toggle`
          }
        }
      });
      return { stopReason: "end_turn" };
    }
    if (ctx.cancelled()) return { stopReason: "end_turn" };
    await session.proc.setAutoCompaction(enabled);
    await ctx.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`
        }
      }
    });
    return { stopReason: "end_turn" };
  }
  throw RequestError.internalError({ command: cmd }, `Unhandled builtin command: /${cmd}`);
}

// src/acp/history-replay.ts
import { RequestError as RequestError2 } from "@agentclientprotocol/sdk";

// src/acp/translate/pi-messages.ts
function translateAssistantContent(content) {
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const raw of content) {
    const block = raw;
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      blocks.push({ kind: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking") {
      const text = typeof block.thinking === "string" && block.thinking ? block.thinking : typeof block.text === "string" ? block.text : "";
      if (text) blocks.push({ kind: "thinking", text });
      continue;
    }
    if (block.type === "toolCall" && typeof block.id === "string" && block.id) {
      blocks.push({
        kind: "toolCall",
        toolCallId: block.id,
        toolName: typeof block.name === "string" && block.name ? block.name : "tool",
        rawInput: block.arguments ?? null
      });
    }
  }
  return blocks;
}
function translateCustomMessageContent(content) {
  const merged = [];
  for (const block of translateUserContent(content)) {
    const last = merged[merged.length - 1];
    if (block.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: last.text + block.text };
    } else {
      merged.push(block);
    }
  }
  return merged;
}
function translateUserContent(content) {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const raw of content) {
    const block = raw;
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      blocks.push({ kind: "text", text: block.text });
    } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      blocks.push({ kind: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

// src/acp/translate/pi-tools.ts
function toolResultImageBlocks(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const raw of content) {
    const block = raw;
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      images.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return images;
}
function toolResultContentBlocks(result) {
  if (!result) return [];
  const record2 = result;
  const details = record2.details;
  const ordered = [];
  if (Array.isArray(record2.content)) {
    for (const raw of record2.content) {
      const block = raw;
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        const last = ordered[ordered.length - 1];
        if (last?.type === "text") last.text += block.text;
        else ordered.push({ type: "text", text: block.text });
      } else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        ordered.push({ type: "image", data: block.data, mimeType: block.mimeType });
      }
    }
  }
  const diff = details?.diff;
  if (typeof diff === "string" && diff.trim()) {
    return [{ type: "text", text: diff }, ...ordered.filter((block) => block.type === "image")];
  }
  if (ordered.length) return ordered;
  const anyResult = result;
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof anyResult.stdout === "string" ? anyResult.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof anyResult.output === "string" ? anyResult.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof anyResult.stderr === "string" ? anyResult.stderr : void 0);
  const exitCode = (typeof details?.exitCode === "number" ? details.exitCode : void 0) ?? (typeof anyResult.exitCode === "number" ? anyResult.exitCode : void 0) ?? (typeof details?.code === "number" ? details.code : void 0) ?? (typeof anyResult.code === "number" ? anyResult.code : void 0);
  if (typeof stdout === "string" && stdout.trim() || typeof stderr === "string" && stderr.trim()) {
    const parts = [];
    if (typeof stdout === "string" && stdout.trim()) parts.push(stdout);
    if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr:
${stderr}`);
    if (typeof exitCode === "number") parts.push(`exit code: ${exitCode}`);
    return [{ type: "text", text: parts.join("\n\n").trimEnd() }];
  }
  try {
    return [{ type: "text", text: JSON.stringify(result, null, 2) }];
  } catch {
    return [{ type: "text", text: String(result) }];
  }
}
function toolResultToolCallContent(result) {
  return toolResultContentBlocks(result).map(
    (block) => ({
      type: "content",
      content: block.type === "text" ? { type: "text", text: block.text } : block
    })
  );
}

// src/acp/translate/entry-walk.ts
var PiSessionEntriesError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PiSessionEntriesError";
  }
};
function asSessionEntry(value) {
  const record2 = value;
  if (!record2 || typeof record2 !== "object") return null;
  if (typeof record2.type !== "string" || typeof record2.id !== "string" || !record2.id) return null;
  if (record2.parentId !== null && (typeof record2.parentId !== "string" || !record2.parentId)) return null;
  return record2;
}
function walkActiveEntryBranch(data) {
  const record2 = data;
  if (!record2 || typeof record2 !== "object" || !Array.isArray(record2.entries)) {
    throw new PiSessionEntriesError("pi get_entries returned no entries");
  }
  const leafId = record2.leafId;
  if (leafId !== null && typeof leafId !== "string") {
    throw new PiSessionEntriesError("pi get_entries returned an invalid leafId");
  }
  if (leafId === null) return [];
  const byId = /* @__PURE__ */ new Map();
  const malformedIds = /* @__PURE__ */ new Set();
  for (const value of record2.entries) {
    const entry = asSessionEntry(value);
    if (!entry) {
      const id = value?.id;
      if (typeof id === "string" && id) {
        if (byId.has(id) || malformedIds.has(id)) {
          throw new PiSessionEntriesError(`duplicate session entry id: ${id}`);
        }
        malformedIds.add(id);
      }
      continue;
    }
    if (byId.has(entry.id) || malformedIds.has(entry.id)) {
      throw new PiSessionEntriesError(`duplicate session entry id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  const leaf = byId.get(leafId);
  if (!leaf) {
    throw new PiSessionEntriesError(`session leaf entry not found: ${leafId}`);
  }
  const path = [];
  const seen = /* @__PURE__ */ new Set();
  let current = leaf;
  while (current) {
    if (seen.has(current.id)) {
      throw new PiSessionEntriesError(`session entry parent cycle at: ${current.id}`);
    }
    seen.add(current.id);
    path.push(current);
    if (current.parentId === null) break;
    if (malformedIds.has(current.parentId)) {
      throw new PiSessionEntriesError(`malformed session entry in active branch: ${current.parentId}`);
    }
    current = byId.get(current.parentId);
  }
  path.reverse();
  return path;
}

// src/acp/translate/tool-calls.ts
import { lstatSync as lstatSync2, statSync } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";
function findUniqueLineNumber(text, needle) {
  if (!needle) return void 0;
  const first = text.indexOf(needle);
  if (first < 0) return void 0;
  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return void 0;
  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
function getToolPath(args) {
  const record2 = args;
  if (typeof record2?.path === "string") return record2.path;
  if (typeof record2?.file_path === "string") return record2.file_path;
  return void 0;
}
function normalizeEditInput(args) {
  const record2 = args ?? {};
  let edits = record2.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  return { record: record2, edits: Array.isArray(edits) ? edits : [] };
}
function completeEdits({ record: record2, edits }) {
  const pairs2 = [];
  if (typeof record2.oldText === "string" && typeof record2.newText === "string") {
    pairs2.push({ oldText: record2.oldText, newText: record2.newText });
  }
  for (const edit of edits) {
    if (typeof edit?.oldText === "string" && typeof edit?.newText === "string") {
      pairs2.push({ oldText: edit.oldText, newText: edit.newText });
    }
  }
  return pairs2;
}
function getEditOldTexts(args) {
  const input2 = normalizeEditInput(args);
  const oldTexts = new Set(completeEdits(input2).map((edit) => edit.oldText));
  if (typeof input2.record.oldText === "string") oldTexts.add(input2.record.oldText);
  for (const edit of input2.edits) {
    if (typeof edit?.oldText === "string") oldTexts.add(edit.oldText);
  }
  return [...oldTexts];
}
function toToolCallLocations(toolName, args, cwd, line) {
  const path = getToolPath(args);
  if (!path) return void 0;
  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  let entry;
  try {
    entry = lstatSync2(resolvedPath);
  } catch (error) {
    const isMissing = error.code === "ENOENT";
    if (!isMissing || toolName.toLowerCase() !== "write") return void 0;
    return [{ path: resolvedPath, ...typeof line === "number" ? { line } : {} }];
  }
  if (entry.isSymbolicLink()) {
    try {
      entry = statSync(resolvedPath);
    } catch {
      return void 0;
    }
  }
  if (!entry.isFile()) return void 0;
  return [{ path: resolvedPath, ...typeof line === "number" ? { line } : {} }];
}
function toToolKind(toolName) {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

// src/acp/translate/bash.ts
function isBashTool(toolName) {
  return toolName.toLowerCase() === "bash";
}
function bashCommand(value) {
  const record2 = value;
  const command = record2?.command ?? record2?.cmd ?? record2?.args?.command ?? record2?.args?.cmd ?? record2?.input?.command ?? record2?.input?.cmd ?? record2?.rawInput?.command ?? record2?.rawInput?.cmd ?? record2?.toolInput?.command ?? record2?.toolInput?.cmd ?? record2?.details?.command ?? record2?.details?.cmd;
  return typeof command === "string" && command.trim() ? command : void 0;
}
function bashDetailsText(result) {
  const record2 = result;
  const details = record2?.details;
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof record2?.stdout === "string" ? record2.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof record2?.output === "string" ? record2.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof record2?.stderr === "string" ? record2.stderr : void 0);
  return [stdout, stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
}
function bashResultText(result) {
  const record2 = result;
  const content = record2?.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => {
      const block = c;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    }).filter(Boolean);
    if (texts.length) return texts.join("");
  }
  return bashDetailsText(result);
}
function bashExitCode(result, isError) {
  const record2 = result;
  const details = record2?.details;
  const exitCode = details?.exitCode ?? record2?.exitCode ?? details?.code ?? record2?.code;
  return typeof exitCode === "number" ? exitCode : isError ? 1 : 0;
}
function bashOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}
function bashTerminalContent(toolCallId) {
  return [{ type: "terminal", terminalId: toolCallId }];
}
function fencedConsoleContent(text) {
  let longestBacktickRun = 0;
  for (const match of text.matchAll(/`+/g)) longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const closingSeparator = text.endsWith("\n") ? "" : "\n";
  return {
    type: "content",
    content: { type: "text", text: `${fence}console
${text}${closingSeparator}${fence}` }
  };
}
function bashOrderedContent(result) {
  const record2 = result;
  const out = [];
  let textRun = "";
  let sawContentText = false;
  const flushTextRun = () => {
    if (textRun.length > 0) out.push(fencedConsoleContent(textRun));
    textRun = "";
  };
  if (Array.isArray(record2?.content)) {
    for (const raw of record2.content) {
      const block = raw;
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        sawContentText = true;
        textRun += block.text;
      } else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
        flushTextRun();
        out.push({
          type: "content",
          content: { type: "image", data: block.data, mimeType: block.mimeType }
        });
      }
    }
    flushTextRun();
  }
  if (!sawContentText) {
    const fallback = bashDetailsText(result);
    if (fallback.length > 0) out.unshift(fencedConsoleContent(fallback));
  }
  return out;
}
function bashTerminalInfoMeta(toolCallId, cwd) {
  return { terminal_info: { terminal_id: toolCallId, cwd } };
}
function bashTerminalOutputMeta(toolCallId, data) {
  return { terminal_output: { terminal_id: toolCallId, data } };
}
function bashTerminalExitMeta(toolCallId, exitCode) {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } };
}

// src/acp/history-replay.ts
async function replaySessionHistory({
  session,
  cwd,
  supportsTerminalOutputMeta,
  assertActive,
  sendUpdate
}) {
  const proc = session.proc;
  let customMessageBoundary = session.currentCustomMessageSequence();
  const entryData = await proc.getEntries(() => {
    customMessageBoundary = session.currentCustomMessageSequence();
  });
  assertActive();
  let entries;
  try {
    entries = walkActiveEntryBranch(entryData);
  } catch (error) {
    if (error instanceof PiSessionEntriesError) {
      throw RequestError2.internalError({}, `Cannot replay session history: ${error.message}`);
    }
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      records.push({ entryId: entry.id, message: entry.message });
    } else if (entry.type === "custom_message") {
      records.push({
        entryId: entry.id,
        message: {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: entry.timestamp
        }
      });
    }
  }
  session.reconcileLoadedCustomMessages(
    records.map((record2) => record2.message),
    customMessageBoundary
  );
  const replayedToolCallIds = /* @__PURE__ */ new Set();
  const openToolCalls = /* @__PURE__ */ new Map();
  for (const { entryId, message: m } of records) {
    const role = String(m?.role ?? "");
    if (role === "user") {
      for (const block of translateUserContent(m?.content)) {
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: block.kind === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType }
          }
        });
      }
      continue;
    }
    if (role === "assistant") {
      for (const block of translateAssistantContent(m?.content)) {
        if (block.kind === "text") {
          await sendUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text }
            }
          });
          continue;
        }
        if (block.kind === "thinking") {
          await sendUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: block.text }
            }
          });
          continue;
        }
        replayedToolCallIds.add(block.toolCallId);
        const isBash = isBashTool(block.toolName);
        openToolCalls.set(block.toolCallId, { isBash });
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: block.toolCallId,
            title: isBash ? bashCommand(block.rawInput) ?? block.toolName : block.toolName,
            kind: isBash ? "execute" : toToolKind(block.toolName),
            status: "pending",
            rawInput: block.rawInput,
            locations: toToolCallLocations(block.toolName, block.rawInput, cwd),
            ...isBash && supportsTerminalOutputMeta ? {
              content: bashTerminalContent(block.toolCallId),
              _meta: bashTerminalInfoMeta(block.toolCallId, cwd)
            } : {}
          }
        });
      }
      continue;
    }
    if (role === "custom") {
      if (m?.display !== true) continue;
      for (const block of translateCustomMessageContent(m?.content)) {
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: block.kind === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType }
          }
        });
      }
      continue;
    }
    if (role === "toolResult") {
      const toolName = String(m?.toolName ?? "tool");
      const toolCallId = typeof m?.toolCallId === "string" && m.toolCallId ? m.toolCallId : `pi-load-${entryId}`;
      const isError = Boolean(m?.isError);
      const alreadyReplayed = replayedToolCallIds.has(toolCallId);
      replayedToolCallIds.add(toolCallId);
      openToolCalls.delete(toolCallId);
      if (isBashTool(toolName)) {
        if (!alreadyReplayed) {
          await sendUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: "execute",
              status: "in_progress",
              ...supportsTerminalOutputMeta ? {
                content: bashTerminalContent(toolCallId),
                _meta: bashTerminalInfoMeta(toolCallId, cwd)
              } : {}
            }
          });
        }
        const text = bashResultText(m);
        const bashImages = toolResultImageBlocks(m).map((image) => ({
          type: "content",
          content: { type: "image", data: image.data, mimeType: image.mimeType }
        }));
        const genericContent = bashOrderedContent(m);
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            ...supportsTerminalOutputMeta ? {
              ...bashImages.length ? { content: [...bashTerminalContent(toolCallId), ...bashImages] } : {},
              _meta: {
                ...text ? bashTerminalOutputMeta(toolCallId, text) : {},
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            } : genericContent.length ? { content: genericContent } : {}
          }
        });
        continue;
      }
      if (!alreadyReplayed) {
        await sendUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            rawInput: null
          }
        });
      }
      const content = toolResultToolCallContent(m);
      await sendUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content: content.length ? content : null,
          rawOutput: m
        }
      });
      continue;
    }
    if (role === "bashExecution") {
      const toolCallId = `pi-bash-${entryId}`;
      const cancelled = m?.cancelled === true;
      const output2 = bashResultText(m);
      const exitCode = bashExitCode(m, cancelled);
      const failed = cancelled || exitCode !== 0;
      await sendUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: bashCommand(m) ?? "bash",
          kind: "execute",
          status: "in_progress",
          ...supportsTerminalOutputMeta ? {
            content: bashTerminalContent(toolCallId),
            _meta: bashTerminalInfoMeta(toolCallId, cwd)
          } : {}
        }
      });
      await sendUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: failed ? "failed" : "completed",
          ...supportsTerminalOutputMeta ? {
            _meta: {
              ...output2 ? bashTerminalOutputMeta(toolCallId, output2) : {},
              ...bashTerminalExitMeta(toolCallId, exitCode)
            }
          } : (() => {
            const content = bashOrderedContent(m);
            return content.length ? { content } : {};
          })()
        }
      });
      continue;
    }
  }
  for (const [toolCallId, metadata] of openToolCalls) {
    const explanation = {
      type: "content",
      content: {
        type: "text",
        text: "No result was recorded for this tool call; the session ended before it completed."
      }
    };
    const terminalSettlement = metadata.isBash && supportsTerminalOutputMeta;
    await sendUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: terminalSettlement ? [...bashTerminalContent(toolCallId), explanation] : [explanation],
        ...terminalSettlement ? { _meta: bashTerminalExitMeta(toolCallId, 1) } : {}
      }
    });
  }
}

// src/acp/session-manager.ts
import { RequestError as RequestError7 } from "@agentclientprotocol/sdk";
import { mkdirSync as mkdirSync5 } from "fs";
import { dirname as dirname3 } from "path";

// src/runtime/identity.ts
import { spawn } from "child_process";
import { randomUUID as randomUUID2 } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync as statSync3,
  unlinkSync,
  writeFileSync
} from "fs";
import { isAbsolute as isAbsolute2, join as join4 } from "path";

// src/pi-rpc/command.ts
import { statSync as statSync2 } from "fs";
import { platform as hostPlatform } from "os";
import { win32 } from "path";
function defaultPiCommand(platform = hostPlatform()) {
  return platform === "win32" ? "pi.cmd" : "pi";
}
function getPiCommand(override) {
  return override ?? defaultPiCommand();
}
function isFile(path) {
  try {
    return statSync2(path).isFile();
  } catch {
    return false;
  }
}
function resolveWindowsScriptCommand(command, cwd, pathValue, fileExists = isFile) {
  const normalized = command.trim();
  const explicitPath = win32.isAbsolute(normalized) || /[\\/:]/.test(normalized);
  const candidates = explicitPath ? [win32.resolve(cwd, normalized)] : [
    win32.resolve(cwd, normalized),
    ...pathValue.split(win32.delimiter).map((rawDir) => {
      const dir = rawDir.startsWith('"') && rawDir.endsWith('"') ? rawDir.slice(1, -1) : rawDir;
      return win32.resolve(cwd, dir || ".", normalized);
    })
  ];
  const seen = /* @__PURE__ */ new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}
function cmdToken(value) {
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(/[()%!^"<>&|]/g, (char) => char === "%" ? "%%" : `^${char}`);
}
function buildPiInvocation(command, args, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command.trim())) {
    return { executable: command, args: [...args] };
  }
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const pathValue = Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1] ?? "";
  const script = resolveWindowsScriptCommand(command, cwd, pathValue, opts.fileExists);
  if (!script) return null;
  const commandProcessor = env.ComSpec || env.COMSPEC || "cmd.exe";
  const commandLine = [script, ...args].map(cmdToken).join(" ");
  return {
    executable: commandProcessor,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

// src/runtime/identity.ts
var IDENTITY_CAPABILITY = "pi-acp/identity/v1";
var ENV = "PI_ACP_NAMED_OWNER";
function parseIdentity(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid named identity");
  const { identityId, agentDirectory } = value;
  if (typeof identityId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identityId))
    throw new Error("Invalid identityId");
  if (typeof agentDirectory !== "string" || !isAbsolute2(agentDirectory) || !statSync3(agentDirectory).isDirectory())
    throw new Error("agentDirectory must be an existing absolute directory");
  return { identityId, agentDirectory: realpathSync(agentDirectory) };
}
function files(identity) {
  const root = join4(getPiAcpDir(), "identities");
  mkdirSync2(root, { recursive: true, mode: 448 });
  const base = join4(root, identity.identityId);
  return { owner: `${base}.json`, guard: `${base}.guard`, cursor: `${base}.cursor.json` };
}
function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID2()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
  renameSync(temp, path);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owner PID; refusing takeover");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}
function claimIdentity(value, cwd) {
  const identity = parseIdentity(value), paths = files(identity);
  const guarded = (fn) => {
    try {
      mkdirSync2(paths.guard, { mode: 448 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error(
        `Identity ownership is being changed or needs inspection: ${paths.guard}; no second Pi was started`
      );
    }
    try {
      return fn();
    } finally {
      rmdirSync(paths.guard);
    }
  };
  const owner = { ...identity, nonce: randomUUID2(), launcherPid: process.pid, childPid: null, cwd };
  guarded(() => {
    if (existsSync(paths.owner)) {
      const previous = JSON.parse(readFileSync2(paths.owner, "utf8"));
      if (previous.identityId !== identity.identityId || previous.agentDirectory !== identity.agentDirectory)
        throw new Error("Identity is bound to another configuration directory");
      if (previous.childPid === null || alive(previous.launcherPid) || alive(previous.childPid))
        throw new Error(
          `Identity already occupied: PID ${previous.childPid ?? previous.launcherPid}, ${previous.cwd}; no second Pi was started`
        );
    }
    writeAtomic(paths.owner, owner);
  });
  const change = (fn) => guarded(() => {
    const current = JSON.parse(readFileSync2(paths.owner, "utf8"));
    if (current.nonce !== owner.nonce) throw new Error("Identity ownership changed");
    fn();
  });
  return {
    env: { [ENV]: JSON.stringify({ path: paths.owner, nonce: owner.nonce }) },
    commit(pid) {
      change(() => {
        owner.childPid = pid;
        writeAtomic(paths.owner, owner);
      });
    },
    // Called only after observed child exit, or a confirmed spawn failure.
    release() {
      change(() => unlinkSync(paths.owner));
    }
  };
}
var SESSION_HEADER_SCAN = 1024 * 1024;
function firstJsonlRecordIsSessionHeader(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      return value.type === "session" && typeof value.id === "string";
    } catch {
    }
  }
  return false;
}
function usablePiSessionFile(path) {
  let size;
  try {
    const st = statSync3(path);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  if (size === 0) return true;
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(Math.min(SESSION_HEADER_SCAN, size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return firstJsonlRecordIsSessionHeader(buf.subarray(0, n).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function takeUsableSessionFile(path) {
  if (!path || !existsSync(path)) return void 0;
  if (usablePiSessionFile(path)) return path;
  console.error(`pi-acp: ignoring invalid Pi session file, starting a new session: ${path}`);
  return void 0;
}
function recordedIdentitySessionPath(identity) {
  const path = files(identity).cursor;
  if (!existsSync(path)) return void 0;
  const cursor = JSON.parse(readFileSync2(path, "utf8"));
  if (cursor.identityId !== identity.identityId || cursor.agentDirectory !== identity.agentDirectory)
    throw new Error("Identity session directory mismatch");
  return cursor.sessionFile && existsSync(cursor.sessionFile) ? cursor.sessionFile : void 0;
}
function resolveIdentitySessionFile(identity, fallback) {
  const recorded = recordedIdentitySessionPath(identity);
  const usable = takeUsableSessionFile(recorded);
  if (usable) return usable;
  if (!fallback || fallback === recorded) return void 0;
  return takeUsableSessionFile(fallback);
}
function spawnNamedPi(command, args, cwd, options, identity) {
  const invocation = buildPiInvocation(command, args, { cwd });
  if (!invocation) throw new Error(`Pi executable not found: ${command}`);
  const lease = identity ? claimIdentity(identity, cwd) : void 0;
  const env = { ...process.env, ...options.env };
  delete env[ENV];
  if (identity) {
    env.PI_CODING_AGENT_DIR = identity.agentDirectory;
    env.PI_CODING_AGENT_SESSION_DIR = join4(identity.agentDirectory, "sessions");
    Object.assign(env, lease.env);
  }
  let child;
  try {
    child = spawn(invocation.executable, invocation.args, {
      ...options,
      cwd,
      env,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
  } catch (error) {
    lease?.release();
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      lease?.release();
    } catch (error) {
      console.error(`pi-acp: ${String(error)}`);
    }
  };
  child.once("exit", release);
  child.once("error", () => {
    if (child.pid === void 0) release();
  });
  if (child.pid && lease) {
    try {
      lease.commit(child.pid);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }
  return child;
}

// src/pi-rpc/process.ts
import { randomUUID as randomUUID3 } from "crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, writeFileSync as writeFileSync2, statSync as statSync4, unlinkSync as unlinkSync2 } from "fs";
import { join as join5 } from "path";
import { fileURLToPath } from "url";

// src/pi-rpc/line-decoder.ts
import { StringDecoder } from "string_decoder";
var LfLineTooLongError = class extends Error {
  constructor(maxBufferedBytes) {
    super(`pi RPC stdout record exceeded the ${maxBufferedBytes}-byte framing limit`);
    this.maxBufferedBytes = maxBufferedBytes;
    this.name = "LfLineTooLongError";
  }
  maxBufferedBytes;
};
var DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
var LfLineDecoder = class {
  constructor(maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES) {
    this.maxBufferedBytes = maxBufferedBytes;
  }
  maxBufferedBytes;
  decoder = new StringDecoder("utf8");
  parts = [];
  bytes = 0;
  lastCodeUnit = 0;
  append(text) {
    if (!text) return;
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.lastCodeUnit >= 55296 && this.lastCodeUnit <= 56319 && text.charCodeAt(0) >= 56320 && text.charCodeAt(0) <= 57343)
      this.bytes -= 2;
    this.lastCodeUnit = text.charCodeAt(text.length - 1);
    if (this.bytes > this.maxBufferedBytes) {
      this.parts = [];
      this.bytes = 0;
      this.lastCodeUnit = 0;
      throw new LfLineTooLongError(this.maxBufferedBytes);
    }
    this.parts.push(text);
  }
  take() {
    const line = this.parts.join("");
    this.parts = [];
    this.bytes = 0;
    this.lastCodeUnit = 0;
    return line;
  }
  /** Scan only new text: neither newline search nor byte accounting revisits a pending record. */
  push(chunk) {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines = [];
    let start = 0;
    let newline;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      this.append(text.slice(start, newline));
      lines.push(this.take());
      start = newline + 1;
    }
    this.append(text.slice(start));
    return lines;
  }
  end() {
    this.append(this.decoder.end());
    return this.take() || null;
  }
};

// src/pi-rpc/version.ts
import { spawn as spawn2 } from "child_process";
var MIN_PI_VERSION = "0.80.4";
var PiVersionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PiVersionError";
  }
};
var SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function parsePiVersion(raw) {
  const cleaned = raw.trim().replace(/^v/i, "");
  return SEMVER_REGEX.test(cleaned) ? cleaned : null;
}
function parseSemverParts(v) {
  const normalized = parsePiVersion(v);
  if (!normalized) throw new TypeError(`Invalid semantic version: ${v}`);
  const withoutBuild = normalized.split("+")[0];
  const dashIndex = withoutBuild.indexOf("-");
  const base = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? [] : withoutBuild.slice(dashIndex + 1).split(".");
  const [major, minor, patch] = base.split(".").map(BigInt);
  return { base: [major, minor, patch], prerelease };
}
function comparePiVersions(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa.base[i] > pb.base[i]) return 1;
    if (pa.base[i] < pb.base[i]) return -1;
  }
  if (!pa.prerelease.length && !pb.prerelease.length) return 0;
  if (!pa.prerelease.length) return 1;
  if (!pb.prerelease.length) return -1;
  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === void 0) return -1;
    if (ib === void 0) return 1;
    const numericA = /^\d+$/.test(ia);
    const numericB = /^\d+$/.test(ib);
    if (numericA && numericB) {
      const na = BigInt(ia);
      const nb = BigInt(ib);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (numericA) return -1;
    else if (numericB) return 1;
    else if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}
var versionCache = /* @__PURE__ */ new Map();
function versionFailure(command, cwd, detail) {
  return new PiVersionError(
    `Could not determine the pi version: \`${command} --version\` ${detail} from ${cwd}. pi-acp requires pi >= ${MIN_PI_VERSION} (for the \`agent_settled\` RPC event).`
  );
}
function abortReason(signal) {
  if (signal.reason !== void 0) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
function startVersionProbe(piCommand, cwd) {
  const controller = new AbortController();
  const signal = controller.signal;
  const promise = new Promise((resolve5, reject) => {
    const invocation = buildPiInvocation(piCommand, ["--version"], { cwd });
    if (!invocation) return resolve5(null);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let abortedReason;
    const child = spawn2(invocation.executable, invocation.args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in outcome) reject(outcome.error);
      else resolve5(outcome.value);
    };
    const onAbort = () => {
      if (settled || abortedReason !== void 0) return;
      abortedReason = abortReason(signal);
      child.kill("SIGKILL");
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
    child.once("error", (error) => {
      if (abortedReason !== void 0) {
        settle({ error: abortedReason });
        return;
      }
      const code = error.code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOEXEC") settle({ value: null });
      else settle({ error: versionFailure(piCommand, cwd, String(error)) });
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      if (abortedReason !== void 0) {
        settle({ error: abortedReason });
        return;
      }
      const output2 = (stdout.trim() || stderr.trim()).slice(0, 120);
      if (code !== 0 || childSignal) {
        settle({
          error: versionFailure(
            piCommand,
            cwd,
            childSignal ? `was terminated by ${childSignal}` : `exited with status ${code}`
          )
        });
        return;
      }
      const version = parsePiVersion(output2);
      if (!version) {
        settle({ error: versionFailure(piCommand, cwd, `printed ${JSON.stringify(output2)}`) });
        return;
      }
      if (comparePiVersions(version, MIN_PI_VERSION) < 0) {
        settle({
          error: new PiVersionError(
            `Unsupported pi version ${version} (command: ${piCommand}). pi-acp requires pi >= ${MIN_PI_VERSION}, which adds the \`agent_settled\` RPC event used to close ACP prompt turns safely.`
          )
        });
        return;
      }
      settle({ value: version });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ error: versionFailure(piCommand, cwd, "timed out") });
    }, 15e3);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const probe = {
    promise,
    consumers: /* @__PURE__ */ new Set(),
    aborting: false,
    settled: false,
    abort() {
      if (probe.aborting || probe.settled) return;
      probe.aborting = true;
      controller.abort();
    }
  };
  void promise.then(
    () => {
      probe.settled = true;
    },
    () => {
      probe.settled = true;
    }
  );
  return probe;
}
function consumeVersionProbe(probe, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const consumer = /* @__PURE__ */ Symbol("version-probe-consumer");
  probe.consumers.add(consumer);
  return new Promise((resolve5, reject) => {
    let finished = false;
    let aborted = false;
    const detach = () => {
      signal?.removeEventListener("abort", onAbort);
      probe.consumers.delete(consumer);
    };
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      detach();
      if ("error" in outcome) reject(outcome.error);
      else resolve5(outcome.value);
    };
    const onAbort = () => {
      if (finished || aborted) return;
      aborted = true;
      const reason = abortReason(signal);
      detach();
      if (probe.consumers.size > 0 || probe.settled) {
        finished = true;
        reject(reason);
        return;
      }
      probe.abort();
      void probe.promise.then(
        () => finish({ error: reason }),
        () => finish({ error: reason })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void probe.promise.then(
      (value) => {
        if (!aborted) finish({ value });
      },
      (error) => {
        if (!aborted) finish({ error });
      }
    );
    if (signal?.aborted) onAbort();
  });
}
function assertSupportedPiVersion(piCommand, cwd = process.cwd(), signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const cacheKey = JSON.stringify([piCommand, cwd]);
  let probe = versionCache.get(cacheKey);
  if (!probe || probe.aborting) {
    probe = startVersionProbe(piCommand, cwd);
    versionCache.set(cacheKey, probe);
    void probe.promise.then(
      (version) => {
        if (version === null && versionCache.get(cacheKey) === probe) versionCache.delete(cacheKey);
      },
      () => {
        if (versionCache.get(cacheKey) === probe) versionCache.delete(cacheKey);
      }
    );
  }
  return consumeVersionProbe(probe, signal);
}

// src/pi-rpc/protocol.ts
var KNOWN_EVENTS = /* @__PURE__ */ new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "extension_ui_request",
  "queue_update",
  "session_info_changed",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end"
]);
function decodePiRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record2 = value;
  if (record2.type === "response") {
    if (typeof record2.command !== "string" || typeof record2.success !== "boolean") return null;
    return {
      type: "response",
      id: typeof record2.id === "string" ? record2.id : void 0,
      command: record2.command,
      success: record2.success,
      data: record2.data,
      error: typeof record2.error === "string" ? record2.error : void 0
    };
  }
  if (record2.type === "extension_error") {
    if (typeof record2.extensionPath !== "string" || typeof record2.event !== "string" || typeof record2.error !== "string")
      return null;
    return { type: "extension_error", extensionPath: record2.extensionPath, event: record2.event, error: record2.error };
  }
  if (typeof record2.type !== "string") return null;
  if (!KNOWN_EVENTS.has(record2.type)) return { type: "ignored", originalType: record2.type };
  return record2;
}

// src/pi-rpc/process.ts
var PiRpcSpawnError = class extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code;
  constructor(message, opts) {
    super(message);
    this.name = "PiRpcSpawnError";
    this.code = opts?.code;
    this.cause = opts?.cause;
  }
};
function piExecutableNotFoundError(cmd, cause) {
  return new PiRpcSpawnError(
    `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
    { code: "ENOENT", cause }
  );
}
var PiRpcRequestTimeoutError = class extends Error {
  command;
  timeoutMs;
  constructor(command, timeoutMs) {
    super(`pi ${command} timed out after ${timeoutMs}ms: no RPC response from the pi subprocess.`);
    this.name = "PiRpcRequestTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
};
var PiRpcClosedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PiRpcClosedError";
  }
};
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var ABORT_TIMEOUT_MS = 1e4;
var PROMPT_TIMEOUT_MS = 10 * 6e4;
var COMPACT_TIMEOUT_MS = 10 * 6e4;
var GET_ENTRIES_TIMEOUT_MS = 2 * 6e4;
var EXPORT_TIMEOUT_MS = 2 * 6e4;
var KILL_GRACE_MS = 2e3;
var CLOSE_FALLBACK_MS = 1e3;
var STDERR_TAIL_LIMIT = 8 * 1024;
var PiRpcProcess = class _PiRpcProcess {
  child;
  pending = /* @__PURE__ */ new Map();
  eventHandlers = [];
  terminationHandlers = [];
  requestTimeoutMs;
  killGraceMs;
  closeFallbackMs;
  stderrTailBuf = "";
  termination = null;
  disposeRequested = false;
  disposeIsExpected = false;
  killTimer;
  exitFallbackTimer;
  constructor(child, opts) {
    this.child = child;
    this.requestTimeoutMs = opts?.requestTimeoutMs;
    this.killGraceMs = opts?.killGraceMs ?? KILL_GRACE_MS;
    this.closeFallbackMs = opts?.closeFallbackMs ?? CLOSE_FALLBACK_MS;
    const decoder = new LfLineDecoder(opts?.maxStdoutRecordBytes);
    child.stdout.on("data", (chunk) => {
      try {
        for (const line of decoder.push(chunk)) this.handleStdoutLine(line);
      } catch {
        this.dispose({ expected: false });
      }
    });
    child.stdout.on("end", () => {
      try {
        const rest = decoder.end();
        if (rest !== null) this.handleStdoutLine(rest);
      } catch {
        this.dispose({ expected: false });
      }
    });
    child.stderr.on("data", (chunk) => {
      this.stderrTailBuf = (this.stderrTailBuf + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
    });
    child.on("error", (err) => {
      if (child.pid === void 0) {
        this.settleTermination({
          reason: "error",
          code: null,
          signal: null,
          error: err
        });
      }
    });
    child.on("exit", (code, signal) => {
      const timer = setTimeout(() => this.settleTermination({ reason: "exit", code, signal }), this.closeFallbackMs);
      this.exitFallbackTimer = timer;
    });
    child.on("close", (code, signal) => {
      this.settleTermination({ reason: "exit", code, signal });
    });
  }
  /**
   * Wrap an already-spawned pi RPC child process.
   * Test seam: production code must go through {@link PiRpcProcess.spawn}.
   */
  static fromChild(child, opts) {
    return new _PiRpcProcess(child, opts);
  }
  handleStdoutLine(line) {
    if (this.disposeRequested || this.termination || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const decoded = decodePiRecord(msg);
    if (!decoded) return;
    if (decoded.type === "response" && "command" in decoded && "success" in decoded) {
      if (typeof decoded.id !== "string") return;
      const entry = this.takePending(decoded.id);
      if (!entry) return;
      const response = decoded;
      try {
        entry.beforeResolve?.(response);
        entry.resolve(response);
      } catch (error) {
        entry.reject(error);
      }
      return;
    }
    this.dispatchEvent(decoded);
  }
  dispatchEvent(ev) {
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(ev);
      } catch {
      }
    }
  }
  takePending(id) {
    const entry = this.pending.get(id);
    if (!entry) return void 0;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }
  rejectAllPending(err) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
  settleTermination(info) {
    if (this.termination) return;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = void 0;
    }
    if (this.exitFallbackTimer) {
      clearTimeout(this.exitFallbackTimer);
      this.exitFallbackTimer = void 0;
    }
    this.termination = {
      ...info,
      expected: this.disposeIsExpected,
      stderrTail: this.stderrTailBuf
    };
    this.rejectAllPending(this.closedError());
    const handlers = [...this.terminationHandlers];
    this.terminationHandlers = [];
    for (const handler of handlers) {
      try {
        handler(this.termination);
      } catch {
      }
    }
  }
  closedError() {
    const t = this.termination;
    if (!t) return new PiRpcClosedError("pi process is shutting down");
    const base = t.reason === "error" ? `pi process failed: ${t.error instanceof Error ? t.error.message : String(t.error)}` : `pi process exited (code=${t.code}, signal=${t.signal})`;
    const tail = t.stderrTail.trim();
    return new PiRpcClosedError(tail ? `${base}. Last stderr output: ${tail.slice(-400)}` : base);
  }
  timeoutForCommand(type) {
    if (this.requestTimeoutMs !== void 0) return this.requestTimeoutMs;
    switch (type) {
      case "abort":
        return ABORT_TIMEOUT_MS;
      case "prompt":
        return PROMPT_TIMEOUT_MS;
      case "compact":
        return COMPACT_TIMEOUT_MS;
      case "get_entries":
        return GET_ENTRIES_TIMEOUT_MS;
      case "export_html":
        return EXPORT_TIMEOUT_MS;
      default:
        return DEFAULT_REQUEST_TIMEOUT_MS;
    }
  }
  static async spawn(params) {
    const cmd = getPiCommand(params.piCommand);
    try {
      await assertSupportedPiVersion(cmd, params.cwd, params.signal);
    } catch (e) {
      if (e instanceof PiVersionError) {
        throw new PiRpcSpawnError(e.message, { code: "UNSUPPORTED_PI_VERSION", cause: e });
      }
      throw e;
    }
    const extension = new URL("./acp-extension.js", import.meta.url);
    const extensionPath = fileURLToPath(
      existsSync2(extension) ? extension : new URL("./acp-extension.ts", import.meta.url)
    );
    const args = ["--mode", "rpc", "--no-themes", "--extension", extensionPath];
    let emptySessionPath;
    if (!params.sessionPath && params.sessionDirectory) {
      mkdirSync3(params.sessionDirectory, { recursive: true, mode: 448 });
      emptySessionPath = join5(
        params.sessionDirectory,
        `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID()}.jsonl`
      );
      writeFileSync2(emptySessionPath, "", { flag: "wx", mode: 384 });
    }
    const sessionPath = params.sessionPath ?? emptySessionPath;
    if (sessionPath) args.push("--session", sessionPath);
    const cleanupEmptySession = () => {
      if (!emptySessionPath) return;
      try {
        if (statSync4(emptySessionPath).size === 0) unlinkSync2(emptySessionPath);
      } catch {
      }
    };
    const env = { ...process.env };
    if (params.agentDirectory) env.PI_CODING_AGENT_DIR = params.agentDirectory;
    if (params.mcpProxyOnly) env.PI_MCP_TOOL_EXPOSURE = "proxy-only";
    let child;
    try {
      child = spawnNamedPi(
        cmd,
        args,
        params.cwd,
        { stdio: "pipe", env },
        params.identity
      );
    } catch (error) {
      cleanupEmptySession();
      throw error;
    }
    const proc = new _PiRpcProcess(child);
    void proc.whenTerminated().then(cleanupEmptySession);
    try {
      params.onProcess?.(proc);
    } catch (error) {
      proc.dispose();
      throw error;
    }
    try {
      await new Promise((resolve5, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve5();
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      proc.dispose({ expected: false });
      const e = error;
      const code = typeof e.code === "string" ? e.code : void 0;
      if (code === "ENOENT") {
        throw piExecutableNotFoundError(cmd, e);
      }
      if (code === "EACCES") {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e });
      }
      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e });
    }
    return proc;
  }
  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }
  /**
   * Subscribe to the child's terminal state. The handler is invoked at most
   * once, even when Node emits both 'error' and 'exit' for the same child.
   * Subscribing after termination delivers the recorded state asynchronously.
   */
  onTermination(handler) {
    const settled = this.termination;
    if (settled) {
      queueMicrotask(() => {
        try {
          handler(settled);
        } catch {
        }
      });
      return () => {
      };
    }
    this.terminationHandlers.push(handler);
    return () => {
      this.terminationHandlers = this.terminationHandlers.filter((h) => h !== handler);
    };
  }
  /** Bounded tail of the child's stderr output (for diagnostics). */
  stderrTail() {
    return this.stderrTailBuf;
  }
  /**
   * Whether a request is still awaiting its correlated pi response. pi has no
   * command that cancels in-flight RPC work (`abort` only stops an agent run,
   * not a manual compaction/export), so callers that must settle promptly use
   * this to decide whether the channel has to be quarantined.
   */
  hasPendingRequests() {
    return this.pending.size > 0;
  }
  /**
   * Resolves once the child has actually terminated (immediately if it
   * already has). Final adapter shutdown awaits this so the SIGTERM ->
   * SIGKILL escalation in {@link dispose} can complete before process exit.
   */
  whenTerminated() {
    if (this.termination) return Promise.resolve();
    return new Promise((resolve5) => {
      this.onTermination(() => resolve5());
    });
  }
  backgroundDisposal = false;
  dispose(options) {
    if (this.disposeRequested) return;
    if (this.backgroundDisposal && options?.expected !== false) return;
    if (options?.backgroundOwner && options.expected !== false) {
      this.backgroundDisposal = true;
      void this.abort(options.backgroundOwner).catch(() => {
        console.error("pi-acp: background stop failed during shutdown; detached work may still be running");
      }).finally(() => {
        this.backgroundDisposal = false;
        this.dispose({ expected: options.expected });
      });
      return;
    }
    this.disposeRequested = true;
    this.disposeIsExpected = options?.expected ?? true;
    this.rejectAllPending(this.closedError());
    if (this.termination) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
    }
    const timer = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
      }
    }, this.killGraceMs);
    this.killTimer = timer;
  }
  bridgeReady;
  mcpConfiguration;
  mcpUpdating = false;
  async configureMcpServers(servers) {
    const configuration = JSON.stringify(servers);
    if (configuration === this.mcpConfiguration || !servers.length && this.mcpConfiguration === void 0) return;
    if (this.mcpUpdating) throw new McpConfigurationError("MCP_SESSION_BUSY", "MCP \u914D\u7F6E\u6B63\u5728\u66F4\u65B0");
    this.mcpUpdating = true;
    let unsubscribe;
    try {
      const raw = await this.getCommands();
      if (!Array.isArray(raw.commands) || !raw.commands.some((command) => command.name === MCP_COMMAND))
        throw new McpConfigurationError(
          "MCP_BRIDGE_UNAVAILABLE",
          "Pi \u672A\u52A0\u8F7D ACP MCP \u6865\u63A5\u6269\u5C55\uFF1B\u62D2\u7EDD\u628A\u670D\u52A1\u914D\u7F6E\u53D1\u9001\u7ED9\u6A21\u578B"
        );
      const id = randomUUID3();
      let acknowledgement;
      unsubscribe = this.onEvent((event) => {
        if (event.type !== "extension_ui_request" || event.method !== "setWidget" || event.widgetKey !== MCP_WIDGET)
          return;
        const lines = event.widgetLines;
        if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string") return;
        try {
          const response2 = JSON.parse(lines[0]);
          if (response2.version === 1 && response2.id === id) acknowledgement = response2;
        } catch {
        }
      });
      const payload = Buffer.from(JSON.stringify({ version: 1, id, servers })).toString("base64url");
      const response = await this.request({ type: "prompt", message: `/${MCP_COMMAND} ${payload}` });
      if (!response.success || !acknowledgement) {
        this.dispose({ expected: false });
        throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "MCP \u6CE8\u518C\u672A\u6536\u5230\u6709\u6548\u56DE\u6267\uFF0C\u5DF2\u5173\u95ED\u4E0D\u786E\u5B9A\u72B6\u6001\u7684 Pi \u8FDB\u7A0B");
      }
      if (acknowledgement.success !== true) {
        const code = typeof acknowledgement.code === "string" ? acknowledgement.code : "MCP_REGISTRATION_FAILED";
        if (code === "MCP_ROLLBACK_FAILED" || code === "MCP_ADAPTER_INCOMPATIBLE") this.dispose({ expected: false });
        throw new McpConfigurationError(code, "MCP \u670D\u52A1\u6CE8\u518C\u5931\u8D25\uFF1B\u8BF7\u68C0\u67E5 adapter \u517C\u5BB9\u6027\u3001\u670D\u52A1\u91CD\u540D\u548C\u4F1A\u8BDD\u72B6\u6001");
      }
      this.mcpConfiguration = configuration;
    } catch (error) {
      if (error instanceof McpConfigurationError) throw error;
      this.dispose({ expected: false });
      throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "MCP \u6CE8\u518C\u901A\u4FE1\u5931\u8D25\uFF0C\u5DF2\u5173\u95ED\u4E0D\u786E\u5B9A\u72B6\u6001\u7684 Pi \u8FDB\u7A0B");
    } finally {
      unsubscribe?.();
      this.mcpUpdating = false;
    }
  }
  async prompt(message, images = [], onAccepted, owner) {
    if (/^\/pi-acp-(?:control|mcp)(?:\s|$)/.test(message))
      throw new Error("pi-acp internal commands are reserved for the adapter");
    if (owner) {
      this.bridgeReady ??= this.getCommands().then((raw) => {
        const commands = raw?.commands;
        if (!Array.isArray(commands) || !commands.some((command) => command.name === "pi-acp-control")) {
          throw new Error(
            "The adapter lifecycle extension failed to load; refusing to send an internal command to the model"
          );
        }
      });
      await this.bridgeReady;
      await this.control("begin", owner, DEFAULT_REQUEST_TIMEOUT_MS);
    }
    const res = await this.request(
      { type: "prompt", message, images, streamingBehavior: "followUp" },
      {
        // This callback runs synchronously at the successful response record,
        // before any later event records from the same stdout chunk. Session
        // ownership must cross that wire boundary rather than the earlier
        // stdin-write boundary.
        beforeResolve: (response) => {
          if (response.success) onAccepted?.();
        }
      }
    );
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async control(operation, owner, timeoutMs, deadline) {
    let acknowledgement;
    const unsubscribe = this.onEvent((event) => {
      if (event.type !== "extension_ui_request" || event.method !== "setWidget" || event.widgetKey !== "pi-acp-lifecycle")
        return;
      try {
        const lines = event.widgetLines;
        if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string") return;
        const state = JSON.parse(lines[0]);
        if (state.version === 1 && state.owner === owner && ["ready", "rejected", "stopping", "pending", "cancelled", "error"].includes(String(state.state)))
          acknowledgement = state;
      } catch {
      }
    });
    try {
      await this.call(
        {
          type: "prompt",
          message: `/pi-acp-control ${operation} ${owner}${deadline === void 0 ? "" : ` ${deadline}`}`
        },
        timeoutMs
      );
      if (operation !== "begin" && typeof acknowledgement?.error === "string")
        this.abortControlDiagnostic = acknowledgement.error;
      if (operation === "check" && acknowledgement?.state === "pending") return false;
      if (acknowledgement?.state === (operation === "begin" ? "ready" : operation === "cancel" ? "stopping" : "cancelled"))
        return true;
      if (acknowledgement?.state !== "rejected") this.dispose({ expected: false });
      throw new Error(
        `ACP lifecycle ${operation} failed: ${String(acknowledgement?.error ?? "missing acknowledgement")}`
      );
    } finally {
      unsubscribe();
    }
  }
  abortInFlight;
  abortOwner;
  abortControlDiagnostic;
  async abort(owner) {
    if (this.abortInFlight) {
      if (owner && this.abortOwner && owner !== this.abortOwner) throw new Error("Conflicting ACP cancellation owner");
      this.abortOwner ??= owner;
      return this.abortInFlight;
    }
    this.abortOwner = owner;
    const abort = this.boundedAbort();
    this.abortInFlight = abort;
    try {
      await abort;
    } finally {
      if (this.abortInFlight === abort) {
        this.abortInFlight = void 0;
        this.abortOwner = void 0;
        this.abortControlDiagnostic = void 0;
      }
    }
  }
  async boundedAbort() {
    let timer;
    try {
      await Promise.race([
        this.runAbort(Date.now() + ABORT_TIMEOUT_MS),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            this.dispose({ expected: false });
            reject(new Error("Pi cancellation timed out; detached background work may still be running"));
          }, ABORT_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      this.dispose({ expected: false });
      if (this.abortControlDiagnostic)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; last unconfirmed nested control: ${this.abortControlDiagnostic}`,
          { cause: error }
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async runAbort(deadline) {
    const remaining = () => Math.max(1, deadline - Date.now());
    await this.call({ type: "clear_queue" }, remaining());
    await this.call({ type: "abort" }, remaining());
    while (this.abortOwner) {
      if (Date.now() >= deadline)
        throw new Error("Cancellation quiescence could not be confirmed; detached background work may still be running");
      await this.control("cancel", this.abortOwner, remaining(), deadline);
      await this.call({ type: "clear_queue" }, remaining());
      await this.call({ type: "abort" }, remaining());
      if (await this.control("check", this.abortOwner, remaining(), deadline)) return;
      await new Promise((resolve5) => setTimeout(resolve5, Math.min(25, remaining())));
    }
  }
  async getState() {
    return this.call({ type: "get_state" });
  }
  async getAvailableModels() {
    return this.call({ type: "get_available_models" });
  }
  async setModel(provider, modelId) {
    return this.call({ type: "set_model", provider, modelId });
  }
  async getAvailableThinkingLevels() {
    const res = await this.request({ type: "get_available_thinking_levels" });
    if (!res.success) {
      const error = new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`);
      error.unsupportedCommand = /unknown command|unsupported/i.test(
        res.error ?? ""
      );
      throw error;
    }
    return res.data;
  }
  async setThinkingLevel(level) {
    await this.call({ type: "set_thinking_level", level });
  }
  async setFollowUpMode(mode) {
    await this.call({ type: "set_follow_up_mode", mode });
  }
  async setSteeringMode(mode) {
    await this.call({ type: "set_steering_mode", mode });
  }
  async compact(customInstructions) {
    return this.call({ type: "compact", customInstructions });
  }
  async setAutoCompaction(enabled) {
    await this.call({ type: "set_auto_compaction", enabled });
  }
  async getSessionStats() {
    return this.call({ type: "get_session_stats" });
  }
  async setSessionName(name) {
    await this.call({ type: "set_session_name", name });
  }
  async exportHtml(outputPath) {
    const res = await this.request({ type: "export_html", outputPath });
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`);
    const data = res.data;
    return { path: String(data?.path ?? "") };
  }
  /**
   * The callback runs synchronously at the response line boundary, before
   * later stdout events can be dispatched from the same input chunk.
   */
  async getEntries(beforeResponseResolve) {
    const res = await this.request({ type: "get_entries" }, { beforeResolve: beforeResponseResolve });
    if (!res.success) throw new Error(`pi get_entries failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getCommands() {
    return this.call({ type: "get_commands" });
  }
  async sendExtensionUiResponse(response) {
    await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}
`);
  }
  async call(cmd, timeoutMs) {
    const res = await this.request(cmd, { timeoutMs });
    if (!res.success) throw new Error(`pi ${cmd.type} failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  request(cmd, opts) {
    const id = crypto.randomUUID();
    const line = `${JSON.stringify({ ...cmd, id })}
`;
    return new Promise((resolve5, reject) => {
      if (this.termination || this.disposeRequested) {
        reject(this.closedError());
        return;
      }
      const entry = { resolve: resolve5, reject, beforeResolve: opts?.beforeResolve };
      const timeoutMs = opts?.timeoutMs ?? this.timeoutForCommand(cmd.type);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (!this.takePending(id)) return;
          const error = new PiRpcRequestTimeoutError(cmd.type, timeoutMs);
          this.dispose({ expected: false });
          reject(error);
        }, timeoutMs);
        entry.timer = timer;
      }
      this.pending.set(id, entry);
      void this.writeLine(line).catch((error) => {
        if (this.takePending(id)) reject(error);
      });
    });
  }
  writeLine(line) {
    return new Promise((resolve5, reject) => {
      const fail = (error) => {
        this.dispose({ expected: false });
        reject(error);
      };
      try {
        this.child.stdin.write(line, (error) => {
          if (error) {
            fail(error);
            return;
          }
          resolve5();
        });
      } catch (error) {
        fail(error);
      }
    });
  }
};

// src/acp/auth-required.ts
import { RequestError as RequestError3 } from "@agentclientprotocol/sdk";
function maybeAuthRequiredError(err, authMethods = []) {
  const msg = String(err?.message ?? err ?? "");
  const s = msg.toLowerCase();
  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "unauthorized",
    "unauthenticated",
    "not authenticated",
    "authentication",
    "credential",
    "log in",
    "login"
  ];
  const http401 = /\b401\b/.test(s);
  const hit = http401 || patterns.some((p) => s.includes(p));
  if (!hit) return null;
  return RequestError3.authRequired(
    {
      authMethods
    },
    "Configure an API key or log in with an OAuth provider."
  );
}

// src/acp/session-store.ts
import { closeSync as closeSync2, fsyncSync, mkdirSync as mkdirSync4, openSync as openSync2, readFileSync as readFileSync3, renameSync as renameSync2, unlinkSync as unlinkSync3, writeSync } from "fs";
import { createHash } from "crypto";
import { readFile, readdir } from "fs/promises";
import { dirname, join as join6 } from "path";
var SessionStoreCorruptError = class extends Error {
  path;
  constructor(path, detail) {
    super(
      `pi-acp session store record is corrupt: ${path} (${detail}). Repair or delete the file manually; it will not be overwritten automatically.`
    );
    this.name = "SessionStoreCorruptError";
    this.path = path;
  }
};
function isStoredSession(value) {
  const record2 = value;
  return !!record2 && typeof record2 === "object" && typeof record2.sessionId === "string" && typeof record2.cwd === "string" && typeof record2.sessionFile === "string" && typeof record2.updatedAt === "string";
}
function parseRecord(path, raw, expectedSessionId) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SessionStoreCorruptError(path, `invalid JSON: ${String(e?.message ?? e)}`);
  }
  const record2 = parsed;
  if (!record2 || typeof record2 !== "object" || record2.version !== 1) {
    throw new SessionStoreCorruptError(path, "unknown record shape or version");
  }
  if (record2.deleted === true) {
    if (typeof record2.sessionId !== "string") throw new SessionStoreCorruptError(path, "tombstone without sessionId");
    if (expectedSessionId !== void 0 && record2.sessionId !== expectedSessionId) {
      throw new SessionStoreCorruptError(
        path,
        `tombstone sessionId ${record2.sessionId} does not match ${expectedSessionId}`
      );
    }
    return { version: 1, deleted: true, sessionId: record2.sessionId };
  }
  if (record2.deleted !== void 0 && record2.deleted !== false) {
    throw new SessionStoreCorruptError(path, "invalid deleted marker");
  }
  if (!isStoredSession(record2.session)) {
    throw new SessionStoreCorruptError(path, "live record without a valid session");
  }
  if (expectedSessionId !== void 0 && record2.session.sessionId !== expectedSessionId) {
    throw new SessionStoreCorruptError(
      path,
      `live record sessionId ${record2.session.sessionId} does not match ${expectedSessionId}`
    );
  }
  return { version: 1, session: record2.session };
}
function parseLegacyMap(path, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SessionStoreCorruptError(path, `invalid JSON: ${String(e?.message ?? e)}`);
  }
  const map = parsed;
  if (!map || typeof map !== "object" || map.version !== 1 || typeof map.sessions !== "object" || !map.sessions || Array.isArray(map.sessions)) {
    throw new SessionStoreCorruptError(path, "unknown map shape or version");
  }
  return map;
}
function readFileOrNull(path) {
  try {
    return readFileSync3(path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
var tempCounter = 0;
function writeBufferFully(fd, buffer, writer = writeSync) {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const written = writer(fd, buffer, offset, remaining);
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      throw new Error(`session store write made invalid progress: ${String(written)} of ${remaining} bytes`);
    }
    offset += written;
  }
}
function fsyncDirectoryBestEffort(path) {
  let fd = null;
  try {
    fd = openSync2(path, "r");
    fsyncSync(fd);
  } catch {
  } finally {
    try {
      if (fd !== null) closeSync2(fd);
    } catch {
    }
  }
}
function writeFileAtomic(path, data) {
  const directory = dirname(path);
  mkdirSync4(directory, { recursive: true, mode: 448 });
  const tempPath = `${path}.${process.pid}.${++tempCounter}.tmp`;
  let fd = null;
  try {
    fd = openSync2(tempPath, "w", 384);
    writeBufferFully(fd, Buffer.from(data, "utf8"));
    try {
      fsyncSync(fd);
    } catch {
    }
    closeSync2(fd);
    fd = null;
    renameSync2(tempPath, path);
    fsyncDirectoryBestEffort(directory);
  } catch (error) {
    try {
      if (fd !== null) closeSync2(fd);
    } catch {
    }
    try {
      unlinkSync3(tempPath);
    } catch {
    }
    throw error;
  }
}
var SessionStore = class {
  legacyMapPath;
  stateDir;
  constructor(path = getPiAcpSessionMapPath()) {
    this.legacyMapPath = path;
    this.stateDir = `${path}.d`;
  }
  recordPath(sessionId) {
    const encoded = Buffer.from(sessionId, "utf-8").toString("base64url");
    const name = encoded.length <= 180 ? encoded : `sha256-${createHash("sha256").update(sessionId).digest("hex")}`;
    return join6(this.stateDir, `${name}.json`);
  }
  readLegacy(sessionId) {
    const raw = readFileOrNull(this.legacyMapPath);
    if (raw === null) return null;
    const map = parseLegacyMap(this.legacyMapPath, raw);
    const entry = map.sessions[sessionId];
    if (entry === void 0) return null;
    if (!isStoredSession(entry) || entry.sessionId !== sessionId) {
      throw new SessionStoreCorruptError(this.legacyMapPath, `invalid legacy entry for ${sessionId}`);
    }
    return entry;
  }
  readDirect(sessionId) {
    const path = this.recordPath(sessionId);
    const raw = readFileOrNull(path);
    return raw === null ? null : parseRecord(path, raw, sessionId);
  }
  get(sessionId) {
    const record2 = this.readDirect(sessionId);
    if (record2) return record2.deleted ? null : record2.session;
    return this.readLegacy(sessionId);
  }
  /** Enumerate live records, including legacy entries not hidden by tombstones. */
  async list() {
    const byId = /* @__PURE__ */ new Map();
    let legacyRaw = null;
    try {
      legacyRaw = await readFile(this.legacyMapPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (legacyRaw !== null) {
      const legacy = parseLegacyMap(this.legacyMapPath, legacyRaw);
      for (const [id, session] of Object.entries(legacy.sessions)) {
        if (!isStoredSession(session) || session.sessionId !== id) {
          throw new SessionStoreCorruptError(this.legacyMapPath, `invalid legacy entry for ${id}`);
        }
        byId.set(id, session);
      }
    }
    let names = [];
    try {
      names = (await readdir(this.stateDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names) {
      const path = join6(this.stateDir, name);
      const record2 = parseRecord(path, await readFile(path, "utf8"));
      const id = record2.deleted ? record2.sessionId : record2.session.sessionId;
      if (path !== this.recordPath(id)) {
        throw new SessionStoreCorruptError(path, `record filename does not match sessionId ${id}`);
      }
      if (record2.deleted) byId.delete(id);
      else byId.set(id, record2.session);
    }
    return [...byId.values()];
  }
  upsert(entry) {
    this.readDirect(entry.sessionId);
    const record2 = {
      version: 1,
      session: {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        sessionFile: entry.sessionFile,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
    writeFileAtomic(this.recordPath(entry.sessionId), JSON.stringify(record2, null, 2) + "\n");
  }
  delete(sessionId) {
    this.readDirect(sessionId);
    const record2 = { version: 1, deleted: true, sessionId };
    writeFileAtomic(this.recordPath(sessionId), JSON.stringify(record2, null, 2) + "\n");
  }
};

// src/acp/session-repository.ts
import { createReadStream } from "fs";
import { open as open2, readdir as readdir2, realpath, stat, unlink } from "fs/promises";
import { dirname as dirname2, join as join8, isAbsolute as isAbsolute3, relative, resolve as resolve3 } from "path";
import { homedir as homedir3 } from "os";

// src/acp/pi-settings.ts
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join7, resolve as resolve2 } from "path";
function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}
function readJsonFile(path) {
  try {
    if (!existsSync3(path)) return {};
    const raw = readFileSync4(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}
function getMergedPiSettings(cwd) {
  const globalSettingsPath = join7(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve2(cwd, ".pi", "settings.json");
  const global = readJsonFile(globalSettingsPath);
  const project2 = readJsonFile(projectSettingsPath);
  return deepMerge(global, project2);
}
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join7(homedir2(), ".pi", "agent");
}

// src/acp/session-cwd.ts
import { RequestError as RequestError4 } from "@agentclientprotocol/sdk";
import { realpathSync as realpathSync2, statSync as statSync5 } from "fs";
import { posix, win32 as win322 } from "path";
var MAX_DISPLAY_PATH_LENGTH = 240;
function runtimePathFlavor() {
  return process.platform === "win32" ? "win32" : "posix";
}
function pathApi(flavor) {
  return flavor === "win32" ? win322 : posix;
}
function displayPath(path) {
  const clipped = path.length <= MAX_DISPLAY_PATH_LENGTH ? path : `${path.slice(0, MAX_DISPLAY_PATH_LENGTH - 3)}...`;
  return JSON.stringify(clipped);
}
function normalizeCwdForComparison(cwd, flavor = runtimePathFlavor()) {
  const api = pathApi(flavor);
  const normalized = api.normalize(cwd);
  const rootLength = api.parse(normalized).root.length;
  const trailingSeparators = flavor === "win32" ? /[\\/]+$/ : /\/+$/;
  const withoutTrailingSeparators = normalized.length > rootLength ? normalized.replace(trailingSeparators, "") : normalized;
  return flavor === "win32" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}
function physicalPath(path) {
  try {
    return realpathSync2.native(path);
  } catch {
    return null;
  }
}
function sessionCwdsEquivalent(left, right, flavor) {
  if (flavor) return normalizeCwdForComparison(left, flavor) === normalizeCwdForComparison(right, flavor);
  return normalizeCwdForComparison(physicalPath(left) ?? left) === normalizeCwdForComparison(physicalPath(right) ?? right);
}
function assertValidSessionCwd(cwd) {
  if (!pathApi(runtimePathFlavor()).isAbsolute(cwd)) {
    throw RequestError4.invalidParams(
      { reason: "CWD_NOT_ABSOLUTE" },
      `cwd must be an absolute path: ${displayPath(cwd)}`
    );
  }
  let stats;
  try {
    stats = statSync5(cwd);
  } catch (error) {
    const code = error.code;
    const reason = code === "ENOENT" ? "CWD_NOT_FOUND" : "CWD_UNAVAILABLE";
    const message = code === "ENOENT" ? `cwd does not exist: ${displayPath(cwd)}` : `cwd is not accessible: ${displayPath(cwd)}`;
    throw RequestError4.invalidParams({ reason, ...code ? { code } : {} }, message);
  }
  if (!stats.isDirectory()) {
    throw RequestError4.invalidParams(
      { reason: "CWD_NOT_DIRECTORY" },
      `cwd must be an existing directory: ${displayPath(cwd)}`
    );
  }
}

// src/acp/session-repository.ts
var HEADER_LIMIT = 1024 * 1024;
var METADATA_RECORD_LIMIT = 1024 * 1024;
var METADATA_FILE_LIMIT = 8 * 1024 * 1024;
var TITLE_LIMIT = 80;
var RESOURCE_EXHAUSTION_CODES = /* @__PURE__ */ new Set(["EMFILE", "ENFILE", "ENOMEM"]);
function rethrowResourceExhaustion(error) {
  if (RESOURCE_EXHAUSTION_CODES.has(error.code ?? "")) throw error;
}
function expandDirectory(value, cwd) {
  const expanded = value === "~" ? homedir3() : value.startsWith("~/") || value.startsWith("~\\") ? join8(homedir3(), value.slice(2)) : value;
  return isAbsolute3(expanded) ? expanded : resolve3(cwd, expanded);
}
function defaultSessionDirectory(cwd, agentDir = getAgentDir()) {
  const encoded = resolve3(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
  return join8(agentDir, "sessions", `--${encoded}--`);
}
function resolveSessionDirectory(cwd, env = process.env, agentDir = getAgentDir()) {
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (fromEnv) return { path: expandDirectory(fromEnv, cwd), custom: true };
  const configured = getMergedPiSettings(cwd).sessionDir;
  if (typeof configured === "string" && configured.trim()) {
    return { path: expandDirectory(configured.trim(), cwd), custom: true };
  }
  return { path: defaultSessionDirectory(cwd, agentDir), custom: false };
}
async function readBounded(path, maxBytes, position = 0) {
  let handle;
  try {
    handle = await open2(path, "r");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    rethrowResourceExhaustion(error);
    return null;
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function validatedHeader(path, requestedId) {
  const head = await readBounded(path, HEADER_LIMIT);
  if (!head) return null;
  const newline = head.indexOf("\n");
  if (newline < 0 && Buffer.byteLength(head) >= HEADER_LIMIT) return null;
  try {
    const value = JSON.parse((newline < 0 ? head : head.slice(0, newline)).trim());
    if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string" || !value.cwd)
      return null;
    if (requestedId !== void 0 && value.id !== requestedId) return null;
    return { sessionId: value.id, cwd: value.cwd };
  } catch {
    return null;
  }
}
function userMessageTitle(value) {
  const message = value.message;
  if (value.type !== "message" || message?.role !== "user") return null;
  if (typeof message.content === "string") return message.content.slice(0, TITLE_LIMIT);
  if (!Array.isArray(message.content)) return null;
  const block = message.content.find((item) => item.type === "text");
  return typeof block?.text === "string" ? block.text.slice(0, TITLE_LIMIT) : null;
}
async function* boundedRecords(path, state) {
  const input2 = createReadStream(path, { start: 0, end: METADATA_FILE_LIMIT });
  let remaining = METADATA_FILE_LIMIT;
  let chunks = [];
  let length = 0;
  let oversized = false;
  const append = (chunk) => {
    if (oversized || chunk.length === 0) return;
    if (length + chunk.length > METADATA_RECORD_LIMIT) {
      chunks = [];
      length = 0;
      oversized = true;
      return;
    }
    chunks.push(Buffer.from(chunk));
    length += chunk.length;
  };
  const take = () => {
    if (oversized) return null;
    const record2 = Buffer.concat(chunks, length);
    const end = record2.at(-1) === 13 ? record2.length - 1 : record2.length;
    return record2.subarray(0, end).toString("utf8");
  };
  for await (const raw of input2) {
    let chunk = raw;
    if (chunk.length > remaining) {
      chunk = chunk.subarray(0, remaining);
      state.truncated = true;
    }
    remaining -= chunk.length;
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      append(chunk.subarray(start, index));
      const record2 = take();
      if (record2 !== null) yield record2;
      chunks = [];
      length = 0;
      oversized = false;
      start = index + 1;
    }
    append(chunk.subarray(start));
    if (state.truncated) break;
  }
  if (!state.truncated && chunks.length && !oversized) yield take();
}
async function scanMetadata(path) {
  let explicitTitle = null;
  let firstUserTitle = null;
  let latestMessageTimestamp = null;
  let anyTimestamp = null;
  const state = { truncated: false };
  try {
    for await (const line of boundedRecords(path, state)) {
      try {
        const value = JSON.parse(line);
        if (value.type === "session_info" && typeof value.name === "string" && value.name.trim()) {
          explicitTitle = value.name.trim().slice(0, TITLE_LIMIT);
        }
        firstUserTitle ??= userMessageTitle(value);
        if (typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))) {
          const timestamp = new Date(value.timestamp).toISOString();
          anyTimestamp = timestamp;
          if (value.type === "message") latestMessageTimestamp = timestamp;
        }
      } catch {
      }
    }
  } catch (error) {
    rethrowResourceExhaustion(error);
    return null;
  }
  return {
    title: explicitTitle ?? firstUserTitle,
    updatedAt: latestMessageTimestamp ?? anyTimestamp,
    truncated: state.truncated
  };
}
function isNewer(candidate, previous) {
  const timestampOrder = (candidate.updatedAt ?? "").localeCompare(previous.updatedAt ?? "");
  return timestampOrder > 0 || timestampOrder === 0 && candidate.sessionFile.localeCompare(previous.sessionFile) > 0;
}
async function project(path, requestedId, knownHeader) {
  const header = knownHeader ?? await validatedHeader(path, requestedId);
  if (!header) return null;
  let mtime = null;
  try {
    mtime = (await stat(path)).mtime;
  } catch (error) {
    rethrowResourceExhaustion(error);
    return null;
  }
  const metadata = await scanMetadata(path);
  const title = metadata?.title ?? null;
  const updatedAt = metadata?.truncated ? mtime?.toISOString() ?? null : metadata?.updatedAt ?? mtime?.toISOString() ?? null;
  return { ...header, title, updatedAt, sessionFile: path };
}
function sessionDiscoveryRoot(cwd, env, agentDir) {
  const resolved = resolveSessionDirectory(cwd, env, agentDir);
  return resolved.custom ? resolved.path : join8(agentDir, "sessions");
}
function addStoredDiscoveryRoot(roots, stored, env, agentDir) {
  const configuredRoot = sessionDiscoveryRoot(stored.cwd, env, agentDir);
  const fromRoot = relative(resolve3(configuredRoot), resolve3(stored.sessionFile));
  roots.add(!fromRoot.startsWith("..") && !isAbsolute3(fromRoot) ? configuredRoot : dirname2(stored.sessionFile));
}
async function jsonlFiles(root) {
  const files2 = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await readdir2(dir, { withFileTypes: true });
    } catch (error) {
      rethrowResourceExhaustion(error);
      continue;
    }
    for (const entry of entries) {
      const path = join8(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files2.push(path);
    }
  }
  return files2;
}
var SessionRepository = class {
  constructor(store = new SessionStore(), env = process.env, agentDir = getAgentDir()) {
    this.store = store;
    this.env = env;
    this.agentDir = agentDir;
  }
  store;
  env;
  agentDir;
  /** Register an explicitly supplied legacy Pi history; never modify its contents. */
  async importFile(cwd, sessionFile) {
    if (!isAbsolute3(cwd) || !isAbsolute3(sessionFile) || !sessionFile.endsWith(".jsonl"))
      throw new Error("Import requires absolute cwd and a Pi JSONL file");
    const path = await realpath(sessionFile);
    const header = await validatedHeader(path);
    if (!header || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(header.sessionId) || !sessionCwdsEquivalent(header.cwd, cwd))
      throw new Error("Invalid Pi history or cwd mismatch");
    const previous = this.store.get(header.sessionId);
    if (previous && await realpath(previous.sessionFile) !== path)
      throw new Error("Session identity is already mapped to another history");
    this.store.upsert({ ...header, sessionFile: path });
    return { sessionId: header.sessionId };
  }
  upsert(entry) {
    this.store.upsert(entry);
  }
  tombstone(sessionId) {
    this.store.delete(sessionId);
  }
  stored(sessionId) {
    return this.store.get(sessionId);
  }
  async matchingRecords(sessionId, cwd) {
    const stored = this.store.get(sessionId);
    const paths = /* @__PURE__ */ new Set();
    const roots = /* @__PURE__ */ new Set();
    if (stored) {
      paths.add(stored.sessionFile);
      addStoredDiscoveryRoot(roots, stored, this.env, this.agentDir);
    }
    if (cwd || !stored) roots.add(sessionDiscoveryRoot(cwd ?? process.cwd(), this.env, this.agentDir));
    for (const root of roots) for (const file of await jsonlFiles(root)) paths.add(file);
    const records = [];
    for (const path of paths) {
      const candidate = await project(path, sessionId);
      if (candidate) records.push(candidate);
    }
    return records;
  }
  async find(sessionId, cwd) {
    const stored = this.store.get(sessionId);
    if (stored && !(this.store instanceof SessionStore)) {
      return { ...stored, title: null, updatedAt: stored.updatedAt ?? null };
    }
    let newest = null;
    for (const candidate of await this.matchingRecords(sessionId, cwd)) {
      if (!newest || isNewer(candidate, newest)) newest = candidate;
    }
    if (!newest) return null;
    this.store.upsert({ sessionId: newest.sessionId, cwd: newest.cwd, sessionFile: newest.sessionFile });
    return newest;
  }
  async list(cwd) {
    const paths = /* @__PURE__ */ new Set();
    const roots = /* @__PURE__ */ new Set([sessionDiscoveryRoot(cwd ?? process.cwd(), this.env, this.agentDir)]);
    for (const stored of await this.store.list()) {
      paths.add(stored.sessionFile);
      addStoredDiscoveryRoot(roots, stored, this.env, this.agentDir);
    }
    for (const root of roots) for (const file of await jsonlFiles(root)) paths.add(file);
    const headers = /* @__PURE__ */ new Map();
    const scopedIds = /* @__PURE__ */ new Set();
    for (const path of paths) {
      const header = await validatedHeader(path);
      if (!header) continue;
      headers.set(path, header);
      if (!cwd || sessionCwdsEquivalent(header.cwd, cwd)) scopedIds.add(header.sessionId);
    }
    const records = [];
    for (const [path, header] of headers) {
      if (!scopedIds.has(header.sessionId)) continue;
      const record2 = await project(path, void 0, header);
      if (record2) records.push(record2);
    }
    const byId = /* @__PURE__ */ new Map();
    for (const record2 of records) {
      const previous = byId.get(record2.sessionId);
      if (!previous || isNewer(record2, previous)) byId.set(record2.sessionId, record2);
    }
    return [...byId.values()].filter((record2) => !cwd || sessionCwdsEquivalent(record2.cwd, cwd)).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.sessionId.localeCompare(b.sessionId));
  }
  async delete(sessionId) {
    const records = await this.matchingRecords(sessionId);
    let newest = null;
    for (const record2 of records) {
      if (!newest || isNewer(record2, newest)) newest = record2;
      try {
        await unlink(record2.sessionFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    this.store.delete(sessionId);
    return newest?.sessionFile ?? null;
  }
};

// src/acp/file-snapshot.ts
import { closeSync as closeSync3, constants, fstatSync, openSync as openSync3, readSync as readSync2, statSync as statSync6 } from "fs";
var MAX_SNAPSHOT_BYTES = 1024 * 1024;
function fileSnapshot(path) {
  let fd;
  let found = false;
  try {
    const before = statSync6(path);
    found = true;
    if (!before.isFile() || before.size > MAX_SNAPSHOT_BYTES) return void 0;
    fd = openSync3(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_SNAPSHOT_BYTES)
      return void 0;
    const buffer = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync2(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    const current = statSync6(path);
    if (length > MAX_SNAPSHOT_BYTES || length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.dev !== after.dev || current.ino !== after.ino)
      return void 0;
    return buffer.subarray(0, length).toString("utf8");
  } catch (error) {
    return !found && error.code === "ENOENT" ? null : void 0;
  } finally {
    if (fd !== void 0) closeSync3(fd);
  }
}

// src/acp/session.ts
import { isAbsolute as isAbsolute4, resolve as resolvePath2 } from "path";

// src/acp/session-errors.ts
import { RequestError as RequestError5 } from "@agentclientprotocol/sdk";
function toRequestError(err) {
  if (err instanceof RequestError5) return err;
  const message = err instanceof Error ? err.message : String(err);
  return RequestError5.internalError({}, message);
}
function terminationError(termination) {
  const base = termination.reason === "error" ? `pi process failed: ${termination.error instanceof Error ? termination.error.message : String(termination.error)}` : `pi process exited unexpectedly (code=${termination.code}, signal=${termination.signal})`;
  const tail = termination.stderrTail.trim();
  return new Error(tail ? `${base}. Last stderr output: ${tail.slice(-400)}` : base);
}

// src/acp/session-config.ts
import { RequestError as RequestError6 } from "@agentclientprotocol/sdk";

// src/acp/thinking-levels.ts
var ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var FALLBACK_THINKING_LEVELS = ["off"];
function isThinkingLevel(x) {
  return ALL_THINKING_LEVELS.includes(x);
}
function supportedThinkingLevels(model) {
  const record2 = model;
  if (record2?.reasoning !== true) return ["off"];
  const map = record2.thinkingLevelMap && typeof record2.thinkingLevelMap === "object" ? record2.thinkingLevelMap : void 0;
  return ALL_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== void 0;
    return true;
  });
}

// src/acp/session-config.ts
var MODEL_CONFIG_ID = "model";
var THOUGHT_LEVEL_CONFIG_ID = "thought_level";
function thinkingLevelsFromState(state) {
  const model = state?.model;
  if (!model || typeof model !== "object") return FALLBACK_THINKING_LEVELS;
  const supported = supportedThinkingLevels(model);
  return supported.length ? supported : FALLBACK_THINKING_LEVELS;
}
async function availableThinkingLevels(proc, state) {
  if (typeof proc.getAvailableThinkingLevels !== "function") return thinkingLevelsFromState(state);
  try {
    const data = await proc.getAvailableThinkingLevels();
    const raw = Array.isArray(data) ? data : Array.isArray(data?.levels) ? data.levels : [];
    return raw.filter((level) => typeof level === "string" && isThinkingLevel(level));
  } catch (error) {
    if (error.unsupportedCommand) return thinkingLevelsFromState(state);
    throw error;
  }
}
async function assertThinkingLevelSupported(proc, level) {
  let state;
  try {
    state = await proc.getState();
  } catch (e) {
    throw RequestError6.internalError(
      {},
      `Cannot verify thinking level support (get_state failed): ${String(e?.message ?? e)}`
    );
  }
  const supported = await availableThinkingLevels(proc, state);
  if (!supported.includes(level)) {
    throw RequestError6.invalidParams(
      {},
      `Thinking level not supported by the current model: ${level} (supported: ${supported.join(", ")})`
    );
  }
}
async function applyThinkingLevel(proc, level) {
  await assertThinkingLevelSupported(proc, level);
  await proc.setThinkingLevel(level);
  let state;
  try {
    state = await proc.getState();
  } catch (e) {
    throw RequestError6.internalError(
      {},
      `Could not verify the thinking level after set_thinking_level: ${String(e?.message ?? e)}`
    );
  }
  const applied = state?.thinkingLevel;
  if (applied !== level) {
    throw RequestError6.internalError(
      {},
      `pi did not apply thinking level ${level} (current: ${typeof applied === "string" ? applied : "unknown"})`
    );
  }
  return state;
}
async function getThoughtLevelState(proc, pre) {
  const state = Object.prototype.hasOwnProperty.call(pre ?? {}, "state") ? pre?.state : await proc.getState();
  const available = await availableThinkingLevels(proc, state);
  const tl = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
  let current = tl && isThinkingLevel(tl) ? tl : "off";
  if (!available.includes(current)) {
    current = available.includes("off") ? "off" : available[0] ?? "off";
  }
  return { available, current };
}
async function getSessionConfiguration(proc, pre) {
  const hasState = Object.prototype.hasOwnProperty.call(pre ?? {}, "state");
  const hasAvailableModels = Object.prototype.hasOwnProperty.call(pre ?? {}, "availableModels");
  const [state, availableModels] = await Promise.all([
    hasState ? Promise.resolve(pre?.state) : proc.getState(),
    hasAvailableModels ? Promise.resolve(pre?.availableModels) : proc.getAvailableModels()
  ]);
  const prefetched = { state, availableModels };
  const [models, thoughtLevel] = await Promise.all([
    getModelState(proc, prefetched),
    getThoughtLevelState(proc, { state: prefetched.state })
  ]);
  return buildConfigOptions({ models, thoughtLevel });
}
function buildConfigOptions(state) {
  const configOptions = [
    {
      type: "select",
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
      name: "Thinking",
      description: "Set the reasoning effort for this session",
      currentValue: state.thoughtLevel.current,
      options: state.thoughtLevel.available.map((level) => ({
        value: level,
        name: `Thinking: ${level}`,
        description: null
      }))
    }
  ];
  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: "select",
      id: MODEL_CONFIG_ID,
      category: "model",
      name: "Model",
      description: "Select the model for this session",
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    });
  }
  return configOptions;
}
async function getModelState(proc, pre) {
  let availableModels = [];
  const data = Object.prototype.hasOwnProperty.call(pre ?? {}, "availableModels") ? pre?.availableModels : (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi RPC payload is validated at this boundary.
    await proc.getAvailableModels()
  );
  const models = Array.isArray(data?.models) ? data.models : [];
  availableModels = models.map((m) => {
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    if (!provider || !id) return null;
    const name = String(m?.name ?? id);
    return {
      modelId: `${provider}/${id}`,
      name: `${provider}/${name}`,
      description: null
    };
  }).filter(Boolean);
  let currentModelId = null;
  const state = Object.prototype.hasOwnProperty.call(pre ?? {}, "state") ? pre?.state : await proc.getState();
  const model = state?.model;
  if (model && typeof model === "object") {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }
  if (!availableModels.length && !currentModelId) return null;
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";
  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default"
  };
}
async function emitConfigOptionsUpdate(sink, sessionId, proc, pre) {
  const configOptions = await getSessionConfiguration(proc, pre);
  await sink.sendSessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions
    }
  });
  return configOptions;
}
async function applySessionModel(proc, requestedModelId) {
  let provider = null;
  let modelId = null;
  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }
  if (!provider) {
    const data = await proc.getAvailableModels();
    const models = Array.isArray(data?.models) ? data.models : [];
    const found = models.find((m) => String(m?.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }
  if (!provider || !modelId) {
    throw RequestError6.invalidParams({}, `Unknown modelId: ${requestedModelId}`);
  }
  await proc.setModel(provider, modelId);
  let state;
  try {
    state = await proc.getState();
  } catch (e) {
    throw RequestError6.internalError(
      {},
      `Could not verify the model after set_model: ${String(e?.message ?? e)}`
    );
  }
  const model = state?.model;
  const appliedProvider = model && typeof model === "object" ? String(model.provider ?? "").trim() : "";
  const appliedId = model && typeof model === "object" ? String(model.id ?? "").trim() : "";
  if (appliedProvider !== provider || appliedId !== modelId) {
    const current = appliedProvider && appliedId ? `${appliedProvider}/${appliedId}` : "unknown";
    throw RequestError6.internalError({}, `pi did not apply model ${provider}/${modelId} (current: ${current})`);
  }
  return state;
}

// src/acp/session.ts
var CONFIRM_PERMISSION_OPTIONS = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" }
];
var PI_TURN_BOUND_EVENT_TYPES = /* @__PURE__ */ new Set([
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end"
]);
var DEFERRED_ADMISSION_TIMEOUT_MS = 10 * 6e4;
var EXTENSION_UI_RAW_INPUT_KEYS = ["title", "message", "options", "placeholder", "prefill"];
var CHOICE_OPTION_PREFIX = "choice-";
function customMessageIdentity(message, blocks) {
  const record2 = message;
  let detailsIdentity;
  try {
    detailsIdentity = JSON.stringify(record2?.details ?? null);
  } catch {
    detailsIdentity = "unserializable";
  }
  return JSON.stringify([
    typeof record2?.customType === "string" ? record2.customType : null,
    blocks.map((block) => block.kind === "text" ? ["text", block.text] : ["image", block.mimeType, block.data]),
    detailsIdentity
  ]);
}
var PiAcpSession = class {
  sessionId;
  cwd;
  startupInfo = null;
  startupInfoSent = false;
  activeAdapterPromptTurns = 0;
  customMessageSequence = 0;
  pendingCustomMessages = [];
  publishedTitle;
  sessionInfoSyncTail = Promise.resolve();
  publishedConfigFingerprint;
  publishedThoughtLevel;
  publishedConfigOptions = [];
  configurationSyncTail = Promise.resolve();
  configurationMutationDepth = 0;
  configurationEpoch = 0;
  deferredThinkingLevel;
  proc;
  conn;
  supportsElicitationForm;
  pendingUiRequests = /* @__PURE__ */ new Map();
  // Fabricated terminal references and terminal_* metadata are a negotiated
  // Zed convention; never expose them to a client that did not opt in.
  supportsTerminalOutputMeta;
  // Auth methods the owning agent advertised at initialize; auth-required
  // errors raised from this session must advertise exactly these.
  authMethods;
  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  cancelRequested = false;
  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
  // Adapter-handled command currently holding the FIFO. A prompt turn and a
  // command are mutually exclusive: both are admitted through the same queue.
  activeCommand = null;
  turnQueue = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  currentToolCalls = /* @__PURE__ */ new Map();
  streamedToolCalls = /* @__PURE__ */ new Map();
  // Tool calls already reported as completed/failed in the current turn.
  settledToolCallIds = /* @__PURE__ */ new Set();
  // pi can emit multiple `turn_end` and `agent_end` events for a single user
  // prompt: `turn_end` closes one assistant/tool exchange, and `agent_end`
  // closes one low-level agent run, after which pi (>= 0.80.4) may continue
  // with automatic retries, compaction retries, and queued continuations.
  // Only `agent_settled` marks the fully settled prompt. This flag tracks
  // whether the current ACP turn claimed execution via its `agent_start` or,
  // for a queued follow-up inside an existing run, its user `message_start`.
  // Prompts handled without either boundary (e.g. extension commands or input
  // hooks) can then complete without hanging.
  agentRunObserved = false;
  // Stop-reason tracking for the current turn. `lastDoneReason` records the
  // most recent assistantMessageEvent `done` reason ('length' maps to ACP
  // max_tokens); `turnFailure` records a run failure that must fail the ACP
  // turn once pi settles (agent_settled stays the sole settlement boundary).
  lastDoneReason = null;
  turnFailure = null;
  // Set once when the pi child terminates; used to fail (or cancel) any
  // accepted turn deterministically instead of waiting for agent_settled.
  procTermination = null;
  // pi can run autonomously with no ACP-owned turn (e.g. an extension calling
  // sendMessage with triggerTurn). `agent_start` with no owned ACP turn raises
  // this gate; only an unambiguous `agent_settled` clears it (a get_state
  // isStreaming=false snapshot is not authoritative: pi flips the flag before
  // emitting agent_settled). While raised, an admitted turn defers its raw
  // prompt dispatch instead of racing pi's busy check.
  piBusyOutOfBand = false;
  // Pi's low-level agent can restart inside one AgentSession run for retries,
  // compaction, or messages queued by agent_end hooks. A restart without one
  // of those observable precursors is an uncorrelatable nested top-level run;
  // fail closed rather than consuming its settlement as the current boundary.
  lowLevelAgentEnded = false;
  piQueueHasMessages = false;
  // Queue removal precedes awaited extension hooks and message_start. With no
  // queue-origin IDs, only settlement safely retires this steering evidence.
  steeringTextsInRun = /* @__PURE__ */ new Set();
  continuationExpected = false;
  lifecycleAmbiguity = null;
  // Two independent things can be held back by the out-of-band gate: a prompt's
  // raw dispatch and an adapter command's admission. They are deliberately
  // separate state machines, so every settlement path (complete, fail, cancel,
  // shutdown, disposal, termination) must clear *both*.
  deferredDispatch = null;
  deferredAdmissionTimer = null;
  // Adapter command holding the FIFO slot while an out-of-band pi run settles.
  deferredCommandAdmission = null;
  deferredCommandAdmissionTimer = null;
  deferredAdmissionTimeoutMs;
  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  fileSnapshots = /* @__PURE__ */ new Map();
  fileMutationToolCallIds = /* @__PURE__ */ new Set();
  bashToolCallIds = /* @__PURE__ */ new Set();
  subagentToolCallIds = /* @__PURE__ */ new Set();
  bashOutputSnapshots = /* @__PURE__ */ new Map();
  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  lastEmit = Promise.resolve();
  // Settlement trackers for every turn-based `session/prompt` (in-flight and
  // queued). Agent-level tracking also covers adapter-handled prompt paths.
  outstandingTurns = /* @__PURE__ */ new Set();
  closing = false;
  shutdownPromise = null;
  unsubscribe;
  disposed = false;
  disposalExpected = false;
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.supportsElicitationForm = opts.supportsElicitationForm ?? false;
    this.supportsTerminalOutputMeta = opts.supportsTerminalOutputMeta ?? false;
    this.authMethods = opts.authMethods ?? [];
    this.deferredAdmissionTimeoutMs = opts.deferredAdmissionTimeoutMs ?? DEFERRED_ADMISSION_TIMEOUT_MS;
    this.unsubscribe = this.proc.onEvent((ev) => this.handlePiEvent(ev));
    this.proc.onTermination((termination) => this.handleProcessTermination(termination));
  }
  handleProcessTermination(termination) {
    this.procTermination = termination;
    this.drainPendingUiRequests();
    const turn = this.pendingTurn;
    if (termination.expected || this.closing || this.disposalExpected) this.cancelRequested = true;
    const failure = this.terminalFailure(termination, this.activeCommand?.cancelled);
    this.failActiveCommand(failure);
    this.settleQueuedWorkForTermination(termination);
    this.releaseDeferredCommandAdmission(failure);
    if (!turn || turn.completionStarted) return;
    this.failTurn(turn, terminationError(termination));
  }
  /**
   * Record on the command holding the FIFO slot that it can no longer produce a
   * result, because the channel died or was fault-quarantined under it.
   *
   * `failure` is null only for a client cancel or adapter-driven teardown,
   * which keep ACP cancellation semantics; otherwise the command must reject
   * rather than report a benign cancellation for work pi never completed.
   * `cancelled` is set either way, which is what stops every publication path
   * (including {@link CommandContext.sendSessionUpdate}).
   */
  failActiveCommand(failure) {
    const command = this.activeCommand;
    if (!command) return;
    command.cancelled = true;
    if (failure) command.terminalFailure ??= failure;
  }
  /**
   * The error a command must reject with instead of reporting success, or null
   * when ACP cancellation semantics apply. Combines a failure recorded while it
   * waited with a live check, because termination can land between any two of
   * the command's await boundaries. The first non-null classification is
   * memoized so every later recheck rejects with the same error.
   */
  commandTerminalFailure(command) {
    if (command.terminalFailure) return command.terminalFailure;
    const failure = this.terminalFailure(this.procTermination, command.cancelled);
    if (failure) command.terminalFailure = failure;
    return failure;
  }
  /** Drain and settle every queued prompt/command once the child is gone. */
  settleQueuedWorkForTermination(termination) {
    const queued = this.turnQueue.splice(0, this.turnQueue.length);
    if (!queued.length) return;
    void this.flushEmits().finally(() => this.settleTerminalQueue(queued, termination));
  }
  /**
   * Settle queued work that can never run because the channel is closing or the
   * child is gone. A client cancel or adapter-driven teardown keeps ACP
   * cancellation semantics; an unexpected exit rejects with the termination
   * error instead, so a queued request never reports a benign outcome for work
   * pi never ran.
   */
  settleTerminalQueue(queued, termination) {
    const failure = this.terminalFailure(termination);
    if (!failure) {
      this.settleCancelledQueue(queued);
      return;
    }
    for (const entry of queued) {
      if (entry.kind === "prompt") entry.reject(failure);
      else entry.fail(failure);
    }
  }
  /**
   * The error every request still waiting on this child must reject with, or
   * null when ACP cancellation semantics apply instead (client cancel or
   * adapter-driven teardown). One classification for queued work and for a
   * command parked on the out-of-band admission gate.
   */
  terminalFailure(termination, cancelled = false) {
    if (cancelled || termination?.expected || this.closing || this.disposalExpected) return null;
    if (termination) return this.toTurnFailure(terminationError(termination));
    if (this.disposed && !this.disposalExpected) {
      return this.toTurnFailure(
        new Error("pi process was shut down after an unrecoverable fault before this request could run.")
      );
    }
    return null;
  }
  /** Map an internal failure onto the ACP error a turn-based request rejects with. */
  toTurnFailure(err) {
    return maybeAuthRequiredError(err, this.authMethods) ?? toRequestError(err);
  }
  dispose(options) {
    this.drainPendingUiRequests();
    if (this.disposed) return;
    this.disposed = true;
    this.disposalExpected = options?.expected ?? true;
    const failure = this.terminalFailure(null, this.activeCommand?.cancelled);
    this.failActiveCommand(failure);
    this.clearDeferredDispatch();
    this.releaseDeferredCommandAdmission(failure);
    try {
      this.unsubscribe();
    } finally {
      this.proc.dispose({
        expected: this.disposalExpected,
        ...this.pendingTurn?.piRunOwned ? { backgroundOwner: this.pendingTurn.owner } : {}
      });
    }
  }
  setStartupInfo(text) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }
  /**
   * Emit the deferred startup info as an `agent_message_chunk`, if not yet
   * sent. Must be called while a `session/prompt` turn is active (i.e. from
   * `startTurn`): ACP forbids turn-bound updates outside an active prompt
   * (https://github.com/svkozak/pi-acp/issues/59).
   */
  sendStartupInfoIfPending() {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo }
    });
  }
  beginAdapterPromptTurn() {
    this.activeAdapterPromptTurns += 1;
    this.sendStartupInfoIfPending();
    this.sendPendingCustomMessages();
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      this.activeAdapterPromptTurns -= 1;
      await this.flushEmits();
    };
  }
  async publishUsageAndGet(opts) {
    let stats;
    try {
      stats = await this.proc.getSessionStats();
    } catch {
      return void 0;
    }
    const record2 = stats;
    const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
    const inputTokens = finite(record2.tokens?.input);
    const outputTokens = finite(record2.tokens?.output);
    const totalTokens = finite(record2.tokens?.total);
    if (inputTokens === void 0 || outputTokens === void 0 || totalTokens === void 0) return void 0;
    const used = finite(record2.contextUsage?.tokens);
    const size = finite(record2.contextUsage?.contextWindow);
    if (used !== void 0 && size !== void 0) {
      const amount = finite(record2.cost);
      await this.sendSessionUpdate(
        {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used,
            size,
            ...amount === void 0 ? {} : { cost: { amount, currency: "USD" } }
          }
        },
        { isStale: opts?.isStale }
      ).catch(() => {
      });
    }
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cachedReadTokens: finite(record2.tokens?.cacheRead),
      cachedWriteTokens: finite(record2.tokens?.cacheWrite)
    };
  }
  currentCustomMessageSequence() {
    return this.customMessageSequence;
  }
  reconcileLoadedCustomMessages(messages, throughSequence) {
    const replayedByIdentity = /* @__PURE__ */ new Map();
    for (const message of messages) {
      const record2 = message;
      if (record2?.role !== "custom" || record2.display !== true) continue;
      const blocks = translateCustomMessageContent(record2.content);
      if (!blocks.length) continue;
      const identity = customMessageIdentity(message, blocks);
      replayedByIdentity.set(identity, (replayedByIdentity.get(identity) ?? 0) + 1);
    }
    const reconciledSequences = /* @__PURE__ */ new Set();
    const reconcile = (pendingMessages) => {
      for (const message of pendingMessages) {
        const remaining = replayedByIdentity.get(message.identity) ?? 0;
        if (remaining === 0) continue;
        replayedByIdentity.set(message.identity, remaining - 1);
        reconciledSequences.add(message.sequence);
      }
    };
    reconcile(this.pendingCustomMessages.filter((message) => message.sequence <= throughSequence));
    const retained = this.pendingCustomMessages.filter((message) => !reconciledSequences.has(message.sequence));
    this.pendingCustomMessages.splice(0, this.pendingCustomMessages.length, ...retained);
  }
  sendPendingCustomMessages() {
    const messages = this.pendingCustomMessages.splice(0);
    for (const message of messages) {
      this.emitCustomMessageBlocks(message.blocks);
    }
  }
  emitCustomMessageBlocks(blocks) {
    for (const block of blocks) {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: block.kind === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType }
      });
    }
  }
  async prompt(message, images = [], beforeRelease) {
    if (this.isClosing()) return "cancelled";
    const turnPromise = new Promise((resolve5, reject) => {
      const queued = { kind: "prompt", message, images, resolve: resolve5, reject, beforeRelease };
      if (this.isBusy() || this.turnQueue.length) {
        this.turnQueue.push(queued);
        this.emitQueuedNotice();
        return;
      }
      this.startTurn(queued);
    });
    const tracked = turnPromise.then(
      () => void 0,
      () => void 0
    );
    this.outstandingTurns.add(tracked);
    void tracked.then(() => this.outstandingTurns.delete(tracked));
    return turnPromise;
  }
  /**
   * Run adapter-handled slash command work inside the session FIFO: it waits
   * for an active prompt (or earlier command), keeps later prompts queued
   * while it runs, and `cancel()` settles it promptly. Resolves `null` when
   * the command was cancelled before or during execution.
   */
  async runCommand(run) {
    const entryFailure = this.terminalFailure(this.procTermination);
    if (entryFailure) throw entryFailure;
    if (this.procTermination || this.isClosing()) return null;
    const command = { cancelled: false };
    if (!await this.admitCommandForExecution(command)) {
      if (command.terminalFailure) throw command.terminalFailure;
      return null;
    }
    const admissionFailure = this.commandTerminalFailure(command);
    if (admissionFailure) {
      this.releaseCommandSlotFor(command);
      throw admissionFailure;
    }
    if (command.cancelled || this.isClosing()) {
      this.releaseCommandSlotFor(command);
      return null;
    }
    const settled = () => command.cancelled || Boolean(this.commandTerminalFailure(command));
    const ctx = {
      cancelled: settled,
      sendSessionUpdate: (params) => settled() ? Promise.resolve() : this.sendSessionUpdate(params, { isStale: settled })
    };
    const finishAdapterPromptTurn = this.beginAdapterPromptTurn();
    try {
      const result = await (async () => {
        try {
          return await run(ctx);
        } finally {
          await this.syncSessionConfiguration(void 0, void 0, () => this.isClosing()).catch(() => {
          });
        }
      })();
      const failure = this.commandTerminalFailure(command);
      if (failure) throw failure;
      return command.cancelled ? null : result;
    } catch (error) {
      const failure = this.commandTerminalFailure(command);
      if (failure) throw failure;
      if (command.cancelled) return null;
      throw error;
    } finally {
      await finishAdapterPromptTurn();
      this.releaseCommandSlot();
    }
  }
  releaseCommandSlot() {
    this.activeCommand = null;
    this.startNextQueuedWork();
  }
  /**
   * Admit an adapter command into the FIFO and keep it out of pi's way until the
   * out-of-band gate is genuinely clear at the moment its body starts.
   *
   * `agent_settled` admits a parked command synchronously, but pi's stdout
   * records are dispatched as one synchronous batch, so a later `agent_start`
   * in the same batch can re-raise the gate before this caller's microtask
   * runs. (A deferred prompt dispatch is immune because it is sent from inside
   * that same handler.) Recheck after every resumption and re-park -- keeping
   * the FIFO slot, so later prompts stay queued -- until the gate is clear.
   */
  async admitCommandForExecution(command) {
    if (!await this.admitCommand(command)) return false;
    while (!command.cancelled && this.piBusyOutOfBand && !this.procTermination && !this.isClosing()) {
      const readmitted = await new Promise((resolve5, reject) => {
        this.admitClaimedCommand({ command, admit: resolve5, fail: reject });
      });
      if (!readmitted) return false;
    }
    return true;
  }
  admitCommand(command) {
    if (!this.isBusy() && !this.turnQueue.length) {
      this.activeCommand = command;
      return new Promise((resolve5, reject) => {
        this.admitClaimedCommand({ command, admit: resolve5, fail: reject });
      });
    }
    return new Promise((resolve5, reject) => {
      this.turnQueue.push({ kind: "command", command, admit: resolve5, fail: reject });
      this.emitQueuedNotice();
    });
  }
  /**
   * Release a command that already holds the FIFO slot. Adapter commands reach
   * pi through manual RPCs that pi will not abort, so one must never start
   * while an autonomous run owns the event stream: keep the claimed slot (so
   * later prompts stay queued) until that run reaches its authoritative
   * `agent_settled` boundary, and fail closed if it never arrives. A dead or
   * closing channel never defers -- the command's own RPC fails fast instead of
   * parking behind a run that can no longer settle.
   *
   * Every park of one command shares a single absolute deadline, so re-parking
   * after a same-batch gate re-raise cannot extend the bounded wait.
   */
  admitClaimedCommand(entry) {
    if (!this.piBusyOutOfBand || this.procTermination || this.isClosing()) {
      entry.admit(true);
      return;
    }
    const command = entry.command;
    command.admissionDeadlineAt ??= Date.now() + this.deferredAdmissionTimeoutMs;
    const remainingMs = command.admissionDeadlineAt - Date.now();
    if (remainingMs <= 0) {
      this.failClaimedCommandAdmission(entry);
      return;
    }
    this.deferredCommandAdmission = entry;
    const timer = setTimeout(() => {
      if (this.deferredCommandAdmissionTimer === timer) this.deferredCommandAdmissionTimer = null;
      if (this.deferredCommandAdmission !== entry) return;
      this.deferredCommandAdmission = null;
      this.failClaimedCommandAdmission(entry);
    }, remainingMs);
    this.deferredCommandAdmissionTimer = timer;
  }
  /**
   * The out-of-band run never reached its settlement boundary within the
   * command's whole admission budget. The child lifecycle can no longer be
   * correlated safely, so quarantine it, hand the FIFO slot on, and reject.
   */
  failClaimedCommandAdmission(entry) {
    const error = new Error("Timed out waiting for out-of-band pi work to settle before running the command.");
    this.dispose({ expected: false });
    this.releaseCommandSlotFor(entry.command);
    entry.fail(error);
  }
  /** Admit a parked command at pi's authoritative settlement boundary. */
  admitDeferredCommand() {
    const entry = this.takeDeferredCommandAdmission();
    entry?.admit(true);
  }
  /**
   * Settle a parked command admission without running it (cancel, shutdown,
   * disposal, termination). It never reached pi, so it settles locally and
   * hands its FIFO slot to whatever is next. The command stays marked cancelled
   * either way so no later resumption can run its body.
   *
   * `failure` is set only when the child died unexpectedly or the channel was
   * fault-quarantined: that request never ran and must not report a benign
   * cancellation. Callers that pass it also record it via
   * {@link failActiveCommand}, which is what {@link runCommand} converts into a
   * rejection; rejecting the parked promise here simply keeps that failure on
   * the awaiting call's own boundary instead of relying on the recorded copy.
   */
  releaseDeferredCommandAdmission(failure = null) {
    const entry = this.takeDeferredCommandAdmission();
    if (!entry) return;
    entry.command.cancelled = true;
    this.releaseCommandSlotFor(entry.command);
    if (failure) entry.fail(failure);
    else entry.admit(false);
  }
  takeDeferredCommandAdmission() {
    const entry = this.deferredCommandAdmission;
    this.deferredCommandAdmission = null;
    if (this.deferredCommandAdmissionTimer) {
      clearTimeout(this.deferredCommandAdmissionTimer);
      this.deferredCommandAdmissionTimer = null;
    }
    return entry;
  }
  /**
   * Hand on the FIFO slot of a command that never entered `runCommand`'s body,
   * which is the only path that releases the slot itself.
   */
  releaseCommandSlotFor(command) {
    if (this.activeCommand !== command) return;
    this.releaseCommandSlot();
  }
  isBusy() {
    return Boolean(this.pendingTurn || this.activeCommand);
  }
  emitQueuedNotice() {
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Queued message (position ${this.turnQueue.length}).`
      }
    });
    this.publishQueueState(true, this.turnQueue.length);
  }
  /** Publish queue depth via session info metadata. (Not visible in Zed yet.) */
  publishQueueState(running, queueDepth) {
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth, running } }
    });
  }
  /** Settle drained queue entries that never got to run. */
  settleCancelledQueue(queued) {
    for (const entry of queued) {
      if (entry.kind === "prompt") entry.resolve("cancelled");
      else entry.admit(false);
    }
  }
  async cancel() {
    this.drainPendingUiRequests();
    this.cancelRequested = true;
    const queued = this.turnQueue.splice(0, this.turnQueue.length);
    if (queued.length) {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." }
      });
      this.publishQueueState(this.isBusy(), 0);
    }
    const activeCommand = this.activeCommand;
    if (activeCommand) {
      activeCommand.cancelled = true;
      this.releaseDeferredCommandAdmission();
      if (this.proc.hasPendingRequests()) this.dispose();
      await this.flushEmits();
      this.settleCancelledQueue(queued);
      return;
    }
    const activeTurn = this.pendingTurn;
    if (activeTurn && !activeTurn.promptDispatched) {
      this.clearDeferredDispatch();
      this.completeTurn(activeTurn);
      await this.flushEmits();
      this.settleCancelledQueue(queued);
      return;
    }
    if (!activeTurn || activeTurn.completionStarted) {
      if (queued.length) {
        await this.flushEmits();
        this.settleCancelledQueue(queued);
      }
      return;
    }
    if (!activeTurn.piRunOwned) {
      this.dispose();
      this.completeTurn(activeTurn);
      await this.flushEmits();
      this.settleCancelledQueue(queued);
      return;
    }
    activeTurn.cancellationPending = true;
    try {
      await this.proc.abort(activeTurn.owner);
      activeTurn.cancellationPending = false;
      activeTurn.backgroundActive = false;
      if (this.pendingTurn === activeTurn && activeTurn.piSettled) this.completeTurn(activeTurn);
    } catch (error) {
      if (!this.disposed)
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Cancellation failed: ${error instanceof Error ? error.message : String(error)}; detached work may still be running.`
          }
        });
      this.dispose();
      const turn = this.pendingTurn;
      if (turn) this.completeTurn(turn);
    } finally {
      if (queued.length) {
        await this.flushEmits();
        this.settleCancelledQueue(queued);
      }
    }
  }
  /**
   * Cancel all in-flight and queued turn work and wait for it to settle with
   * `cancelled` after final updates flush. Agent-level lifecycle tracking waits
   * adapter-handled prompts after this turn shutdown and process disposal.
   */
  shutdown() {
    if (!this.shutdownPromise) {
      this.closing = true;
      this.shutdownPromise = this.runShutdown();
    }
    return this.shutdownPromise;
  }
  async runShutdown() {
    this.drainPendingUiRequests();
    this.cancelRequested = true;
    if (this.activeCommand) this.activeCommand.cancelled = true;
    this.clearDeferredDispatch();
    this.releaseDeferredCommandAdmission();
    const queued = this.turnQueue.splice(0, this.turnQueue.length);
    if (this.pendingTurn) this.pendingTurn.cancellationPending = true;
    try {
      await this.proc.abort(this.pendingTurn?.piRunOwned ? this.pendingTurn.owner : void 0);
    } catch (error) {
      if (this.pendingTurn?.piRunOwned)
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Cancellation failed: ${String(error)}; detached work may still be running.` }
        });
    }
    const turn = this.pendingTurn;
    if (turn) this.completeTurn(turn);
    await this.flushEmits();
    this.settleCancelledQueue(queued);
    await Promise.all([...this.outstandingTurns]);
    await this.flushEmits();
  }
  /**
   * `isStale` is evaluated *inside* the ordered chain, not before enqueueing:
   * an update can wait here behind a slow client delivery, and a replacement
   * session registered under the same sessionId in that window has its own
   * chain, so a stale publication would otherwise land after the replacement's.
   * It is opt-in per call so ordinary updates -- including final ones during
   * teardown -- are never suppressed.
   */
  enqueueUpdate(update, isStale) {
    const delivery = this.lastEmit.then(() => {
      if (isStale?.()) return;
      if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text" && update.content.text.length === 0)
        return;
      return this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      });
    });
    this.lastEmit = delivery.catch(() => {
    });
    return delivery;
  }
  emit(update) {
    void this.enqueueUpdate(update);
  }
  sendSessionUpdate(params, opts) {
    if (params.sessionId !== this.sessionId) {
      return Promise.reject(new Error(`session update mismatch: ${params.sessionId}`));
    }
    return this.enqueueUpdate(params.update, opts?.isStale);
  }
  /**
   * Publish the session title through its serialized queue. Adapter commands
   * pass `isCancelled` because this operation can wait behind unrelated work:
   * the check is re-run inside the queued callback so a title cannot reach the
   * client after its command was cancelled.
   */
  syncSessionInfo(name, isCancelled) {
    const title = name ?? null;
    const operation = this.sessionInfoSyncTail.then(async () => {
      if (this.disposed || isCancelled?.()) return;
      if (this.publishedTitle === title) return this.flushEmits();
      await this.enqueueUpdate(
        {
          sessionUpdate: "session_info_update",
          title,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        },
        isCancelled
      );
      if (!isCancelled?.()) this.publishedTitle = title;
    });
    this.sessionInfoSyncTail = operation.catch(() => {
    });
    return operation;
  }
  // An ACP-driven publication is authoritative: bumping the epoch discards
  // every configuration probe requested or read before this state.
  seedSessionConfiguration(configOptions) {
    this.configurationEpoch += 1;
    this.applyPublishedConfiguration(configOptions);
  }
  applyPublishedConfiguration(configOptions) {
    this.publishedConfigOptions = configOptions;
    this.publishedConfigFingerprint = JSON.stringify(configOptions);
    const thoughtOption = configOptions.find((option) => option.id === THOUGHT_LEVEL_CONFIG_ID);
    this.publishedThoughtLevel = thoughtOption && typeof thoughtOption.currentValue === "string" ? thoughtOption.currentValue : void 0;
  }
  // Pi echoes ACP thinking mutations as events; hold that echo until the
  // request's own configuration publication has seeded the de-duplication state.
  beginConfigurationMutation() {
    this.configurationMutationDepth += 1;
    this.configurationEpoch += 1;
  }
  async endConfigurationMutation() {
    if (this.configurationMutationDepth === 0) return;
    this.configurationMutationDepth -= 1;
    if (this.configurationMutationDepth > 0 || this.deferredThinkingLevel === void 0) return;
    const level = this.deferredThinkingLevel;
    this.deferredThinkingLevel = void 0;
    await this.syncSessionConfiguration(void 0, level).catch(() => {
    });
  }
  syncSessionConfiguration(pre, expectedThoughtLevel, isCancelled) {
    const epoch = this.configurationEpoch;
    const isStale = () => this.isUnavailable() || this.configurationEpoch !== epoch || Boolean(isCancelled?.());
    const operation = this.configurationSyncTail.then(async () => {
      if (isStale()) return this.publishedConfigOptions;
      if (expectedThoughtLevel !== void 0 && this.publishedThoughtLevel === expectedThoughtLevel && this.publishedConfigFingerprint !== void 0) {
        return this.publishedConfigOptions;
      }
      const configOptions = await getSessionConfiguration(this.proc, pre);
      if (isStale()) return this.publishedConfigOptions;
      const fingerprint = JSON.stringify(configOptions);
      if (this.publishedConfigFingerprint !== fingerprint) {
        await this.enqueueUpdate(
          {
            sessionUpdate: "config_option_update",
            configOptions
          },
          isStale
        );
        if (isStale()) return this.publishedConfigOptions;
        this.applyPublishedConfiguration(configOptions);
      }
      return configOptions;
    });
    this.configurationSyncTail = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  async flushEmits() {
    await this.lastEmit;
  }
  emitBashToolCall(params) {
    this.bashToolCallIds.add(params.toolCallId);
    const includeTerminal = params.includeTerminal && this.supportsTerminalOutputMeta;
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: "execute",
      status: params.status,
      locations: params.locations,
      ...includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {},
      ...includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {}
    });
  }
  emitBashOutputUpdate(params) {
    if (!this.supportsTerminalOutputMeta) {
      const content = bashOrderedContent(params.result);
      this.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status: params.status,
        ...content.length ? { content } : {}
      });
      return;
    }
    const text = bashResultText(params.result);
    const imageContent = toolResultImageBlocks(params.result).map((image) => ({
      type: "content",
      content: { type: "image", data: image.data, mimeType: image.mimeType }
    }));
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text);
    this.bashOutputSnapshots.set(params.toolCallId, text);
    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      status: params.status,
      ...imageContent.length ? { content: [...bashTerminalContent(params.toolCallId), ...imageContent] } : {},
      _meta: {
        ...delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {},
        ...params.status === "completed" || params.status === "failed" ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError))) : {}
      }
    });
  }
  /**
   * Pi can report progress or completion for a tool whose start event was
   * never observed. ACP requires a `tool_call` before any update for that id,
   * so synthesize one from the reporting event. Returns false once the call
   * settled so a duplicate or late event cannot resurrect a finished card.
   */
  ensureToolCallStarted(toolCallId, toolName, args) {
    if (this.settledToolCallIds.has(toolCallId)) return false;
    if (this.currentToolCalls.has(toolCallId)) return true;
    this.currentToolCalls.set(toolCallId, "in_progress");
    const locations = toToolCallLocations(toolName, args, this.cwd);
    if (isBashTool(toolName)) {
      this.emitBashToolCall({
        sessionUpdate: "tool_call",
        toolCallId,
        toolName,
        args,
        status: "in_progress",
        locations,
        includeTerminal: true
      });
      return true;
    }
    if (toolName === "subagent") this.subagentToolCallIds.add(toolCallId);
    this.emit({
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName,
      kind: toToolKind(toolName),
      status: "in_progress",
      ...locations ? { locations } : {},
      ...args === void 0 ? {} : { rawInput: args }
    });
    return true;
  }
  cleanupToolCall(toolCallId) {
    this.settledToolCallIds.add(toolCallId);
    for (const [index, call] of this.streamedToolCalls) {
      if (call.id === toolCallId) this.streamedToolCalls.delete(index);
    }
    this.currentToolCalls.delete(toolCallId);
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.subagentToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }
  terminalizeToolCalls() {
    for (const toolCallId of this.currentToolCalls.keys()) {
      this.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        ...this.bashToolCallIds.has(toolCallId) && this.supportsTerminalOutputMeta ? { _meta: bashTerminalExitMeta(toolCallId, 1) } : {}
      });
      this.cleanupToolCall(toolCallId);
    }
    this.streamedToolCalls.clear();
    this.fileSnapshots.clear();
    this.fileMutationToolCallIds.clear();
    this.bashToolCallIds.clear();
    this.subagentToolCallIds.clear();
    this.bashOutputSnapshots.clear();
  }
  startTurn(t) {
    this.settledToolCallIds.clear();
    this.cancelRequested = false;
    this.agentRunObserved = false;
    this.lastDoneReason = null;
    this.turnFailure = null;
    const turn = {
      owner: crypto.randomUUID(),
      backgroundActive: false,
      cancellationPending: false,
      piSettled: false,
      agentRunEverObserved: false,
      resolve: t.resolve,
      reject: t.reject,
      completionStarted: false,
      promptDispatched: false,
      promptAccepted: false,
      piRunOwned: false,
      promptQueued: false,
      expectedPromptText: t.message,
      matchingPromptMessagesToSkip: 0,
      beforeRelease: t.beforeRelease
    };
    this.pendingTurn = turn;
    this.sendStartupInfoIfPending();
    if (!this.piBusyOutOfBand) this.sendPendingCustomMessages();
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    });
    this.dispatchOrDefer(turn, t.message, t.images);
  }
  dispatchOrDefer(turn, message, images) {
    if (this.pendingTurn !== turn || turn.completionStarted) return;
    if (this.piBusyOutOfBand && !this.procTermination) {
      this.deferredDispatch = { turn, message, images };
      const timer = setTimeout(() => {
        if (this.deferredAdmissionTimer === timer) this.deferredAdmissionTimer = null;
        if (this.deferredDispatch?.turn !== turn) return;
        this.deferredDispatch = null;
        const error = new Error("Timed out waiting for out-of-band pi work to settle before dispatching the prompt.");
        this.dispose({ expected: false });
        this.failTurn(turn, error);
      }, this.deferredAdmissionTimeoutMs);
      this.deferredAdmissionTimer = timer;
      return;
    }
    this.dispatchPrompt(turn, message, images);
  }
  dispatchPrompt(turn, message, images) {
    if (this.pendingTurn !== turn || turn.completionStarted) return;
    this.sendPendingCustomMessages();
    this.agentRunObserved = false;
    this.lastDoneReason = null;
    this.turnFailure = null;
    turn.promptDispatched = true;
    const markAccepted = () => {
      if (this.pendingTurn !== turn || turn.completionStarted || turn.promptAccepted) return;
      turn.promptAccepted = true;
      if (!this.piBusyOutOfBand && !turn.promptQueued && !this.lifecycleAmbiguity) {
        turn.piRunOwned = true;
        this.sendPendingCustomMessages();
      }
    };
    this.proc.prompt(message, images, markAccepted, turn.owner).then(() => {
      markAccepted();
      this.handlePromptAccepted(turn);
    }).catch((err) => {
      if (err instanceof PiRpcRequestTimeoutError && err.command === "prompt") {
        this.dispose({ expected: false });
      }
      this.failTurn(turn, err);
    });
  }
  /**
   * Drop the held dispatch payload and its admission timer. `deferredDispatch`
   * always refers to the current pending turn, so every settlement path
   * (complete, fail, cancel, shutdown, disposal, process termination) clears
   * it unconditionally and no late timeout can send or settle it twice.
   */
  clearDeferredDispatch() {
    this.deferredDispatch = null;
    if (this.deferredAdmissionTimer) {
      clearTimeout(this.deferredAdmissionTimer);
      this.deferredAdmissionTimer = null;
    }
  }
  /**
   * Called when pi's `prompt` RPC request settles successfully. That response
   * is an acceptance response, not an execution result: if an agent run was
   * (or is being) started, keep the ACP turn open until `agent_settled`.
   * Otherwise the prompt was handled without an agent run and no further
   * lifecycle events will arrive, so probe pi's state and complete the turn
   * instead of hanging forever.
   */
  handlePromptAccepted(turn) {
    if (this.pendingTurn !== turn || turn.completionStarted || !turn.promptAccepted || turn.agentRunEverObserved || turn.backgroundActive)
      return;
    void this.proc.getState().then(
      (state) => {
        if (this.pendingTurn !== turn || turn.completionStarted || turn.agentRunEverObserved || turn.backgroundActive)
          return;
        const isStreaming = Boolean(state?.isStreaming);
        if (!isStreaming) this.completeTurn(turn);
      },
      (err) => {
        if (this.pendingTurn !== turn || turn.completionStarted || turn.agentRunEverObserved || turn.backgroundActive)
          return;
        const failure = this.procTermination ? terminationError(this.procTermination) : err;
        this.dispose({ expected: false });
        this.failTurn(turn, failure);
      }
    );
  }
  /**
   * Resolve the ACP `session/prompt` at a safe boundary: claim the pending
   * turn synchronously (making completion idempotent across the
   * `agent_settled` and no-agent-run paths), flush every queued
   * `session/update` so turn-bound notifications are delivered in-turn,
   * resolve, and only then start the next queued adapter prompt.
   */
  completeTurn(turn) {
    if (this.pendingTurn !== turn || turn.completionStarted) return;
    turn.completionStarted = true;
    this.terminalizeToolCalls();
    this.clearDeferredDispatch();
    const reason = this.cancelRequested ? "cancelled" : this.lastDoneReason === "length" ? "max_tokens" : "end_turn";
    void (async () => {
      try {
        if (turn.promptDispatched) {
          await this.syncSessionConfiguration(void 0, void 0, () => this.isClosing()).catch(() => {
          });
        }
        await this.flushEmits();
        if (turn.promptDispatched) await turn.beforeRelease?.();
      } catch {
      } finally {
        this.pendingTurn = null;
        turn.resolve(reason);
        this.startNextQueuedWork();
      }
    })();
  }
  failTurn(turn, err, piSettled = false) {
    if (this.pendingTurn !== turn || turn.completionStarted) return;
    turn.completionStarted = true;
    this.terminalizeToolCalls();
    this.clearDeferredDispatch();
    const reconcile = piSettled ? this.syncSessionConfiguration(void 0, void 0, () => this.isClosing()).catch(() => {
    }) : Promise.resolve();
    void reconcile.then(() => this.flushEmits()).finally(() => {
      const cancelled = this.cancelRequested;
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      this.pendingTurn = null;
      void this.flushEmits().finally(() => {
        const failQueued = (error) => {
          for (const entry of queued) {
            if (entry.kind === "prompt") entry.reject(error);
            else entry.fail(error);
          }
        };
        if (cancelled) {
          turn.resolve("cancelled");
          this.settleCancelledQueue(queued);
        } else {
          const failure = this.toTurnFailure(err);
          turn.reject(failure);
          failQueued(failure);
        }
        if (!this.isBusy()) {
          this.emit({
            sessionUpdate: "session_info_update",
            _meta: { piAcp: { queueDepth: 0, running: false } }
          });
        }
      });
    });
  }
  isUnavailable() {
    return this.disposed || this.procTermination !== null;
  }
  isClosing() {
    return this.closing || this.disposed;
  }
  /**
   * Hand the FIFO to the next queued prompt or command, or publish the
   * terminal idle queue metadata when nothing is left to run -- including on
   * the closing/quarantined path. Settled work always publishes it: an
   * admitted command already published `running: true` via
   * {@link emitQueuedNotice}, so staying silent here would leave that as the
   * client's last snapshot.
   */
  startNextQueuedWork() {
    if (this.isBusy()) return;
    const termination = this.procTermination;
    if (this.isClosing() || termination) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      this.publishQueueState(false, 0);
      if (queued.length) {
        void this.flushEmits().finally(() => this.settleTerminalQueue(queued, termination));
      }
      return;
    }
    const next = this.turnQueue.shift();
    if (!next) {
      this.publishQueueState(false, 0);
      return;
    }
    if (next.kind === "command") {
      this.activeCommand = next.command;
      this.admitClaimedCommand(next);
      return;
    }
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Starting queued message. (${this.turnQueue.length} remaining)` }
    });
    this.startTurn(next);
  }
  /**
   * Whether `turn` owns pi's current run, i.e. whether turn-bound events,
   * custom messages, and extension UI requests belong to that ACP prompt.
   *
   * A dispatched-but-not-yet-accepted prompt owns the run only while pi is not
   * observably busy with autonomous work. Once accepted, `piRunOwned` is the
   * only proof: an accepted prompt queued as a follow-up (`promptQueued`) does
   * not own pi's run until its own user message enters it.
   */
  turnOwnsPiRun(turn) {
    return Boolean(
      turn && !turn.completionStarted && !this.lifecycleAmbiguity && (turn.piRunOwned || turn.promptDispatched && !turn.promptAccepted && !this.piBusyOutOfBand)
    );
  }
  handlePiEvent(ev) {
    const type = ev.type;
    const turn = this.pendingTurn;
    if (type === "queue_update") {
      const steering = Array.isArray(ev.steering) ? ev.steering : [];
      const followUp = Array.isArray(ev.followUp) ? ev.followUp : [];
      this.piQueueHasMessages = steering.length > 0 || followUp.length > 0;
      for (const text of steering) {
        if (typeof text === "string") this.steeringTextsInRun.add(text);
      }
      if (turn?.promptDispatched && !turn.promptAccepted && !turn.completionStarted) {
        const queuedText = followUp.at(-1);
        if (typeof queuedText === "string") {
          turn.promptQueued = true;
          turn.expectedPromptText = queuedText;
          turn.matchingPromptMessagesToSkip = followUp.slice(0, -1).filter((item) => item === queuedText).length;
        }
      }
      if (turn?.promptQueued && !turn.piRunOwned && !turn.completionStarted && this.steeringTextsInRun.has(turn.expectedPromptText)) {
        const error = new Error("Pi queued steering text indistinguishable from the accepted follow-up prompt.");
        this.lifecycleAmbiguity = error;
        this.dispose({ expected: false });
        this.failTurn(turn, error);
        return;
      }
      if (this.lowLevelAgentEnded && this.piQueueHasMessages) this.continuationExpected = true;
    }
    if (type === "auto_retry_start" || type === "auto_compaction_start" || type === "compaction_start") {
      this.continuationExpected = true;
    }
    if ((type === "compaction_end" || type === "auto_compaction_end") && ev.willRetry !== true) {
      this.continuationExpected = false;
    }
    if (type === "message_start" && turn?.promptAccepted && !turn.piRunOwned && !turn.completionStarted && !this.lifecycleAmbiguity && piUserMessageText(ev) === turn.expectedPromptText) {
      if (turn.matchingPromptMessagesToSkip > 0) {
        turn.matchingPromptMessagesToSkip -= 1;
      } else {
        turn.piRunOwned = true;
        turn.agentRunEverObserved = true;
        this.agentRunObserved = true;
        this.sendPendingCustomMessages();
      }
    }
    const ownsPiTurn = this.turnOwnsPiRun(turn);
    const suppressUnownedPiOutput = !ownsPiTurn && (this.piBusyOutOfBand || Boolean(turn?.promptDispatched) || Boolean(turn?.completionStarted) || Boolean(this.lifecycleAmbiguity));
    if (PI_TURN_BOUND_EVENT_TYPES.has(type) && suppressUnownedPiOutput) return;
    switch (type) {
      case "session_info_changed": {
        const name = ev.name;
        if (name !== void 0 && typeof name !== "string") break;
        const command = this.activeAdapterPromptTurns > 0 ? this.activeCommand : null;
        const isCancelled = command ? () => command.cancelled || Boolean(this.commandTerminalFailure(command)) : void 0;
        void this.syncSessionInfo(name, isCancelled).catch(() => {
        });
        break;
      }
      case "extension_error": {
        const owned = ownsPiTurn && !this.cancelRequested || this.activeAdapterPromptTurns > 0 && !this.activeCommand?.cancelled && !this.piBusyOutOfBand && !this.lifecycleAmbiguity;
        const blocks = [
          {
            kind: "text",
            text: `${owned ? "Pi extension error" : "Deferred pi extension error"} (${ev.extensionPath}, ${ev.event}): ${ev.error}`
          }
        ];
        if (owned) this.emitCustomMessageBlocks(blocks);
        else
          this.pendingCustomMessages.push({
            blocks,
            identity: JSON.stringify(ev),
            sequence: ++this.customMessageSequence
          });
        break;
      }
      case "thinking_level_changed": {
        const level = ev.level;
        if (typeof level !== "string" || !isThinkingLevel(level)) break;
        if (this.configurationMutationDepth > 0) {
          this.deferredThinkingLevel = level;
          break;
        }
        void this.syncSessionConfiguration(void 0, level).catch(() => {
        });
        break;
      }
      case "message_update": {
        const ame = ev.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "toolcall_start" || ame?.type === "toolcall_delta" || ame?.type === "toolcall_end") {
          const contentIndex = typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
          const whole = ame.toolCall;
          if (ame.type === "toolcall_start") {
            const id = typeof ame.id === "string" ? ame.id : typeof whole?.id === "string" ? whole.id : "";
            const name = typeof ame.toolName === "string" ? ame.toolName : typeof whole?.name === "string" ? whole.name : "tool";
            if (this.settledToolCallIds.has(id)) break;
            if (id)
              this.streamedToolCalls.set(contentIndex, {
                id,
                name,
                argumentsText: ""
              });
          }
          const buffered = this.streamedToolCalls.get(contentIndex);
          if (ame.type === "toolcall_delta" && buffered) {
            const delta = typeof ame.argumentsDelta === "string" ? ame.argumentsDelta : typeof ame.delta === "string" ? ame.delta : typeof whole?.partialArgs === "string" ? whole.partialArgs : "";
            buffered.argumentsText += delta;
          }
          const toolCallId = String(whole?.id ?? ame.id ?? buffered?.id ?? "");
          const toolName = String(whole?.name ?? ame.toolName ?? buffered?.name ?? "tool");
          if (toolCallId) {
            if (this.settledToolCallIds.has(toolCallId)) break;
            if (toolName === "subagent") this.subagentToolCallIds.add(toolCallId);
            if (ame.type === "toolcall_delta" && this.subagentToolCallIds.has(toolCallId)) break;
            const rawInput = whole?.arguments && typeof whole.arguments === "object" ? whole.arguments : (() => {
              const s = typeof whole?.partialArgs === "string" ? whole.partialArgs : buffered?.argumentsText ?? "";
              if (!s) return void 0;
              try {
                return JSON.parse(s);
              } catch {
                return { partialArgs: s };
              }
            })();
            if (ame.type === "toolcall_end") this.streamedToolCalls.delete(contentIndex);
            const locations = ame.type === "toolcall_delta" ? void 0 : toToolCallLocations(toolName, rawInput, this.cwd);
            const existingStatus = this.currentToolCalls.get(toolCallId);
            const status = existingStatus ?? "pending";
            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, "pending");
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              });
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, "pending");
              this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              });
            } else {
              this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status,
                locations,
                rawInput
              });
            }
          }
          break;
        }
        if (ame?.type === "done") {
          const reason = typeof ame.reason === "string" ? ame.reason : null;
          if (reason === "stop" || reason === "length" || reason === "toolUse") {
            this.turnFailure = null;
          }
          this.lastDoneReason = reason;
          break;
        }
        if (ame?.type === "error") {
          const reason = typeof ame.reason === "string" ? ame.reason : "error";
          const errorMessage = ame?.error?.errorMessage;
          const detail = typeof errorMessage === "string" && errorMessage ? `: ${errorMessage}` : "";
          if (reason === "aborted") {
            if (!this.cancelRequested) {
              this.turnFailure ??= new Error(`pi aborted the run unexpectedly${detail}`);
            }
          } else {
            this.turnFailure ??= new Error(`pi run failed${detail}`);
          }
          break;
        }
        break;
      }
      case "message_end": {
        const message = ev.message;
        if (message?.role !== "custom" || message.display !== true) break;
        const blocks = translateCustomMessageContent(message.content);
        if (!blocks.length) break;
        const pendingMessage = {
          blocks,
          identity: customMessageIdentity(message, blocks),
          sequence: ++this.customMessageSequence
        };
        const activeTurn = this.pendingTurn;
        if (this.turnOwnsPiRun(activeTurn) || this.activeAdapterPromptTurns > 0) {
          this.emitCustomMessageBlocks(blocks);
        } else {
          this.pendingCustomMessages.push(pendingMessage);
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId = String(ev.toolCallId ?? crypto.randomUUID());
        if (this.settledToolCallIds.has(toolCallId)) break;
        const toolName = String(ev.toolName ?? "tool");
        const args = ev.args;
        let line;
        if (toolName === "subagent") this.subagentToolCallIds.add(toolCallId);
        if (isBashTool(toolName)) {
          const locations2 = toToolCallLocations(toolName, args, this.cwd);
          const existingStatus = this.currentToolCalls.get(toolCallId);
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
            toolCallId,
            toolName,
            args,
            status: "in_progress",
            locations: locations2,
            includeTerminal: !existingStatus
          });
          break;
        }
        const isFileMutation = toolName === "edit" || toolName === "write";
        let snapshotOldText;
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId);
          const p = getToolPath(args);
          if (p) {
            const abs = isAbsolute4(p) ? p : resolvePath2(this.cwd, p);
            snapshotOldText = fileSnapshot(abs);
            if (snapshotOldText !== void 0) {
              this.fileSnapshots.set(toolCallId, {
                path: p,
                oldText: snapshotOldText
              });
              if (toolName === "edit" && snapshotOldText !== null) {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle);
                  if (typeof line === "number") break;
                }
              }
            }
          }
        }
        const locations = toToolCallLocations(toolName, args, this.cwd, line);
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: args
          });
        } else {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            locations,
            rawInput: args
          });
        }
        break;
      }
      case "tool_execution_update": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        if (!this.ensureToolCallStarted(toolCallId, String(ev.toolName ?? "tool"), ev.args)) break;
        const partial = ev.partialResult;
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: "in_progress", result: partial });
          break;
        }
        if (this.subagentToolCallIds.has(toolCallId)) break;
        const content = this.fileMutationToolCallIds.has(toolCallId) ? [] : toolResultToolCallContent(partial);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: content.length ? content : void 0,
          ...this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial }
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const toolName = String(ev.toolName ?? "tool");
        if (!this.ensureToolCallStarted(toolCallId, toolName, ev.args)) break;
        const result = ev.result;
        const isError = Boolean(ev.isError);
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? "failed" : "completed",
            result,
            isError
          });
          this.cleanupToolCall(toolCallId);
          break;
        }
        const orderedContent = toolResultToolCallContent(result);
        const snapshot = this.fileSnapshots.get(toolCallId);
        let content;
        let hasStructuredDiff = false;
        if (!isError && snapshot) {
          try {
            const abs = isAbsolute4(snapshot.path) ? snapshot.path : resolvePath2(this.cwd, snapshot.path);
            const newText = fileSnapshot(abs);
            if (typeof newText === "string" && (snapshot.oldText === null || newText !== snapshot.oldText)) {
              hasStructuredDiff = true;
              content = [
                {
                  // ACP Diff requires an absolute path; pi may report a
                  // cwd-relative one.
                  type: "diff",
                  path: abs,
                  oldText: snapshot.oldText,
                  newText
                }
              ];
            }
          } catch {
          }
        }
        if (content) {
          const images = orderedContent.filter((item) => item.type === "content" && item.content.type === "image");
          if (images.length) content = [...content, ...images];
        } else if (orderedContent.length) {
          content = orderedContent;
        }
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          ...hasStructuredDiff ? {} : { rawOutput: result }
        });
        this.cleanupToolCall(toolCallId);
        break;
      }
      case "extension_ui_request": {
        void this.handleExtensionUiRequest(ev).catch(() => {
        });
        break;
      }
      case "summarization_retry_scheduled": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Summarization: ${formatAutoRetryMessage(ev)}` }
        });
        break;
      }
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: type === "summarization_retry_finished" ? "Summarization retry finished." : "Retrying summarization..."
          }
        });
        break;
      }
      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) }
        });
        break;
      }
      case "auto_retry_end": {
        if (ev.success === false) {
          const finalError = stringProp(ev, "finalError");
          const text = finalError ? `Automatic retry failed: ${finalError}` : "Automatic retry failed.";
          this.turnFailure = new Error(text);
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          });
          break;
        }
        this.turnFailure = null;
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." }
        });
        break;
      }
      // Legacy event names kept for compatibility with older pi versions.
      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction..."
          }
        });
        break;
      }
      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session."
          }
        });
        break;
      }
      case "agent_start": {
        const activeTurn = this.pendingTurn;
        const initialOwnedStart = Boolean(
          activeTurn?.piRunOwned && !activeTurn.completionStarted && !this.agentRunObserved
        );
        const ownedContinuation = Boolean(
          activeTurn?.piRunOwned && !activeTurn.completionStarted && this.continuationExpected
        );
        if (initialOwnedStart || ownedContinuation) {
          this.agentRunObserved = true;
          this.continuationExpected = false;
        } else if (this.piBusyOutOfBand && this.continuationExpected) {
          this.continuationExpected = false;
        } else if (this.piBusyOutOfBand || activeTurn?.piRunOwned && !activeTurn.completionStarted) {
          this.lifecycleAmbiguity ??= new Error(
            "Pi started an uncorrelatable nested run before the current run settled."
          );
          this.piBusyOutOfBand = true;
          this.continuationExpected = false;
        } else {
          this.piBusyOutOfBand = true;
          this.continuationExpected = false;
        }
        if (activeTurn && this.turnOwnsPiRun(activeTurn)) {
          activeTurn.piSettled = false;
          activeTurn.agentRunEverObserved = true;
        }
        this.lowLevelAgentEnded = false;
        break;
      }
      case "turn_end": {
        break;
      }
      case "agent_end": {
        this.lowLevelAgentEnded = true;
        if (this.piQueueHasMessages || ev.willRetry === true) {
          this.continuationExpected = true;
        }
        break;
      }
      case "agent_settled": {
        const ambiguity = this.lifecycleAmbiguity;
        if (ambiguity) {
          this.dispose({ expected: false });
          const ambiguousTurn = this.pendingTurn;
          if (ambiguousTurn && !ambiguousTurn.completionStarted) this.failTurn(ambiguousTurn, ambiguity);
          break;
        }
        this.piBusyOutOfBand = false;
        this.lowLevelAgentEnded = false;
        this.piQueueHasMessages = false;
        this.steeringTextsInRun.clear();
        this.continuationExpected = false;
        this.admitDeferredCommand();
        const activeTurn = this.pendingTurn;
        if (!activeTurn) break;
        if (!activeTurn.promptDispatched) {
          const deferred = this.deferredDispatch;
          if (deferred?.turn === activeTurn) {
            this.clearDeferredDispatch();
            this.dispatchPrompt(activeTurn, deferred.message, deferred.images);
          }
          break;
        }
        if (!activeTurn.promptAccepted) break;
        if (!activeTurn.piRunOwned) {
          const error = new Error("Pi settled before the accepted prompt could be correlated with its run.");
          this.dispose({ expected: false });
          this.failTurn(activeTurn, error);
          break;
        }
        activeTurn.piSettled = true;
        if (activeTurn.backgroundActive || activeTurn.cancellationPending) {
          this.agentRunObserved = false;
          break;
        }
        if (this.turnFailure && !this.cancelRequested) {
          this.failTurn(activeTurn, this.turnFailure, true);
        } else {
          this.completeTurn(activeTurn);
        }
        break;
      }
      case "compaction_start": {
        const reason = stringProp(ev, "reason");
        const label = reason === "overflow" ? "Context overflow; compacting to recover..." : reason === "threshold" ? "Context nearing limit; compacting..." : "Compacting context...";
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: label }
        });
        break;
      }
      case "compaction_end": {
        const errorMessage = stringProp(ev, "errorMessage");
        const aborted = ev.aborted === true;
        const text = errorMessage ? `Compaction failed: ${errorMessage}` : aborted ? "Compaction aborted." : "Compaction finished; context was summarized to continue the session.";
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text }
        });
        break;
      }
      default:
        break;
    }
  }
  beginUiRequest(id) {
    const duplicate = this.pendingUiRequests.get(id);
    if (duplicate) {
      this.settleUiRequest(duplicate, { id, cancelled: true });
      return null;
    }
    const pending = { id, controller: new AbortController() };
    this.pendingUiRequests.set(id, pending);
    return pending;
  }
  settleUiRequest(pending, response) {
    if (this.pendingUiRequests.get(pending.id) !== pending) return;
    this.pendingUiRequests.delete(pending.id);
    pending.controller.abort();
    if (pending.toolCallId) {
      this.emit({ sessionUpdate: "tool_call_update", toolCallId: pending.toolCallId, status: "completed" });
    }
    void this.proc.sendExtensionUiResponse(response).catch(() => {
    });
  }
  drainPendingUiRequests() {
    for (const pending of [...this.pendingUiRequests.values()]) {
      this.settleUiRequest(pending, { id: pending.id, cancelled: true });
    }
  }
  async handleExtensionUiRequest(ev) {
    const id = stringProp(ev, "id");
    const method = stringProp(ev, "method");
    if (!id) {
      return;
    }
    if (method === "setWidget" && ev.widgetKey === "pi-acp-lifecycle") {
      const turn = this.pendingTurn;
      try {
        const lines = ev.widgetLines;
        if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string") return;
        const state = JSON.parse(lines[0]);
        if (!turn || turn.completionStarted || state.version !== 1 || state.owner !== turn.owner) return;
        if (state.state === "error") {
          const error = new Error(`Background harness: ${String(state.error ?? "lifecycle failed")}`);
          this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: error.message } });
          if (turn.cancellationPending) return;
          this.dispose({ expected: false });
          if (this.cancelRequested) this.completeTurn(turn);
          else this.failTurn(turn, error);
        } else if (state.state === "active") {
          turn.backgroundActive = true;
        } else if (state.state === "idle" || state.state === "cancelled") {
          turn.backgroundActive = false;
          if (turn.piSettled && !turn.cancellationPending) {
            if (this.turnFailure && !this.cancelRequested) this.failTurn(turn, this.turnFailure, true);
            else this.completeTurn(turn);
          }
        }
      } catch {
      }
      return;
    }
    if (method === "setStatus" || method === "setWidget" || method === "setTitle" || method === "set_editor_text")
      return;
    const activeTurn = this.pendingTurn;
    const belongsToPrompt = this.turnOwnsPiRun(activeTurn);
    if (!belongsToPrompt && (this.piBusyOutOfBand || Boolean(activeTurn) || Boolean(this.lifecycleAmbiguity))) {
      if (method === "notify") return;
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    if (method === "select") {
      await this.handleExtensionSelect(ev, id);
      return;
    }
    if (method === "confirm") {
      await this.handleExtensionConfirm(ev, id);
      return;
    }
    if (method === "input" || method === "editor") {
      await this.handleExtensionElicitation(ev, id);
      return;
    }
    if (method === "notify") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stringProp(ev, "message") ?? "Pi notification" }
      });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, cancelled: true });
  }
  async handleExtensionSelect(ev, id) {
    const rawOptions = ev.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map((option) => String(option)) : [];
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    const requested = await this.requestExtensionPermission(
      id,
      ev,
      options.map((name, index2) => ({ optionId: `${CHOICE_OPTION_PREFIX}${index2}`, name, kind: "allow_once" }))
    );
    if (!requested) return;
    const selectedId = requested.response.outcome.outcome === "selected" ? requested.response.outcome.optionId : null;
    const index = selectedId === null ? null : optionIndex(selectedId);
    const value = index === null ? null : options.at(index) ?? null;
    this.settleUiRequest(requested.pending, value === null ? { id, cancelled: true } : { id, value });
  }
  async handleExtensionConfirm(ev, id) {
    const requested = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS);
    if (!requested) return;
    const response = requested.response.outcome.outcome === "selected" ? { id, confirmed: requested.response.outcome.optionId === "yes" } : { id, cancelled: true };
    this.settleUiRequest(requested.pending, response);
  }
  async handleExtensionElicitation(ev, id) {
    if (!this.supportsElicitationForm) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    const pending = this.beginUiRequest(id);
    if (!pending) return;
    try {
      const response = await this.conn.createElicitation(
        {
          sessionId: this.sessionId,
          toolCallId: `pi-ui-${id}`,
          mode: "form",
          message: stringProp(ev, "message") ?? stringProp(ev, "title") ?? "Input requested by pi",
          requestedSchema: {
            type: "object",
            properties: {
              value: {
                type: "string",
                title: stringProp(ev, "title") ?? "Value",
                description: stringProp(ev, "placeholder"),
                default: stringProp(ev, "prefill")
              }
            },
            required: ["value"]
          }
        },
        { cancellationSignal: pending.controller.signal }
      );
      if (this.pendingUiRequests.get(id) !== pending) return;
      const value = response.action === "accept" ? response.content?.value : void 0;
      this.settleUiRequest(pending, typeof value === "string" ? { id, value } : { id, cancelled: true });
    } catch {
      this.settleUiRequest(pending, { id, cancelled: true });
    }
  }
  async requestExtensionPermission(id, ev, options) {
    const pending = this.beginUiRequest(id);
    if (!pending) return null;
    const toolCall = extensionUiToolCall(id, ev);
    pending.toolCallId = toolCall.toolCallId;
    this.emit({ sessionUpdate: "tool_call", ...toolCall });
    try {
      await this.flushEmits();
      if (this.pendingUiRequests.get(id) !== pending) return null;
      const response = await this.conn.requestPermission(
        { sessionId: this.sessionId, toolCall, options },
        { cancellationSignal: pending.controller.signal }
      );
      return this.pendingUiRequests.get(id) === pending ? { pending, response } : null;
    } catch {
      this.settleUiRequest(pending, { id, cancelled: true });
      return null;
    }
  }
};
function extensionUiToolCall(id, ev) {
  const method = stringProp(ev, "method") ?? "ui";
  const title = stringProp(ev, "title") ?? `Pi ${method}`;
  const rawInput = { method };
  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key];
  }
  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: "other",
    status: "pending",
    rawInput
  };
}
function piUserMessageText(ev) {
  const message = ev.message;
  if (message?.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  const text = message.content.filter((part) => {
    if (!part || typeof part !== "object") return false;
    const record2 = part;
    return record2.type === "text" && typeof record2.text === "string";
  }).map((part) => part.text).join("\n");
  return text;
}
function stringProp(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : null;
}
function optionIndex(optionId) {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }
  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (!rawIndex) {
    return null;
  }
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null;
}
function formatAutoRetryMessage(ev) {
  const attempt = Number(ev.attempt);
  const maxAttempts = Number(ev.maxAttempts);
  const delayMs = Number(ev.delayMs);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return "Retrying...";
  }
  let delaySeconds = Math.round(delayMs / 1e3);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;
  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}

// src/acp/session-manager.ts
var SessionManager = class {
  sessions = /* @__PURE__ */ new Map();
  // Every pi child this manager is responsible for terminating, tracked from
  // the moment ownership starts until the child actually exits. This is the
  // single ownership record: a process is here whether it is registered under
  // a live session, still being validated by an in-flight create/restore,
  // disposed by a failure path, dropped as a registration race loser, or
  // closed earlier by an ACP connection abort. Final shutdown therefore waits
  // for all of them instead of exiting mid SIGTERM -> SIGKILL escalation.
  owned = /* @__PURE__ */ new Set();
  // Spawn operations that have not settled yet. A pi child exists inside
  // `PiRpcProcess.spawn` before its promise resolves, so shutdown has to know
  // work is in flight even before it can see the process itself.
  pendingSpawns = /* @__PURE__ */ new Set();
  pendingSpawnAborts = /* @__PURE__ */ new Set();
  // Children that have not exited yet, indexed by every identity through which
  // a later restore can reach the same persisted file: the sessionId it was
  // asked for, its session-file path, and (when pi reported a different
  // identity) the reported id and path. Disposal only starts the SIGTERM ->
  // SIGKILL escalation, so a replacement must wait here first: pi session files
  // have no writer coordination, and two live children would interleave their
  // history writes. One process is commonly registered under several keys.
  retiring = /* @__PURE__ */ new Map();
  store;
  disposed = false;
  /** The owning agent shares its store so both sides see one mapping. */
  constructor(store = new SessionStore()) {
    this.store = store;
  }
  /**
   * Dispose all sessions and their underlying pi subprocesses and refuse any
   * later registration: an in-flight create/restore that finishes spawning
   * after teardown must dispose its fresh process instead of installing it.
   */
  disposeAll() {
    this.disposed = true;
    for (const controller of this.pendingSpawnAborts) controller.abort();
    for (const [id] of this.sessions) this.close(id);
  }
  /**
   * Dispose every session and every other owned pi child, then wait (bounded
   * by `timeoutMs`) for them to actually exit. Final adapter shutdown uses
   * this so a child that ignores SIGTERM is still SIGKILLed instead of being
   * orphaned when the adapter process exits.
   */
  async disposeAllAndWait(timeoutMs) {
    this.disposeAll();
    let timedOut = false;
    let timer;
    const deadline = new Promise((resolve5) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve5();
      }, timeoutMs);
    });
    const handled = /* @__PURE__ */ new Set();
    try {
      while (!timedOut) {
        const procs = [...this.owned].filter((proc) => !handled.has(proc));
        const spawns = [...this.pendingSpawns].filter((spawn3) => !handled.has(spawn3));
        if (!procs.length && !spawns.length) return;
        for (const proc of procs) {
          handled.add(proc);
          proc.dispose();
        }
        for (const spawn3 of spawns) handled.add(spawn3);
        await Promise.race([Promise.all([...procs.map((proc) => proc.whenTerminated()), ...spawns]), deadline]);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /**
   * Take ownership of a pi child until it terminates. Idempotent: a process
   * handed back through {@link getOrCreate} is not tracked twice.
   */
  own(proc) {
    if (this.owned.has(proc)) return;
    this.owned.add(proc);
    void proc.whenTerminated().then(() => this.owned.delete(proc));
    if (this.disposed) proc.dispose();
  }
  /**
   * Spawn a pi subprocess owned by this manager. Ownership starts before the
   * caller (or a racing shutdown) can observe the child: `PiRpcProcess.spawn`
   * reports it through `onProcess` the moment the OS process exists, and the
   * operation itself is registered synchronously for the window before that.
   * Every later path -- validation failure, registration race, teardown during
   * the spawn -- is then covered by {@link disposeAllAndWait}.
   */
  spawnOwned(params) {
    if (this.disposed) {
      return Promise.reject(RequestError7.internalError({}, "pi-acp session manager is disposed"));
    }
    const controller = new AbortController();
    this.pendingSpawnAborts.add(controller);
    const spawning = PiRpcProcess.spawn({
      ...params,
      signal: controller.signal,
      onProcess: (proc) => this.own(proc)
    });
    const tracked = spawning.then((proc) => this.own(proc)).catch(() => {
    });
    this.pendingSpawns.add(tracked);
    void tracked.then(() => {
      this.pendingSpawns.delete(tracked);
      this.pendingSpawnAborts.delete(controller);
    });
    return spawning;
  }
  /**
   * Dispose a session and record its child for the replacement barrier. Public
   * because a caller that built a session which never became (or is no longer)
   * the registered one must retire it through the same path: the child already
   * opened that session's persisted file.
   */
  retire(session) {
    this.trackRetired([session.sessionId], session.proc);
    try {
      session.dispose();
    } catch {
    }
  }
  /**
   * Retire a pi child that is not registered under a session but did open that
   * session's persisted file (restore validation failures, registration race
   * losers, teardown during a restore). Plain `proc.dispose()` only *starts*
   * the SIGTERM -> SIGKILL escalation, so skipping this lets the next restore
   * open the same file while this child can still append to it.
   */
  retireProcess(sessionId, proc, aliases = []) {
    this.trackRetired([sessionId, ...aliases], proc);
    proc.dispose();
  }
  /**
   * Register `proc` under every supplied identity. `aliases` matter when pi
   * reported a different session than the one it was asked for: the child may
   * append to either file, so a later restore reaching it by *any* of those
   * identities has to wait for this child to exit.
   */
  trackRetired(keys, proc) {
    let registered = false;
    for (const key of new Set(keys)) {
      if (!key) continue;
      let procs = this.retiring.get(key);
      if (!procs) {
        procs = /* @__PURE__ */ new Set();
        this.retiring.set(key, procs);
      }
      procs.add(proc);
      registered = true;
    }
    if (!registered) return;
    const forget = () => {
      for (const [key, procs] of this.retiring) {
        procs.delete(proc);
        if (procs.size === 0) this.retiring.delete(key);
      }
    };
    void proc.whenTerminated().then(forget, forget);
  }
  /**
   * Bounded fail-closed barrier before a session is restored onto a new pi
   * child: resolve once every child previously retired for this session has
   * actually exited. Callers must not spawn a replacement before this settles,
   * and an expired wait rejects rather than opening the same session file
   * twice.
   */
  async waitForRetiredProcesses(keys, timeoutMs) {
    const wanted = [...new Set((typeof keys === "string" ? [keys] : keys).filter(Boolean))];
    const sessionId = wanted[0] ?? "";
    const stillRetiring = () => {
      const procs = /* @__PURE__ */ new Set();
      for (const key of wanted) {
        for (const proc of this.retiring.get(key) ?? []) procs.add(proc);
      }
      return procs;
    };
    if (!stillRetiring().size) return;
    let timer;
    const expired = /* @__PURE__ */ Symbol("expired");
    const deadline = new Promise((resolve5) => {
      timer = setTimeout(() => resolve5(expired), timeoutMs);
    });
    try {
      const awaited = /* @__PURE__ */ new Set();
      while (true) {
        const pending = [...stillRetiring()].filter((proc) => !awaited.has(proc));
        if (!pending.length) return;
        for (const proc of pending) awaited.add(proc);
        const settled = await Promise.race([Promise.all(pending.map((proc) => proc.whenTerminated())), deadline]);
        if (settled === expired) break;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    throw RequestError7.internalError(
      { sessionId },
      `The previous pi process for session ${sessionId} did not exit within ${timeoutMs}ms; refusing to start a second process on the same session file.`
    );
  }
  assertNotDisposed(proc) {
    if (!this.disposed) return;
    proc?.dispose();
    throw RequestError7.internalError({}, "pi-acp session manager is disposed");
  }
  /** Get a registered, usable session if it exists (no throw). */
  maybeGet(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.isUnavailable()) return session;
    this.retire(session);
    this.sessions.delete(sessionId);
    return void 0;
  }
  /** Remove a session only if it is still the instance the caller observed. */
  evictIfCurrent(sessionId, expectedSession) {
    if (this.sessions.get(sessionId) !== expectedSession) return false;
    this.close(sessionId);
    return true;
  }
  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.retire(session);
    this.sessions.delete(sessionId);
  }
  async create(params) {
    this.assertNotDisposed();
    let proc;
    try {
      proc = await this.spawnOwned({
        cwd: params.cwd,
        sessionDirectory: resolveSessionDirectory(params.cwd).path,
        piCommand: params.piCommand,
        ...params.mcpProxyOnly ? { mcpProxyOnly: true } : {}
      });
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError7.internalError({ code: e.code }, e.message);
      }
      throw e;
    }
    this.assertNotDisposed(proc);
    let state = null;
    try {
      state = await proc.getState();
    } catch (e) {
      proc.dispose();
      throw maybeAuthRequiredError(e, params.authMethods) ?? toRequestError(e);
    }
    this.assertNotDisposed(proc);
    const sessionId = typeof state?.sessionId === "string" && state.sessionId.trim() ? state.sessionId : null;
    const sessionFile = typeof state?.sessionFile === "string" && state.sessionFile.trim() ? state.sessionFile : null;
    if (!sessionId || !sessionFile) {
      proc.dispose();
      throw RequestError7.internalError(
        {},
        "pi did not report an authoritative sessionId/sessionFile for the new session"
      );
    }
    try {
      mkdirSync5(dirname3(sessionFile), { recursive: true, mode: 448 });
    } catch {
    }
    try {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile });
    } catch (e) {
      this.retireProcess(sessionId, proc, [sessionFile]);
      throw toRequestError(e);
    }
    let session;
    try {
      session = new PiAcpSession({
        sessionId,
        cwd: params.cwd,
        proc,
        conn: params.conn,
        supportsTerminalOutputMeta: params.supportsTerminalOutputMeta,
        authMethods: params.authMethods,
        supportsElicitationForm: params.supportsElicitationForm
      });
    } catch (error) {
      this.retireProcess(sessionId, proc);
      throw error;
    }
    this.sessions.set(sessionId, session);
    return session;
  }
  get(sessionId) {
    const session = this.maybeGet(sessionId);
    if (!session) throw RequestError7.resourceNotFound(sessionId);
    return session;
  }
  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered. When a registered session wins the race,
   * the caller's freshly spawned losing process is disposed here so it can
   * never leak; after disposeAll the fresh process is disposed and the call
   * fails instead of registering.
   */
  getOrCreate(sessionId, params) {
    this.own(params.proc);
    if (this.disposed) {
      this.retireProcess(sessionId, params.proc);
      throw RequestError7.internalError({}, "pi-acp session manager is disposed");
    }
    const existing = this.maybeGet(sessionId);
    if (existing) {
      if (existing.proc !== params.proc) this.retireProcess(sessionId, params.proc);
      return existing;
    }
    let session;
    try {
      session = new PiAcpSession({
        sessionId,
        cwd: params.cwd,
        proc: params.proc,
        conn: params.conn,
        supportsTerminalOutputMeta: params.supportsTerminalOutputMeta,
        authMethods: params.authMethods,
        supportsElicitationForm: params.supportsElicitationForm
      });
    } catch (error) {
      this.retireProcess(sessionId, params.proc);
      throw error;
    }
    this.sessions.set(sessionId, session);
    return session;
  }
};

// src/acp/translate/prompt.ts
import { RequestError as RequestError8 } from "@agentclientprotocol/sdk";
function validatedImage(mimeType, data, label) {
  if (typeof mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw RequestError8.invalidParams({}, `${label} must use a valid image/* MIME type`);
  }
  if (typeof data !== "string" || data.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw RequestError8.invalidParams({}, `${label} contains malformed base64 data`);
  }
  return { type: "image", mimeType, data };
}
function promptToPiMessage(blocks) {
  const text = [];
  const images = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        text.push(block.text);
        break;
      case "resource_link":
        text.push(`
[Context] ${block.uri}
`);
        break;
      case "image":
        images.push(validatedImage(block.mimeType, block.data, "Image block"));
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource) {
          const mime2 = resource.mimeType ?? "text/plain";
          text.push(`
[Embedded Context] ${resource.uri} (${mime2})
${resource.text}`);
          break;
        }
        const mime = resource.mimeType ?? "application/octet-stream";
        if (!mime.toLowerCase().startsWith("image/")) {
          throw RequestError8.invalidParams({}, `Unsupported embedded binary MIME type: ${mime}`);
        }
        images.push(validatedImage(mime, resource.blob, `Embedded resource ${resource.uri}`));
        break;
      }
      case "audio":
        throw RequestError8.invalidParams({}, `Audio prompt content is unsupported: ${block.mimeType}`);
      default:
        throw RequestError8.invalidParams({}, `Unsupported prompt content block: ${block.type}`);
    }
  }
  return { message: text.join(""), images };
}

// src/acp/slash-commands.ts
function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let quote = null;
  for (const char of argsString) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

// src/acp/pi-commands.ts
function describeFallback(c) {
  const source = typeof c.source === "string" ? c.source : "";
  const location = typeof c.location === "string" ? c.location : "";
  const parts = [];
  if (source) parts.push(source);
  if (location) parts.push(location);
  return parts.length ? `(${parts.join(":")})` : "(command)";
}
function toAvailableCommandsFromPiGetCommands(data, _legacyOptions) {
  const root = data;
  const commandsRaw = Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : [];
  const out = [];
  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name || name === "pi-acp-control" || name === "pi-acp-mcp") continue;
    const desc = typeof c?.description === "string" ? c.description.trim() : "";
    out.push({
      name,
      description: desc || describeFallback(c)
    });
  }
  return { commands: out, raw: commandsRaw };
}

// src/acp/agent.ts
import { dirname as dirname4, isAbsolute as isAbsolute5, join as join9, resolve as resolve4 } from "path";
import { existsSync as existsSync4, readFileSync as readFileSync5, realpathSync as realpathSync3 } from "fs";
import { fileURLToPath as fileURLToPath2 } from "url";
function sessionMcpServers(value) {
  try {
    return parseMcpServers(value);
  } catch (error) {
    if (error instanceof McpConfigurationError) throw RequestError9.invalidParams({ reason: error.code }, error.message);
    throw error;
  }
}
async function configureMcp(proc, servers, previouslyConfigured = false) {
  if (!servers.length && !previouslyConfigured) return;
  try {
    await proc.configureMcpServers(servers);
  } catch (error) {
    if (error instanceof McpConfigurationError) throw RequestError9.internalError({ reason: error.code }, error.message);
    throw error;
  }
}
function assertNoAdditionalDirectories(additionalDirectories) {
  if (!additionalDirectories?.length) return;
  throw RequestError9.invalidParams(
    { reason: "ADDITIONAL_DIRECTORIES_UNSUPPORTED" },
    `pi-acp does not support additional workspace directories, so it cannot use the ${additionalDirectories.length} requested additional directories. Remove additionalDirectories from the session request.`
  );
}
function sessionPathsEquivalent(left, right) {
  if (resolve4(left) === resolve4(right)) return true;
  try {
    return realpathSync3(left) === realpathSync3(right);
  } catch {
    return false;
  }
}
var BUILTIN_COMMAND_NAMES = new Set(builtinAvailableCommands().map((command) => command.name));
function mergeCommands(a, b) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
var pkg = readNearestPackageJson(import.meta.url);
var REPLACEMENT_TERMINATION_TIMEOUT_MS = 5e3;
var PiAcpAgent = class {
  constructor(conn, runtime) {
    this.runtime = runtime;
    this.conn = conn;
  }
  runtime;
  conn;
  // Declared before `sessions` so the shared store exists when the manager
  // field initializer runs (class fields initialize in declaration order).
  store = new SessionStore();
  repository = new SessionRepository(this.store);
  sessions = new SessionManager(this.store);
  restoringSessions = /* @__PURE__ */ new Map();
  mcpServers = /* @__PURE__ */ new Map();
  cancellationEpochs = /* @__PURE__ */ new Map();
  loadGenerations = /* @__PURE__ */ new Map();
  activePrompts = /* @__PURE__ */ new Map();
  activeLoads = /* @__PURE__ */ new Map();
  closingSessions = /* @__PURE__ */ new Map();
  // Delete transactions in flight. A delete owns its session from the close
  // through the retirement wait, the unlink, and the store tombstone; restoring
  // anywhere inside that window would spawn a child that recreates the file the
  // delete is about to remove (pi appends by path), so the deletion would not
  // stick. `closingSessions` cannot express this: it is cleared as soon as the
  // close finishes, which is only the first step of a delete.
  deletingSessions = /* @__PURE__ */ new Map();
  // Serializes model/thinking-level mutations per session so a concurrent
  // write cannot slip between another write's support check and its
  // post-write verification.
  configMutationQueues = /* @__PURE__ */ new Map();
  // Test seam: bound for the pre-spawn wait on a retired pi child's exit.
  replacementTerminationTimeoutMs = REPLACEMENT_TERMINATION_TIMEOUT_MS;
  disposed = false;
  // Negotiated at initialize: the auth methods this connection advertised.
  // `authenticate` accepts only these IDs, and auth-required errors raised
  // anywhere in this agent's sessions advertise exactly this set.
  authMethods = [];
  advertisedAuthMethodIds = /* @__PURE__ */ new Set();
  // Negotiated at initialize. Zed advertises `_meta.terminal_output` for its
  // display-only terminal rendering convention; other clients get standard
  // text/image tool content instead. Defaults are strict (off) so nothing
  // non-standard leaks before initialization.
  supportsTerminalOutputMeta = false;
  supportsElicitationForm = false;
  dispose() {
    this.disposed = true;
    this.mcpServers.clear();
    this.sessions.disposeAll();
    this.runtime?.close();
  }
  /**
   * Final-shutdown variant of {@link dispose}: also waits (bounded) for the pi
   * children to terminate so the adapter cannot exit while a child is still
   * being escalated from SIGTERM to SIGKILL. Idempotent, like `dispose`.
   */
  async disposeAndWait(timeoutMs) {
    this.disposed = true;
    this.mcpServers.clear();
    await Promise.all([this.sessions.disposeAllAndWait(timeoutMs), this.runtime?.disposeAndWait(timeoutMs)]);
  }
  sessionRepository() {
    if (this.repository.store !== this.store) this.repository = new SessionRepository(this.store);
    return this.repository;
  }
  async cleanupFailedNewSession(sessionId) {
    const aliases = this.knownSessionFiles(sessionId);
    const cleanup = Promise.resolve().then(async () => {
      this.sessions.close(sessionId);
      await this.sessions.waitForRetiredProcesses([sessionId, ...aliases], this.replacementTerminationTimeoutMs);
      if (aliases.length) await this.sessionRepository().delete(sessionId);
      else this.sessionRepository().tombstone(sessionId);
    }).finally(() => {
      if (this.deletingSessions.get(sessionId) === cleanup) this.deletingSessions.delete(sessionId);
      this.cleanupCancellationEpoch(sessionId);
    });
    this.deletingSessions.set(sessionId, cleanup);
    await cleanup.catch(() => {
    });
  }
  /**
   * Best-effort session-file aliases for the replacement barrier. A missing or
   * unreadable mapping only narrows the barrier to the session id, which is the
   * pre-existing behavior, so store problems must not fail the caller here.
   */
  knownSessionFiles(sessionId) {
    try {
      const sessionFile = this.store.get(sessionId)?.sessionFile;
      return sessionFile ? [sessionFile] : [];
    } catch {
      return [];
    }
  }
  async findStoredSession(sessionId, cwd) {
    const session = await this.sessionRepository().find(sessionId, cwd);
    return session ? { cwd: session.cwd, sessionFile: session.sessionFile } : null;
  }
  assertRequestedSessionCwd(recordedCwd, requestedCwd) {
    if (!requestedCwd || sessionCwdsEquivalent(recordedCwd, requestedCwd)) return;
    throw RequestError9.invalidParams(
      {},
      `cwd does not match the session's recorded cwd (${recordedCwd}): ${requestedCwd}`
    );
  }
  bumpCancellationEpoch(sessionId) {
    this.cancellationEpochs.set(sessionId, (this.cancellationEpochs.get(sessionId) ?? 0) + 1);
  }
  cleanupCancellationEpoch(sessionId) {
    if (!this.activePrompts.has(sessionId) && !this.activeLoads.has(sessionId) && !this.restoringSessions.has(sessionId) && !this.closingSessions.has(sessionId) && !this.deletingSessions.has(sessionId)) {
      this.cancellationEpochs.delete(sessionId);
    }
  }
  isPromptCancelled(sessionId, cancellationEpoch, signal) {
    return signal?.aborted === true || this.disposed || this.closingSessions.has(sessionId) || this.activeLoads.has(sessionId) || (this.cancellationEpochs.get(sessionId) ?? 0) !== cancellationEpoch;
  }
  bumpLoadGeneration(sessionId) {
    const generation = (this.loadGenerations.get(sessionId) ?? 0) + 1;
    this.loadGenerations.set(sessionId, generation);
    return generation;
  }
  assertLoadActive(sessionId, generation) {
    if (this.closingSessions.has(sessionId) || this.loadGenerations.get(sessionId) !== generation) {
      throw RequestError9.requestCancelled({}, `session closed while loading: ${sessionId}`);
    }
  }
  trackPrompt(sessionId, operation) {
    const result = Promise.resolve().then(operation);
    const tracked = result.then(
      () => void 0,
      () => void 0
    );
    let active = this.activePrompts.get(sessionId);
    if (!active) {
      active = /* @__PURE__ */ new Set();
      this.activePrompts.set(sessionId, active);
    }
    active.add(tracked);
    void tracked.then(() => {
      active.delete(tracked);
      if (active.size === 0 && this.activePrompts.get(sessionId) === active) {
        this.activePrompts.delete(sessionId);
      }
      this.cleanupCancellationEpoch(sessionId);
    });
    return result;
  }
  trackLoad(sessionId, operation) {
    const result = Promise.resolve().then(operation);
    const tracked = result.then(
      () => void 0,
      () => void 0
    );
    let active = this.activeLoads.get(sessionId);
    if (!active) {
      active = /* @__PURE__ */ new Set();
      this.activeLoads.set(sessionId, active);
    }
    active.add(tracked);
    return result.finally(() => {
      active.delete(tracked);
      if (active.size === 0 && this.activeLoads.get(sessionId) === active) {
        this.activeLoads.delete(sessionId);
      }
      this.cleanupCancellationEpoch(sessionId);
    });
  }
  async waitForActivePrompts(sessionId) {
    while (true) {
      const active = this.activePrompts.get(sessionId);
      if (!active?.size) return;
      await Promise.all([...active]);
    }
  }
  async waitForActiveLoads(sessionId) {
    while (true) {
      const active = this.activeLoads.get(sessionId);
      if (!active?.size) return;
      await Promise.all([...active]);
    }
  }
  beginSessionClose(sessionId) {
    const inProgress = this.closingSessions.get(sessionId);
    if (inProgress) return inProgress;
    this.bumpCancellationEpoch(sessionId);
    this.bumpLoadGeneration(sessionId);
    const closing = Promise.resolve().then(async () => {
      await this.closeSessionResources(sessionId);
      await this.waitForActiveLoads(sessionId);
      await this.closeSessionResources(sessionId);
    }).finally(() => {
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
      this.cleanupCancellationEpoch(sessionId);
    });
    this.closingSessions.set(sessionId, closing);
    return closing;
  }
  async closeSessionResources(sessionId) {
    let session = this.sessions.maybeGet(sessionId);
    if (!session) {
      const restoring = this.restoringSessions.get(sessionId);
      if (restoring) {
        try {
          session = await restoring;
        } catch {
          session = this.sessions.maybeGet(sessionId);
        }
      }
    }
    if (session) {
      const shutdown2 = session.shutdown();
      this.sessions.close(sessionId);
      await shutdown2;
    }
    await this.waitForActivePrompts(sessionId);
  }
  /**
   * Refuse to hand out (or create) a session while its deletion is in flight.
   * One check at the single entry point covers the whole restore: the body's
   * synchronous prefix (including the `findStoredSession` mapping refresh) runs
   * in the same tick, and concurrent callers awaiting an in-flight restore
   * already passed this guard themselves.
   *
   * Failing closed rather than waiting is deliberate: a restore parked until the
   * delete finished would still be registered in `activePrompts`, and the
   * delete's own `closeSessionResources` awaits exactly that set -- the wait
   * would deadlock the transaction it is waiting for.
   */
  assertNotDeleting(sessionId) {
    if (!this.deletingSessions.has(sessionId)) return;
    throw RequestError9.requestCancelled({}, `session is being deleted: ${sessionId}`);
  }
  async restoreSession(sessionId, opts) {
    this.assertNotDeleting(sessionId);
    const existing = this.sessions.maybeGet(sessionId);
    if (existing) {
      this.assertRequestedSessionCwd(existing.cwd, opts?.cwd);
      return existing;
    }
    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight) {
      const session = await inFlight;
      this.assertRequestedSessionCwd(session.cwd, opts?.cwd);
      return session;
    }
    const restorePromise = (async () => {
      const stored = await this.findStoredSession(sessionId, opts?.cwd);
      if (!stored) {
        throw RequestError9.resourceNotFound(sessionId);
      }
      this.assertRequestedSessionCwd(stored.cwd, opts?.cwd);
      const cwd = stored.cwd;
      await this.sessions.waitForRetiredProcesses([sessionId, stored.sessionFile], this.replacementTerminationTimeoutMs);
      let proc;
      try {
        proc = await this.sessions.spawnOwned({
          cwd,
          sessionPath: stored.sessionFile,
          piCommand: process.env.PI_ACP_PI_COMMAND,
          ...(opts?.mcpServers ?? this.mcpServers.get(sessionId) ?? []).length > 0 ? { mcpProxyOnly: true } : {}
        });
      } catch (e) {
        if (e instanceof Error && e.name === "PiRpcSpawnError") {
          throw RequestError9.internalError({ code: e.code }, e.message);
        }
        throw e;
      }
      if (this.disposed) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile]);
        throw RequestError9.internalError({}, "pi-acp agent is disposed");
      }
      let state = null;
      try {
        state = await proc.getState();
      } catch (e) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile]);
        throw maybeAuthRequiredError(e, this.authMethods) ?? RequestError9.internalError({}, `pi did not report its session state: ${String(e?.message ?? e)}`);
      }
      if (this.disposed) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile]);
        throw RequestError9.internalError({}, "pi-acp agent is disposed");
      }
      const reportedId = typeof state?.sessionId === "string" ? state.sessionId.trim() : "";
      const reportedFile = typeof state?.sessionFile === "string" ? state.sessionFile.trim() : "";
      if (reportedId !== sessionId || !reportedFile || stored.sessionFile && !sessionPathsEquivalent(reportedFile, stored.sessionFile)) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile, reportedId, reportedFile]);
        throw RequestError9.internalError(
          {},
          `pi did not restore the requested session (requested ${sessionId} at ${stored.sessionFile}, got ${reportedId || "unknown"} at ${reportedFile || "unknown"})`
        );
      }
      try {
        await configureMcp(proc, opts?.mcpServers ?? this.mcpServers.get(sessionId) ?? []);
      } catch (error) {
        this.sessions.retireProcess(sessionId, proc, [stored.sessionFile]);
        throw error;
      }
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        conn: this.conn,
        proc,
        supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
        authMethods: this.authMethods,
        supportsElicitationForm: this.supportsElicitationForm
      });
      try {
        this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile });
      } catch (error) {
        if (this.sessions.maybeGet(sessionId) === session && session.proc === proc) {
          this.sessions.close(sessionId);
        } else {
          this.sessions.retireProcess(sessionId, proc, [stored.sessionFile]);
        }
        throw error;
      }
      return session;
    })();
    this.restoringSessions.set(sessionId, restorePromise);
    try {
      return await restorePromise;
    } finally {
      this.restoringSessions.delete(sessionId);
    }
  }
  /**
   * Restore for non-load consumers (resume, config mutations). While a
   * session/load is replaying this session, its freshly restored process is
   * provisional — a failing load evicts and disposes it — so other consumers
   * must not share it mid-flight. They wait for every active load to settle
   * and then use (or restore) the surviving state. The load itself calls
   * restoreSession directly and therefore never waits on itself.
   */
  async restoreSessionAwaitingLoads(sessionId, opts) {
    while (true) {
      await this.waitForActiveLoads(sessionId);
      const observedGeneration = this.loadGenerations.get(sessionId) ?? 0;
      const session = await this.restoreSession(sessionId, opts);
      if (!this.activeLoads.has(sessionId) && (this.loadGenerations.get(sessionId) ?? 0) === observedGeneration) {
        return session;
      }
      await this.waitForActiveLoads(sessionId);
    }
  }
  async initialize(params) {
    const supportedVersion = PROTOCOL_VERSION2;
    const requested = params.protocolVersion;
    const clientCapabilities = params.clientCapabilities;
    this.supportsTerminalOutputMeta = clientCapabilities?._meta?.["terminal_output"] === true;
    this.supportsElicitationForm = clientCapabilities?.elicitation?.form != null;
    this.authMethods = getAuthMethods({
      supportsTerminalAuth: clientCapabilities?.auth?.terminal === true,
      supportsTerminalAuthMeta: clientCapabilities?._meta?.["terminal-auth"] === true
    });
    this.advertisedAuthMethodIds = new Set(this.authMethods.map((method) => method.id));
    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0"
      },
      authMethods: this.authMethods,
      // Keep this snapshot exactly in sync with the handlers registered in
      // `createPiAcpAgentApp` (src/acp/app.ts): omitted capability = unsupported.
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
          delete: {}
        }
      }
    };
  }
  async newSession(params) {
    assertValidSessionCwd(params.cwd);
    const mcpServers = sessionMcpServers(params.mcpServers);
    assertNoAdditionalDirectories(params.additionalDirectories);
    const session = await this.sessions.create({
      cwd: params.cwd,
      ...mcpServers.length > 0 ? { mcpProxyOnly: true } : {},
      conn: this.conn,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
      authMethods: this.authMethods,
      supportsElicitationForm: this.supportsElicitationForm
    });
    let configOptions;
    try {
      await configureMcp(session.proc, mcpServers);
      let state = null;
      let availableModels = null;
      let stateErr = null;
      let availableModelsErr = null;
      await Promise.all([
        session.proc.getState().then((s) => {
          state = s;
        }).catch((err) => {
          stateErr = err;
          state = null;
        }),
        session.proc.getAvailableModels().then((m) => {
          availableModels = m;
        }).catch((err) => {
          availableModelsErr = err;
          availableModels = null;
        })
      ]);
      const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr, this.authMethods);
      if (availableModelsAuthErr) throw availableModelsAuthErr;
      if (availableModelsErr) {
        throw RequestError9.internalError({}, String(availableModelsErr?.message ?? availableModelsErr));
      }
      if (!Array.isArray(availableModels?.models) || availableModels.models.length === 0) {
        throw RequestError9.authRequired(
          { authMethods: this.authMethods },
          "Configure an API key or log in with an OAuth provider."
        );
      }
      if (stateErr) {
        const authError = maybeAuthRequiredError(stateErr, this.authMethods);
        if (authError) throw authError;
        throw RequestError9.internalError({}, String(stateErr?.message ?? stateErr));
      }
      configOptions = await getSessionConfiguration(session.proc, { state, availableModels });
      session.seedSessionConfiguration(configOptions);
      if (mcpServers.length && !this.disposed) this.mcpServers.set(session.sessionId, mcpServers);
    } catch (error) {
      await this.cleanupFailedNewSession(session.sessionId);
      throw error;
    }
    const response = {
      sessionId: session.sessionId,
      configOptions,
      _meta: { piAcp: { startupInfo: null } }
    };
    this.advertiseCommandsSoon(session);
    return response;
  }
  async authenticate(params) {
    const methodId = typeof params?.methodId === "string" ? params.methodId : "";
    if (!this.advertisedAuthMethodIds.has(methodId)) {
      throw RequestError9.invalidParams(
        { methodId },
        `Unknown auth method: ${methodId || "(missing)"}. It was not advertised by this agent at initialize.`
      );
    }
    return;
  }
  prompt(params, signal) {
    const cancellationEpoch = this.cancellationEpochs.get(params.sessionId) ?? 0;
    return this.trackPrompt(params.sessionId, async () => {
      try {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: "cancelled" };
        }
        const response = await this.runPrompt(params, cancellationEpoch, signal);
        return this.isPromptCancelled(params.sessionId, cancellationEpoch, signal) ? { ...response, stopReason: "cancelled" } : response;
      } catch (error) {
        if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
          return { stopReason: "cancelled" };
        }
        if (error instanceof PiRpcRequestTimeoutError) {
          const session = this.sessions.maybeGet(params.sessionId);
          if (session) {
            session.dispose({ expected: false });
            this.sessions.evictIfCurrent(params.sessionId, session);
          }
        }
        throw error;
      }
    });
  }
  async usageFor(session) {
    return typeof session.publishUsageAndGet === "function" ? session.publishUsageAndGet() : void 0;
  }
  async runPrompt(params, cancellationEpoch, signal) {
    const session = await this.restoreSession(params.sessionId);
    if (this.isPromptCancelled(params.sessionId, cancellationEpoch, signal)) {
      return { stopReason: "cancelled" };
    }
    const { message, images } = promptToPiMessage(params.prompt);
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);
      if (BUILTIN_COMMAND_NAMES.has(cmd)) {
        const completed = await session.runCommand(async (ctx) => ({
          response: await runBuiltinCommand(session, cmd, args, ctx),
          usage: await this.usageFor(session)
        }));
        if (!completed) return { stopReason: "cancelled" };
        return { ...completed.response, usage: completed.usage };
      }
    }
    let usage;
    const stopReason = await session.prompt(message, images, async () => {
      usage = await this.usageFor(session);
    });
    return { stopReason, usage };
  }
  /**
   * Adapter-handled builtin slash commands (headless-friendly subset). Always
   * invoked through `session.runCommand`, so it is already serialized with the
   * session's prompt FIFO and settles as cancelled on `session/cancel`.
   *
   * Every publication goes through `ctx.sendSessionUpdate`, which drops
   * updates once the command is cancelled: cancellation quarantines the pi
   * channel, so an in-flight RPC rejects with an induced error that must never
   * surface as a command failure (or a late success).
   */
  async cancel(params) {
    const session = this.sessions.maybeGet(params.sessionId);
    const observable = session || this.activePrompts.has(params.sessionId) || this.activeLoads.has(params.sessionId) || this.restoringSessions.has(params.sessionId) || this.closingSessions.has(params.sessionId) || this.deletingSessions.has(params.sessionId);
    if (!observable) return;
    this.bumpCancellationEpoch(params.sessionId);
    if (session) {
      await session.cancel();
      if (session.isUnavailable()) this.sessions.evictIfCurrent(params.sessionId, session);
    }
    this.cleanupCancellationEpoch(params.sessionId);
  }
  async listSessions(params) {
    if (params.cwd != null && !isAbsolute5(params.cwd)) {
      throw RequestError9.invalidParams({}, `cwd must be an absolute path: ${params.cwd}`);
    }
    const filtered = await this.sessionRepository().list(params.cwd ?? void 0);
    let start = 0;
    if (params.cursor != null) {
      const parsed = /^\d+$/.test(params.cursor) ? Number.parseInt(params.cursor, 10) : Number.NaN;
      if (!Number.isSafeInteger(parsed)) {
        throw RequestError9.invalidParams({}, `Invalid cursor: ${params.cursor}`);
      }
      start = parsed;
    }
    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const sessions = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }));
    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;
    return { sessions, nextCursor, _meta: {} };
  }
  /**
   * Deliver one replayed history update through the session's ordered update
   * queue, so replay and concurrent live updates share a single total order
   * instead of racing on the raw connection. Delivery failures still reject,
   * and the load generation is re-checked on both sides of the send.
   */
  async sendLoadUpdate(session, generation, update) {
    this.assertLoadActive(session.sessionId, generation);
    await session.sendSessionUpdate(update);
    this.assertLoadActive(session.sessionId, generation);
  }
  async loadSession(params) {
    assertValidSessionCwd(params.cwd);
    const mcpServers = sessionMcpServers(params.mcpServers);
    assertNoAdditionalDirectories(params.additionalDirectories);
    const cwd = params.cwd;
    this.bumpCancellationEpoch(params.sessionId);
    const generation = this.bumpLoadGeneration(params.sessionId);
    return this.trackLoad(params.sessionId, async () => {
      this.assertLoadActive(params.sessionId, generation);
      const existing = this.sessions.maybeGet(params.sessionId);
      if (existing || this.restoringSessions.has(params.sessionId) || this.activePrompts.has(params.sessionId)) {
        await this.closeSessionResources(params.sessionId);
        this.assertLoadActive(params.sessionId, generation);
      }
      const session = await this.restoreSession(params.sessionId, { cwd, mcpServers });
      try {
        this.assertLoadActive(params.sessionId, generation);
        const proc = session.proc;
        await configureMcp(proc, mcpServers, this.mcpServers.has(params.sessionId));
        this.assertLoadActive(params.sessionId, generation);
        await replaySessionHistory({
          session,
          cwd,
          supportsTerminalOutputMeta: this.supportsTerminalOutputMeta,
          assertActive: () => this.assertLoadActive(params.sessionId, generation),
          sendUpdate: (update) => this.sendLoadUpdate(session, generation, update)
        });
        const configOptions = await getSessionConfiguration(proc);
        this.assertLoadActive(params.sessionId, generation);
        session.seedSessionConfiguration(configOptions);
        if (mcpServers.length) this.mcpServers.set(params.sessionId, mcpServers);
        else this.mcpServers.delete(params.sessionId);
        const response = {
          configOptions,
          _meta: {
            piAcp: {
              startupInfo: null
            }
          }
        };
        this.advertiseCommandsSoon(session);
        return response;
      } catch (error) {
        if (!this.sessions.evictIfCurrent(params.sessionId, session)) {
          this.sessions.retire(session);
        }
        throw error;
      }
    });
  }
  async resumeSession(params) {
    assertValidSessionCwd(params.cwd);
    const mcpServers = sessionMcpServers(params.mcpServers);
    assertNoAdditionalDirectories(params.additionalDirectories);
    const cwd = params.cwd;
    const session = await this.restoreSessionAwaitingLoads(params.sessionId, { cwd, mcpServers });
    await configureMcp(session.proc, mcpServers, this.mcpServers.has(params.sessionId));
    const configOptions = await getSessionConfiguration(session.proc);
    session.seedSessionConfiguration(configOptions);
    if (mcpServers.length && !this.disposed) this.mcpServers.set(params.sessionId, mcpServers);
    else this.mcpServers.delete(params.sessionId);
    this.advertiseCommandsSoon(session);
    const response = {
      configOptions,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    };
    return response;
  }
  async closeSession(params) {
    await this.beginSessionClose(params.sessionId);
    this.mcpServers.delete(params.sessionId);
    return {};
  }
  /**
   * Run the whole delete transaction under one admission marker, registered
   * synchronously so no restore can slip between the close and the unlink.
   * Concurrent deletes for the same session coalesce onto this promise, which
   * keeps the marker alive until the last one is done; a later retry after a
   * failure starts a fresh transaction.
   */
  beginSessionDelete(sessionId) {
    const inProgress = this.deletingSessions.get(sessionId);
    if (inProgress) return inProgress;
    const deleting = Promise.resolve().then(async () => {
      await this.beginSessionClose(sessionId);
      await this.sessions.waitForRetiredProcesses(
        [sessionId, ...this.knownSessionFiles(sessionId)],
        this.replacementTerminationTimeoutMs
      );
      try {
        await this.sessionRepository().delete(sessionId);
      } catch (error) {
        throw RequestError9.internalError(
          { code: error.code },
          `Failed to delete session: ${sessionId}`
        );
      }
    }).finally(() => {
      if (this.deletingSessions.get(sessionId) === deleting) {
        this.deletingSessions.delete(sessionId);
      }
      this.cleanupCancellationEpoch(sessionId);
    });
    this.deletingSessions.set(sessionId, deleting);
    return deleting;
  }
  async deleteSession(params) {
    await this.beginSessionDelete(params.sessionId);
    this.mcpServers.delete(params.sessionId);
    return {};
  }
  /**
   * Send `available_commands_update` after the current request's response has
   * been delivered. Some clients (e.g. Zed) ignore notifications for a
   * sessionId they have not yet confirmed.
   */
  // Test seam: deferred scheduling for post-response notifications. Tests
  // replace this locally instead of monkey-patching the global setTimeout.
  scheduleDeferred = (task) => {
    setTimeout(task, 0);
  };
  advertiseCommandsSoon(session) {
    this.scheduleDeferred(() => {
      void this.advertiseCommands(session);
      if (typeof session.publishUsageAndGet === "function") {
        void session.publishUsageAndGet({
          isStale: () => this.sessions.maybeGet(session.sessionId) !== session
        });
      }
    });
  }
  async advertiseCommands(session) {
    if (this.sessions.maybeGet(session.sessionId) !== session) return;
    let availableCommands;
    try {
      const pi = await session.proc.getCommands();
      const { commands } = toAvailableCommandsFromPiGetCommands(pi);
      availableCommands = mergeCommands(builtinAvailableCommands(), commands);
    } catch {
      availableCommands = builtinAvailableCommands();
    }
    if (this.sessions.maybeGet(session.sessionId) !== session) return;
    try {
      await session.sendSessionUpdate(
        {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands
          }
        },
        { isStale: () => this.sessions.maybeGet(session.sessionId) !== session }
      );
    } catch {
    }
  }
  /**
   * Serialize model/thinking-level writes per session: a concurrent mutation
   * must not slip between another write's support check, set command, and
   * post-write verification.
   */
  runExclusiveConfigMutation(sessionId, operation) {
    const previous = this.configMutationQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => void 0,
      () => void 0
    );
    this.configMutationQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.configMutationQueues.get(sessionId) === tail) this.configMutationQueues.delete(sessionId);
    });
    return result;
  }
  async setSessionConfigOption(params) {
    const configId = String(params.configId);
    if (typeof params.value !== "string") {
      throw RequestError9.invalidParams({}, `Expected string value for config option: ${configId}`);
    }
    const value = params.value;
    if (configId !== MODEL_CONFIG_ID && configId !== THOUGHT_LEVEL_CONFIG_ID) {
      throw RequestError9.invalidParams({}, `Unknown config option: ${configId}`);
    }
    const configOptions = await this.runExclusiveConfigMutation(params.sessionId, async () => {
      const session = await this.restoreSessionAwaitingLoads(params.sessionId);
      if (configId === THOUGHT_LEVEL_CONFIG_ID && !isThinkingLevel(value)) {
        throw RequestError9.invalidParams({}, `Unknown thinking level: ${value}`);
      }
      session.beginConfigurationMutation();
      try {
        if (configId === MODEL_CONFIG_ID) {
          const state2 = await applySessionModel(session.proc, value);
          const options2 = await emitConfigOptionsUpdate(session, session.sessionId, session.proc, { state: state2 });
          session.seedSessionConfiguration(options2);
          return options2;
        }
        const state = await applyThinkingLevel(session.proc, value);
        const options = await emitConfigOptionsUpdate(session, session.sessionId, session.proc, { state });
        session.seedSessionConfiguration(options);
        return options;
      } finally {
        await session.endConfigurationMutation();
      }
    });
    return { configOptions };
  }
};
async function runPromptWithCancellation(agent, params, signal) {
  let cancellationStarted = false;
  const onAbort = () => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    void agent.cancel({ sessionId: params.sessionId }).catch(() => {
    });
  };
  const prompt = agent.prompt(params, signal);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const response = await prompt;
    return signal.aborted ? { ...response, stopReason: "cancelled" } : response;
  } catch (error) {
    if (signal.aborted) return { stopReason: "cancelled" };
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function readNearestPackageJson(metaUrl) {
  try {
    let dir = dirname4(fileURLToPath2(metaUrl));
    for (let i = 0; i < 6; i++) {
      const p = join9(dir, "package.json");
      if (existsSync4(p)) {
        const json = JSON.parse(readFileSync5(p, "utf-8"));
        return {
          name: typeof json?.name === "string" ? json.name : void 0,
          version: typeof json?.version === "string" ? json.version : void 0
        };
      }
      dir = dirname4(dir);
    }
  } catch {
  }
  return { name: "pi-acp", version: "0.0.0" };
}

// src/acp/client.ts
import { methods } from "@agentclientprotocol/sdk";
var ClientConnection = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  ctx;
  sessionUpdate(params) {
    return this.ctx.notify(methods.client.session.update, params);
  }
  requestPermission(params, options) {
    return this.ctx.request(methods.client.session.requestPermission, params, options);
  }
  createElicitation(params, options) {
    return this.ctx.request(methods.client.elicitation.create, params, options);
  }
};

// src/runtime/gateway.ts
import { join as join10 } from "path";
var RuntimeGateway = class {
  peers = /* @__PURE__ */ new Map();
  attaching = /* @__PURE__ */ new Set();
  closed = false;
  children = /* @__PURE__ */ new Set();
  namedChildren = /* @__PURE__ */ new Map();
  async stop(value) {
    const id = uuid(object(value).identityId), proc = this.namedChildren.get(id);
    if (!proc) throw new Error("Identity is not owned by this ACP connection");
    proc.dispose();
    await proc.whenTerminated();
    return { stopped: true };
  }
  starting = /* @__PURE__ */ new Set();
  abort = new AbortController();
  async start(value) {
    const pending = this.launch(value);
    this.starting.add(pending);
    try {
      return await pending;
    } finally {
      this.starting.delete(pending);
    }
  }
  async launch(value) {
    const params = object(value), identity = parseIdentity(params), cwd = string(params.cwd);
    if (this.closed) throw new Error("ACP connection closing");
    const sessionPath = resolveIdentitySessionFile(
      identity,
      params.sessionFile ? string(params.sessionFile) : void 0
    );
    const proc = await PiRpcProcess.spawn({
      cwd,
      identity,
      agentDirectory: identity.agentDirectory,
      sessionDirectory: join10(identity.agentDirectory, "sessions"),
      sessionPath,
      mcpProxyOnly: true,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      signal: this.abort.signal,
      onProcess: (proc2) => {
        this.children.add(proc2);
        this.namedChildren.set(identity.identityId, proc2);
        proc2.onTermination(() => {
          this.children.delete(proc2);
          if (this.namedChildren.get(identity.identityId) === proc2) this.namedChildren.delete(identity.identityId);
        });
        if (this.closed) proc2.dispose();
      }
    });
    try {
      await proc.getState();
      if (this.closed) throw new Error("ACP connection closed during launch");
      const record2 = this.list().runtimes.find((r) => r.identityId === identity.identityId && r.ownerPid === process.pid);
      if (!record2) throw new Error("Named runtime did not register its identity");
      return { runtimeId: record2.runtimeId };
    } catch (error) {
      proc.dispose();
      throw error;
    }
  }
  list() {
    return { runtimes: discoverRuntimes() };
  }
  async attach(value) {
    const params = object(value);
    const id = params.runtimeId !== void 0 ? uuid(params.runtimeId) : this.list().runtimes.find((r) => r.mode === "rpc" && r.sessionId === string(params.sessionId))?.runtimeId;
    if (!id) throw new Error("No owned runtime for this session");
    if (this.closed || this.attaching.has(id) || this.peers.has(id))
      throw new Error("Runtime already attached or connection closing");
    if (this.peers.size + this.attaching.size >= 64) throw new Error("Runtime attachment limit reached");
    this.attaching.add(id);
    let peer;
    try {
      peer = await RuntimeClient.open(id);
      const status = await peer.request(runtimeMethods.status);
      if (this.closed) throw new Error("ACP connection closed during attach");
      this.peers.set(id, peer);
      const current = peer;
      void peer.connection.closed.catch(() => void 0).then(() => {
        if (this.peers.get(id) === current) this.peers.delete(id);
      });
      return status;
    } catch (error) {
      peer?.close();
      throw error;
    } finally {
      this.attaching.delete(id);
    }
  }
  async request(method, value) {
    const params = object(value), id = uuid(params.runtimeId);
    const peer = this.peers.get(id);
    if (this.closed || !peer) throw new Error("Runtime not attached; discover and reconnect");
    if (params.generation !== peer.record.generation) throw new Error("Runtime generation mismatch");
    if (method === runtimeMethods.detach) {
      this.peers.delete(id);
      peer.close();
      return { detached: true };
    }
    return peer.request(method, params);
  }
  async disposeAndWait(timeoutMs) {
    this.close();
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...this.starting]).then(
          () => Promise.all([...this.children].map((child) => child.whenTerminated()))
        ),
        new Promise((resolve5) => {
          timer = setTimeout(resolve5, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  close() {
    this.closed = true;
    this.abort.abort();
    for (const child of this.children) child.dispose();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }
};

// src/acp/app.ts
function newSessionParams(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw RequestError10.invalidParams();
  const request = value;
  if (typeof request.cwd !== "string") throw RequestError10.invalidParams({}, "cwd \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  if (request.additionalDirectories !== void 0 && (!Array.isArray(request.additionalDirectories) || request.additionalDirectories.some((path) => typeof path !== "string")))
    throw RequestError10.invalidParams({}, "additionalDirectories \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
  if (request._meta !== void 0 && (typeof request._meta !== "object" || request._meta === null || Array.isArray(request._meta)))
    throw RequestError10.invalidParams({}, "_meta \u5FC5\u987B\u662F\u5BF9\u8C61");
  try {
    return { ...request, cwd: request.cwd, mcpServers: parseMcpServers(request.mcpServers) };
  } catch (error) {
    if (error instanceof McpConfigurationError) throw RequestError10.invalidParams({ reason: error.code }, error.message);
    throw error;
  }
}
function existingSessionParams(value) {
  const request = newSessionParams(value);
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw RequestError10.invalidParams({}, "sessionId \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
  return { ...request, sessionId };
}
function createPiAcpAgentApp(opts) {
  let active = null;
  let runtimes = null;
  let initializeState = "uninitialized";
  const getAgent = () => {
    if (!active) throw RequestError10.internalError({}, "pi-acp agent is not connected");
    return active;
  };
  const getInitializedAgent = () => {
    const agent = getAgent();
    if (initializeState !== "initialized") {
      throw RequestError10.invalidRequest({}, "Agent is not initialized: call initialize first");
    }
    return agent;
  };
  return acpAgent({ name: "pi-acp" }).onConnect((connection) => {
    const gateway = new RuntimeGateway();
    const agent = new PiAcpAgent(new ClientConnection(connection.client), gateway);
    runtimes = gateway;
    active = agent;
    initializeState = "uninitialized";
    opts?.onAgent?.(agent);
    connection.signal.addEventListener(
      "abort",
      () => {
        if (active === agent) {
          active = null;
          initializeState = "uninitialized";
          opts?.onAgent?.(null);
        }
        gateway.close();
        agent.dispose();
      },
      { once: true }
    );
  }).onRequest(methods2.agent.initialize, async (ctx) => {
    if (initializeState !== "uninitialized") {
      throw RequestError10.invalidRequest({}, "Agent is already initializing or initialized");
    }
    const agent = getAgent();
    initializeState = "initializing";
    try {
      const response = await agent.initialize(ctx.params);
      if (active !== agent) {
        throw RequestError10.requestCancelled({}, "ACP connection closed during initialize");
      }
      initializeState = "initialized";
      return {
        ...response,
        _meta: {
          ...response._meta,
          [RUNTIME_CAPABILITY]: true,
          [EVENTS_CAPABILITY]: true,
          [IDENTITY_CAPABILITY]: true
        }
      };
    } catch (error) {
      if (active === agent) initializeState = "uninitialized";
      throw error;
    }
  }).onRequest("_pi/session/import", object, (ctx) => {
    getInitializedAgent();
    return new SessionRepository().importFile(string(ctx.params.cwd), string(ctx.params.sessionFile));
  }).onRequest("_pi/identity/stop", object, (ctx) => {
    getInitializedAgent();
    return runtimes.stop(ctx.params);
  }).onRequest("_pi/identity/start", object, (ctx) => {
    getInitializedAgent();
    return runtimes.start(ctx.params);
  }).onRequest(runtimeMethods.list, object, () => {
    getInitializedAgent();
    return runtimes.list();
  }).onRequest(runtimeMethods.attach, object, (ctx) => {
    getInitializedAgent();
    return runtimes.attach(ctx.params);
  }).onRequest(runtimeMethods.status, object, (ctx) => {
    getInitializedAgent();
    return runtimes.request(runtimeMethods.status, ctx.params);
  }).onRequest(runtimeMethods.events, object, (ctx) => {
    getInitializedAgent();
    return runtimes.request(runtimeMethods.events, ctx.params);
  }).onRequest(runtimeMethods.deliver, object, (ctx) => {
    getInitializedAgent();
    return runtimes.request(runtimeMethods.deliver, ctx.params);
  }).onRequest(runtimeMethods.mcp, object, (ctx) => {
    getInitializedAgent();
    return runtimes.request(runtimeMethods.mcp, ctx.params);
  }).onRequest(runtimeMethods.detach, object, (ctx) => {
    getInitializedAgent();
    return runtimes.request(runtimeMethods.detach, ctx.params);
  }).onRequest(methods2.agent.authenticate, (ctx) => getInitializedAgent().authenticate(ctx.params)).onRequest(methods2.agent.session.new, newSessionParams, (ctx) => getInitializedAgent().newSession(ctx.params)).onRequest(methods2.agent.session.load, existingSessionParams, (ctx) => getInitializedAgent().loadSession(ctx.params)).onRequest(methods2.agent.session.list, (ctx) => getInitializedAgent().listSessions(ctx.params)).onRequest(
    methods2.agent.session.resume,
    existingSessionParams,
    (ctx) => getInitializedAgent().resumeSession(ctx.params)
  ).onRequest(methods2.agent.session.close, (ctx) => getInitializedAgent().closeSession(ctx.params)).onRequest(methods2.agent.session.delete, (ctx) => getInitializedAgent().deleteSession(ctx.params)).onRequest(methods2.agent.session.setConfigOption, (ctx) => getInitializedAgent().setSessionConfigOption(ctx.params)).onRequest(
    methods2.agent.session.prompt,
    (ctx) => runPromptWithCancellation(getInitializedAgent(), ctx.params, ctx.signal)
  ).onNotification(methods2.agent.session.cancel, (ctx) => getInitializedAgent().cancel(ctx.params));
}

// src/acp/shutdown.ts
function createShutdownCoordinator(opts) {
  let agent = null;
  let shuttingDown = false;
  return {
    trackAgent(next) {
      if (next) agent = next;
    },
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      if (!agent) {
        opts.exit();
        return;
      }
      agent.disposeAndWait(opts.timeoutMs).then(opts.exit, opts.exit);
    }
  };
}

// src/index.ts
if (process.argv.includes("--terminal-login")) {
  const { spawnSync } = await import("child_process");
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND);
  const invocation = buildPiInvocation(cmd, [], { cwd: process.cwd() });
  if (!invocation) {
    process.stderr.write(`pi-acp: could not start pi (command not found: ${cmd}).
`);
    process.exit(1);
  }
  const res = spawnSync(invocation.executable, invocation.args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments
  });
  if (res.error?.code === "ENOENT") {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.
`
    );
    process.exit(1);
  }
  process.exit(typeof res.status === "number" ? res.status : 1);
}
var input = new WritableStream({
  write(chunk) {
    return new Promise((resolve5) => {
      if (process.stdout.destroyed || !process.stdout.writable) return resolve5();
      try {
        process.stdout.write(chunk, (err) => {
          void err;
          resolve5();
        });
      } catch {
        resolve5();
      }
    });
  }
});
var output = new ReadableStream({
  start(controller) {
    process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (err) => controller.error(err));
  }
});
var stream = ndJsonStream2(input, output);
var SHUTDOWN_TERMINATION_TIMEOUT_MS = 13e3;
var coordinator = createShutdownCoordinator({
  timeoutMs: SHUTDOWN_TERMINATION_TIMEOUT_MS,
  exit: () => {
    try {
      process.exit(0);
    } catch {
    }
  }
});
createPiAcpAgentApp({ onAgent: (agent) => coordinator.trackAgent(agent) }).connect(stream);
var shutdown = () => coordinator.shutdown();
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdout.on("error", shutdown);
//# sourceMappingURL=index.js.map