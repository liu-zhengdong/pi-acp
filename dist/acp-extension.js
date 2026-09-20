#!/usr/bin/env node

// src/pi-rpc/acp-extension.ts
import { randomUUID as randomUUID4 } from "crypto";

// src/pi-rpc/mcp-servers.ts
var MCP_COMMAND = "pi-acp-mcp";
var MCP_WIDGET = "pi-acp-mcp-result";
var MCP_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
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
function mcpDefinition(server) {
  if ("command" in server)
    return {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      literalEnv: true,
      inheritEnv: false,
      directTools: false
    };
  return {
    url: server.url,
    headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
    httpTransport: server.type === "http" ? "streamable-http" : "sse",
    directTools: false
  };
}

// src/pi-rpc/mcp-extension.ts
function registerMcpBridge(pi) {
  let generation = 0;
  let owned = /* @__PURE__ */ new Map();
  let updating = false;
  let closing = false;
  let noticePending = false;
  let checkedHistory = false;
  let poisoned = false;
  const register = async (server) => {
    const request = { version: 1, requiredToolExposure: "proxy-only", name: server.name, definition: mcpDefinition(server) };
    try {
      pi.events.emit(MCP_REGISTER_EVENT, request);
    } catch {
      throw new McpConfigurationError("MCP_REGISTRATION_FAILED", `\u6CE8\u518C MCP \u670D\u52A1 ${server.name} \u5931\u8D25`);
    }
    if (!request.result)
      throw new McpConfigurationError("MCP_ADAPTER_UNAVAILABLE", "\u9700\u8981\u5B89\u88C5\u652F\u6301\u8FD0\u884C\u65F6\u6CE8\u518C\u7684 pi-mcp-adapter");
    if (!request.result.ok) {
      const error = request.result.error;
      if (error instanceof Error && error.message === `MCP server "${server.name}" is already registered`)
        throw new McpConfigurationError("MCP_SERVER_CONFLICT", `MCP \u670D\u52A1\u540D\u79F0\u51B2\u7A81\uFF1A${server.name}\uFF1B\u539F\u670D\u52A1\u4FDD\u6301\u4E0D\u53D8`);
      throw new McpConfigurationError("MCP_REGISTRATION_FAILED", `\u6CE8\u518C MCP \u670D\u52A1 ${server.name} \u5931\u8D25\uFF1B\u672A\u8FD4\u56DE\u670D\u52A1\u51ED\u636E`);
    }
    if (typeof request.result.registration?.dispose !== "function")
      throw new McpConfigurationError("MCP_ADAPTER_INCOMPATIBLE", "pi-mcp-adapter \u8FD4\u56DE\u4E86\u4E0D\u517C\u5BB9\u7684\u6CE8\u518C\u7ED3\u679C");
    if (request.result.registration.toolExposure !== "proxy-only") {
      try {
        await request.result.registration.dispose();
      } catch {
        poisoned = true;
        throw new McpConfigurationError("MCP_ROLLBACK_FAILED", "\u4E0D\u517C\u5BB9 MCP \u6CE8\u518C\u91CA\u653E\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D\u4F1A\u8BDD");
      }
      throw new McpConfigurationError(
        "MCP_ADAPTER_INCOMPATIBLE",
        "\u9700\u8981\u652F\u6301 proxy-only \u56DE\u6267\u7684 pi-mcp-adapter\uFF1B\u8BF7\u4EE5\u56FA\u5B9A\u4EE3\u7406\u6A21\u5F0F\u91CD\u65B0\u542F\u52A8 Pi"
      );
    }
    return { server, registration: request.result.registration };
  };
  const release = async (entries) => {
    const results = await Promise.allSettled([...entries].map((entry) => entry.registration.dispose()));
    return results.every((result) => result.status === "fulfilled");
  };
  const updates = /* @__PURE__ */ new Set();
  const configureCore = async (value, ctx, appendWhileBusy) => {
    const servers = parseMcpServers(value);
    const epoch = generation;
    if (closing || poisoned)
      throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "MCP \u6CE8\u518C\u6865\u63A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D\u4F1A\u8BDD");
    if (updating || (!ctx.isIdle() || ctx.hasPendingMessages()) && (!appendWhileBusy || [...owned].some(
      ([name, entry]) => !servers.some((server) => server.name === name && JSON.stringify(server) === JSON.stringify(entry.server))
    )))
      throw new McpConfigurationError("MCP_SESSION_BUSY", "\u4F1A\u8BDD\u5FD9\u788C\uFF0C\u6682\u4E0D\u80FD\u66F4\u65B0 MCP \u670D\u52A1");
    updating = true;
    const previous = owned;
    const next = /* @__PURE__ */ new Map();
    const added = [];
    const removed = [];
    try {
      for (const server of servers) {
        if (closing || epoch !== generation) throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "\u4F1A\u8BDD\u6B63\u5728\u5173\u95ED");
        const existing = previous.get(server.name);
        if (existing && JSON.stringify(existing.server) === JSON.stringify(server)) {
          next.set(server.name, existing);
          continue;
        }
        if (existing) {
          removed.push(existing);
          await existing.registration.dispose();
        }
        const entry = await register(server);
        added.push(entry);
        next.set(server.name, entry);
      }
      for (const [name, entry] of previous) {
        if (next.has(name)) continue;
        removed.push(entry);
        await entry.registration.dispose();
      }
      if (closing || epoch !== generation) throw new McpConfigurationError("MCP_BRIDGE_UNAVAILABLE", "\u4F1A\u8BDD\u6B63\u5728\u5173\u95ED");
      owned = next;
      noticePending = true;
    } catch (error) {
      let restored = await release(added);
      if (!closing && epoch === generation) {
        for (const entry of removed) {
          try {
            previous.set(entry.server.name, await register(entry.server));
          } catch {
            restored = false;
          }
        }
      }
      poisoned ||= !restored;
      if (poisoned) throw new McpConfigurationError("MCP_ROLLBACK_FAILED", "MCP \u6CE8\u518C\u56DE\u6EDA\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D\u4F1A\u8BDD");
      throw error;
    } finally {
      if (epoch === generation) updating = false;
    }
  };
  const configure = (value, ctx, appendWhileBusy = false) => {
    const task = configureCore(value, ctx, appendWhileBusy);
    updates.add(task);
    void task.finally(() => updates.delete(task)).catch(() => void 0);
    return task;
  };
  pi.registerCommand(MCP_COMMAND, {
    description: "\u5185\u90E8 ACP MCP \u6CE8\u518C\u6865\u63A5",
    async handler(args, ctx) {
      let id;
      const reply = (success, code, message) => ctx.ui.setWidget(MCP_WIDGET, [JSON.stringify({ version: 1, id, success, code, message })]);
      try {
        if (args.length > Math.ceil(MAX_MCP_REQUEST_BYTES * 1.5) || !/^[A-Za-z0-9_-]+$/.test(args))
          throw new McpConfigurationError("INVALID_MCP_SERVERS", "\u65E0\u6548\u7684 MCP \u6CE8\u518C\u8BF7\u6C42");
        const request = JSON.parse(Buffer.from(args, "base64url").toString("utf8"));
        if (request?.version !== 1 || typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id))
          throw new McpConfigurationError("INVALID_MCP_SERVERS", "\u65E0\u6548\u7684 MCP \u8BF7\u6C42\u6807\u8BC6");
        id = request.id;
        await configure(request.servers, ctx);
        reply(true);
      } catch (error) {
        const known = error instanceof McpConfigurationError;
        reply(
          false,
          known ? error.code : "MCP_REGISTRATION_FAILED",
          known ? error.message : "MCP \u6CE8\u518C\u5931\u8D25\uFF1B\u672A\u8FD4\u56DE\u670D\u52A1\u51ED\u636E"
        );
      }
    }
  });
  const notice = (ctx) => {
    if (!checkedHistory) {
      checkedHistory = true;
      noticePending ||= ctx.sessionManager?.getBranch?.().some((entry) => entry.type === "custom_message" && entry.customType === "pi-acp-mcp-tools") ?? false;
    }
    if (!noticePending || closing || poisoned) return;
    noticePending = false;
    const names = [...owned.keys()];
    return {
      message: {
        customType: "pi-acp-mcp-tools",
        display: false,
        content: names.length ? `\u672C\u6B21 ACP \u8FDE\u63A5\u989D\u5916\u63D0\u4F9B\u7684 MCP \u670D\u52A1\uFF1A${names.join("\u3001")}\u3002\u539F\u6709\u914D\u7F6E\u7684\u670D\u52A1\u4FDD\u6301\u53EF\u7528\u3002
\u4F7F\u7528\u56FA\u5B9A mcp \u4EE3\u7406\u53D1\u73B0\u5DE5\u5177\uFF1Amcp({server:"\u670D\u52A1\u540D\u79F0"})\uFF1B\u67E5\u770B\u53C2\u6570\uFF1Amcp({server:"\u670D\u52A1\u540D\u79F0",describe:"\u5DE5\u5177\u540D\u79F0"})\uFF1B\u8C03\u7528\uFF1Amcp({server:"\u670D\u52A1\u540D\u79F0",tool:"\u5DE5\u5177\u540D\u79F0",args:{...}})\u3002\u5177\u4F53\u5DE5\u5177\u63CF\u8FF0\u548C\u53C2\u6570\u4ECE\u8FD4\u56DE\u7ED3\u679C\u8BFB\u53D6\u3002
\u8FD9\u662F\u80FD\u529B\u4F7F\u7528\u8BF4\u660E\uFF0C\u4E0D\u8981\u6C42\u7ACB\u5373\u8C03\u7528\u5DE5\u5177\uFF0C\u4E5F\u4E0D\u6539\u53D8\u5F53\u524D\u4EFB\u52A1\u3002` : "\u672C\u6B21 ACP \u8FDE\u63A5\u672A\u63D0\u4F9B\u989D\u5916 MCP \u670D\u52A1\uFF1B\u539F\u6709\u914D\u7F6E\u7684\u670D\u52A1\u4FDD\u6301\u53EF\u7528\u3002\u5386\u53F2\u4E2D\u7684 ACP \u670D\u52A1\u63D0\u793A\u4E0D\u4EE3\u8868\u672C\u6B21\u8FDE\u63A5\u4ECD\u63D0\u4F9B\u8FD9\u4E9B\u670D\u52A1\u3002"
      }
    };
  };
  pi.on("before_agent_start", (_event, ctx) => notice(ctx));
  pi.on("session_start", () => {
    generation++;
    closing = false;
    poisoned = false;
    updating = false;
    checkedHistory = false;
    noticePending = false;
  });
  pi.on("session_shutdown", async () => {
    generation++;
    closing = true;
    await Promise.allSettled([...updates]);
    const current = owned;
    owned = /* @__PURE__ */ new Map();
    if (!await release(current.values())) console.error("pi-acp: MCP \u6CE8\u518C\u91CA\u653E\u5931\u8D25");
  });
  return {
    configure,
    notice,
    async add(value, ctx) {
      const before = new Set(owned.values());
      const servers = parseMcpServers(value);
      for (const server of servers) {
        const existing = owned.get(server.name);
        if (existing && JSON.stringify(existing.server) !== JSON.stringify(server))
          throw new McpConfigurationError("MCP_SERVER_CONFLICT", `MCP \u670D\u52A1\u540D\u79F0\u51B2\u7A81\uFF1A${server.name}`);
      }
      await configure(
        [...owned.values()].map((entry) => entry.server).filter((server) => !servers.some((addition) => addition.name === server.name)).concat(servers),
        ctx,
        true
      );
      const additions = new Set([...owned.values()].filter((entry) => !before.has(entry)));
      if (!additions.size) return void 0;
      return async (context) => {
        await configure(
          [...owned.values()].filter((entry) => !additions.has(entry)).map((entry) => entry.server),
          context
        );
      };
    }
  };
}

// src/runtime/extension.ts
import { createHash, randomBytes, randomUUID as randomUUID3, timingSafeEqual } from "crypto";
import { chmodSync as chmodSync2, renameSync as renameSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
import { createServer } from "net";
import { agent, PROTOCOL_VERSION as PROTOCOL_VERSION2 } from "@agentclientprotocol/sdk";

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
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || process.getuid && stat.uid !== process.getuid())
    throw new Error("Unsafe runtime directory");
  if (process.platform !== "win32") chmodSync(dir, 448);
  return dir;
}
function recordPath(id) {
  return join2(runtimeDirectory(), `${uuid(id)}.json`);
}
function socketEndpoint(id) {
  uuid(id);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-acp-${id}`;
  const dir = `/tmp/pi-acp-${process.getuid()}`;
  mkdirSync(dir, { recursive: true, mode: 448 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error("Unsafe socket directory");
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

// src/runtime/events.ts
var RuntimeEvents = class {
  rows = [];
  sequence = 0;
  bytes = 0;
  append(value) {
    const row = { ...value, seq: ++this.sequence, at: Date.now() };
    if (row.text && row.text.length > 8192) {
      row.text = row.text.slice(0, 8192);
      row.truncated = true;
    }
    this.rows.push(row);
    this.bytes += Buffer.byteLength(JSON.stringify(row));
    while (this.rows.length > 512 || this.bytes > 1048576) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.rows.shift()));
    }
  }
  page(value) {
    const params = object(value), after = params.after ?? 0, limit = params.limit ?? 50;
    if (!Number.isSafeInteger(after) || Number(after) < 0 || Number(after) > this.sequence)
      throw new Error("Invalid event cursor");
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("Invalid event limit");
    const oldest = this.rows[0]?.seq ?? this.sequence + 1;
    const items = [];
    let bytes = 0;
    for (const row of this.rows) {
      if (row.seq <= Number(after)) continue;
      const size = Buffer.byteLength(JSON.stringify(row));
      if (items.length && (items.length >= Number(limit) || bytes + size > 65536)) break;
      items.push(row);
      bytes += size;
    }
    const nextAfter = items.at(-1)?.seq ?? Number(after);
    return { items, nextAfter, hasMore: nextAfter < this.sequence, gap: Number(after) < oldest - 1 };
  }
};
function resultText(value) {
  if (!value || typeof value !== "object") return "";
  const content = value.content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

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
  statSync as statSync2,
  unlinkSync,
  writeFileSync
} from "fs";
import { isAbsolute, join as join3 } from "path";

// src/pi-rpc/command.ts
import { statSync } from "fs";
import { platform as hostPlatform } from "os";
import { win32 } from "path";

// src/runtime/identity.ts
var bindingKey = /* @__PURE__ */ Symbol.for("@liuser/pi-acp/named-identity/v1");
var ENV = "PI_ACP_NAMED_OWNER";
function parseIdentity(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid named identity");
  const { identityId, agentDirectory } = value;
  if (typeof identityId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identityId))
    throw new Error("Invalid identityId");
  if (typeof agentDirectory !== "string" || !isAbsolute(agentDirectory) || !statSync2(agentDirectory).isDirectory())
    throw new Error("agentDirectory must be an existing absolute directory");
  return { identityId, agentDirectory: realpathSync(agentDirectory) };
}
function files(identity) {
  const root = join3(getPiAcpDir(), "identities");
  mkdirSync2(root, { recursive: true, mode: 448 });
  const base = join3(root, identity.identityId);
  return { owner: `${base}.json`, guard: `${base}.guard`, cursor: `${base}.cursor.json` };
}
function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID2()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 384, flag: "wx" });
  renameSync(temp, path);
}
function processIdentity() {
  const globals = globalThis;
  if (globals[bindingKey] !== void 0) return globals[bindingKey];
  const raw = process.env[ENV];
  delete process.env[ENV];
  let identity = null;
  if (raw) {
    const pointer = JSON.parse(raw);
    const owner = JSON.parse(readFileSync2(pointer.path, "utf8"));
    if (owner.nonce === pointer.nonce && owner.childPid === process.pid) identity = parseIdentity(owner);
  }
  globals[bindingKey] = identity;
  return identity;
}
function rememberIdentitySession(identity, sessionFile, runtimeId) {
  writeAtomic(files(identity).cursor, { ...identity, sessionFile, runtimeId });
}
var SESSION_HEADER_SCAN = 1024 * 1024;

// src/runtime/extension.ts
var IMAGE_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
var MAX_IMAGES = 10;
var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function parseImages(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error("Invalid images");
  return value.map((item) => {
    const image = object(item);
    if (image.type !== "image") throw new Error("Invalid image");
    const mimeType = string(image.mimeType, 64);
    if (!IMAGE_TYPES.has(mimeType)) throw new Error("Unsupported image type");
    const data = string(image.data, 14e6);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Invalid image data");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image too large");
    return { type: "image", mimeType, data };
  });
}
var identityKey = /* @__PURE__ */ Symbol.for("@liuser/pi-acp/runtime-identity/v1");
function registerRuntimeBridge(pi, mcp) {
  const send = pi.sendMessage?.bind(pi);
  if (!send) return;
  const named = processIdentity();
  const globals = globalThis;
  const runtimeId = typeof globals[identityKey] === "string" ? globals[identityKey] : randomUUID3();
  globals[identityKey] = runtimeId;
  let ctx, record2, server;
  let events = new RuntimeEvents();
  let epoch = 0, closing = true, owner;
  let cleanupTimer;
  const sockets = /* @__PURE__ */ new Set();
  const received = /* @__PURE__ */ new Map();
  const registrations = /* @__PURE__ */ new Set();
  function current(generation) {
    if (closing || generation !== epoch || !ctx) throw new Error("Runtime generation is no longer active");
    return ctx;
  }
  function status(generation) {
    const context = current(generation);
    if (!record2) throw new Error("Runtime is not ready");
    const { token: _token, endpoint: _endpoint, ...identity } = record2;
    return {
      ...identity,
      sessionId: context.sessionManager.getSessionId(),
      sessionFile: context.sessionManager.getSessionFile() ?? null,
      cwd: context.cwd,
      busy: !context.isIdle() || context.hasPendingMessages(),
      model: context.model ? `${context.model.provider}/${context.model.id}` : ""
    };
  }
  async function release(lease, generation) {
    if (closing || generation !== epoch || owner !== lease) return;
    const context = current(generation);
    if (!context.isIdle() || context.hasPendingMessages()) {
      cleanupTimer = setTimeout(() => void release(lease, generation), 250).unref();
      return;
    }
    try {
      for (const dispose of registrations) {
        await dispose(context);
        registrations.delete(dispose);
      }
    } catch {
      cleanupTimer = setTimeout(() => void release(lease, generation), 1e3).unref();
      return;
    }
    if (!closing && generation === epoch && owner === lease) owner = void 0;
  }
  async function stop() {
    closing = true;
    epoch++;
    clearTimeout(cleanupTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    owner = void 0;
    received.clear();
    registrations.clear();
    const previous = server, previousRecord = record2;
    server = void 0;
    record2 = void 0;
    ctx = void 0;
    if (previous) await new Promise((resolve2) => previous.close(() => resolve2()));
    if (previousRecord) {
      try {
        unlinkSync2(recordPath(previousRecord.runtimeId));
      } catch {
      }
      if (process.platform !== "win32")
        try {
          unlinkSync2(previousRecord.endpoint);
        } catch {
        }
    }
  }
  pi.on("session_start", async (_, context) => {
    await stop();
    events = new RuntimeEvents();
    events.append({ kind: "session" });
    ctx = context;
    closing = false;
    const generation = epoch;
    const mode = process.argv.some(
      (arg, i) => arg === "--mode=rpc" || arg === "--mode" && process.argv[i + 1] === "rpc"
    ) ? "rpc" : "tui";
    const endpoint = socketEndpoint(runtimeId);
    record2 = {
      runtimeId,
      generation: randomUUID3(),
      sessionId: ctx.sessionManager.getSessionId(),
      pid: process.pid,
      ownerPid: mode === "rpc" ? process.ppid : null,
      identityId: named?.identityId ?? null,
      cwd: ctx.cwd,
      mode,
      endpoint,
      token: randomBytes(32).toString("hex")
    };
    server = createServer((socket) => {
      if (sockets.size >= 64) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.setTimeout(1e4, () => socket.destroy());
      socket.on("error", () => void 0);
      socket.once("close", () => sockets.delete(socket));
      const lease = /* @__PURE__ */ Symbol("runtime-client");
      let initialized = false;
      const ready = (value) => {
        if (!initialized || owner !== lease) throw new Error("Initialize and acquire the runtime first");
        const params = object(value), now = status(generation);
        if (params.runtimeId !== now.runtimeId || params.generation !== now.generation)
          throw new Error("Runtime generation mismatch");
        return { params, now };
      };
      const connection = agent({ name: "pi-acp-runtime" }).onRequest("initialize", ({ params }) => {
        current(generation);
        if (initialized || owner) throw new Error("Runtime already has a controller");
        const token = object(params._meta).token;
        if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(record2.token)))
          throw new Error("Invalid runtime credential");
        initialized = true;
        socket.setTimeout(0);
        owner = lease;
        return { protocolVersion: PROTOCOL_VERSION2, agentCapabilities: {}, _meta: { [RUNTIME_CAPABILITY]: true } };
      }).onRequest(runtimeMethods.status, object, ({ params }) => ready(params).now).onRequest(runtimeMethods.events, object, ({ params }) => {
        const { now } = ready(params);
        if (params.sessionId !== now.sessionId) throw new Error("Session changed; reconfirm the target");
        return {
          ...events.page(params),
          runtimeId: now.runtimeId,
          generation: now.generation,
          sessionId: now.sessionId
        };
      }).onRequest(runtimeMethods.deliver, object, ({ params }) => {
        const { now } = ready(params);
        if (params.sessionId !== now.sessionId) throw new Error("Session changed; reconfirm the target");
        const id = uuid(params.id), text = string(params.text, 3e4), source = string(params.source, 160), images = parseImages(params.images);
        if (/[\p{Cc}\p{Cf}]/u.test(source)) throw new Error("Invalid message source");
        if (!["steer", "followUp"].includes(String(params.delivery))) throw new Error("Invalid delivery mode");
        if (params.triggerTurn !== void 0 && typeof params.triggerTurn !== "boolean")
          throw new Error("Invalid triggerTurn");
        const fingerprint = createHash("sha256").update(
          JSON.stringify([
            now.sessionId,
            text,
            source,
            params.delivery,
            params.triggerTurn ?? true,
            images.map((image) => [image.mimeType, createHash("sha256").update(image.data).digest("hex")])
          ])
        ).digest("hex");
        const previous = received.get(id);
        if (previous && previous !== fingerprint) throw new Error("Delivery id reused with different content");
        if (previous) return { accepted: true, duplicate: true, sessionId: now.sessionId };
        const header = `\u6765\u81EA ${source}

${text}`;
        send(
          {
            customType: "pi-acp-external",
            content: images.length === 0 ? header : [{ type: "text", text: header }, ...images],
            display: true,
            details: { deliveryId: id, source }
          },
          {
            // Pi defers triggerTurn:false messages until agent_end, even with deliverAs:'steer'.
            // Suppress idle wakes, not insertion into the already-running conversation.
            triggerTurn: !current(generation).isIdle() || params.triggerTurn !== false,
            deliverAs: params.delivery
          }
        );
        events.append({ kind: "delivery", name: source, text });
        received.set(id, fingerprint);
        if (received.size > 2e3) received.delete(received.keys().next().value);
        return { accepted: true, sessionId: now.sessionId };
      }).onRequest(runtimeMethods.mcp, object, async ({ params }) => {
        const { now } = ready(params);
        if (params.sessionId !== now.sessionId) throw new Error("Session changed; reconfirm the target");
        const dispose = await mcp.add(params.mcpServers, current(generation));
        if (dispose) registrations.add(dispose);
        const notice = mcp.notice(current(generation));
        if (notice) send(notice.message, { deliverAs: "steer", triggerTurn: !current(generation).isIdle() });
        return { registered: true };
      }).connect(socketStream(socket));
      void connection.closed.catch(() => void 0).then(() => release(lease, generation));
      socket.once("close", () => connection.close());
    });
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve2();
      });
    });
    server.on("error", () => void stop());
    if (process.platform !== "win32") chmodSync2(endpoint, 384);
    const path = recordPath(runtimeId), temp = `${path}.${randomUUID3()}.tmp`;
    writeFileSync2(temp, JSON.stringify(record2), { mode: 384 });
    renameSync2(temp, path);
    if (named) rememberIdentitySession(named, ctx.sessionManager.getSessionFile() ?? null, runtimeId);
  });
  pi.on("before_agent_start", (_, context) => {
    if (!closing) ctx = context;
  });
  for (const [hook, kind] of [
    ["agent_start", "run_start"],
    ["agent_settled", "run_end"]
  ])
    pi.on(hook, () => {
      if (!closing) events.append({ kind });
    });
  for (const [hook, kind] of [
    ["tool_execution_start", "tool_start"],
    ["tool_execution_end", "tool_end"]
  ])
    pi.on(hook, (value) => {
      if (closing) return;
      const event = object(value);
      if (typeof event.toolName !== "string" || typeof event.toolCallId !== "string") return;
      events.append({
        kind,
        name: event.toolName.slice(0, 256),
        callId: event.toolCallId.slice(0, 256),
        text: kind === "tool_start" ? JSON.stringify(event.args ?? {}) : resultText(event.result),
        ...kind === "tool_end" ? { error: event.isError === true } : {}
      });
    });
  pi.on("message_end", (value) => {
    if (closing) return;
    const message = object(object(value).message);
    if (message.role !== "user" && message.role !== "assistant") return;
    const text = typeof message.content === "string" ? message.content : resultText(message);
    if (text || message.stopReason === "error" || message.stopReason === "aborted")
      events.append({
        kind: "message",
        name: message.role,
        text: text || String(message.errorMessage ?? message.stopReason),
        error: message.stopReason === "error" || message.stopReason === "aborted"
      });
  });
  pi.on("session_shutdown", () => stop());
}

// src/pi-rpc/acp-extension.ts
var ACP_LIFECYCLE_WIDGET = "pi-acp-lifecycle";
var REGISTRY = /* @__PURE__ */ Symbol.for("@agegr/pi-web/session-liveness/v1");
var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var canonicalUuid = new RegExp(`^${UUID}$`);
function nestedStatus(text, id) {
  if (typeof text !== "string" || /[\p{Cc}\p{Cf}]/u.test(text.replaceAll("\n", ""))) return;
  if ((text.match(/^[ ]*(?:Status target|Spawn budget|Active async capacity|Nested run|Root|Parent|State):/gm) ?? []).length !== 7)
    return;
  const headers = new RegExp(
    `^Status target: run ${id}\\nSpawn budget: (?:unlimited|\\d+/\\d+ used, \\d+ remaining \\(configured \\d+; granted \\d+; grant allowance \\d+\\))\\nActive async capacity: \\d+/(?:unlimited|\\d+) used\\nNested run: ${id}\\nRoot: (${UUID})\\nParent: (${UUID})(?: step [1-9]\\d*)?\\nState: (queued|running|complete|failed|partial|paused|stopped|rejected)(?:\\n|$)`
  ).exec(text);
  if (headers) return { root: headers[1], parent: headers[2], state: headers[3] };
}
function acpExtension(pi) {
  registerRuntimeBridge(pi, registerMcpBridge(pi));
  const globals = globalThis;
  const previous = globals[REGISTRY];
  if (previous !== void 0 && (previous.version !== 1 || typeof previous.register !== "function"))
    throw new Error("Incompatible session-liveness host");
  const providers = /* @__PURE__ */ new Set();
  const registry = {
    version: 1,
    register(provider) {
      if (typeof provider.sessionId !== "string" || typeof provider.isActive !== "function") {
        throw new Error("Unsupported session-liveness provider");
      }
      const release = previous?.register?.(provider);
      if (provider.name === "pi-subagents") providers.add(provider);
      return () => {
        providers.delete(provider);
        release?.();
      };
    }
  };
  globals[REGISTRY] = registry;
  let owner = null;
  let context = null;
  let active = false;
  let cancelling = false;
  let timer;
  const runs = /* @__PURE__ */ new Set();
  let runGeneration = 0;
  const interrupted = /* @__PURE__ */ new Set();
  let observationError;
  let cancellationDiagnostic;
  const emit = (state, error, token = owner) => {
    context?.ui.setWidget(ACP_LIFECYCLE_WIDGET, [
      JSON.stringify({ version: 1, owner: token, state, ...error ? { error } : {} })
    ]);
  };
  const currentProviders = () => [...providers].filter(
    (p) => p.sessionId === context?.sessionManager.getSessionId() && (!p.sessionFile || p.sessionFile === context?.sessionManager.getSessionFile())
  );
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = void 0;
  };
  const observe = () => {
    if (!owner || !context || !runs.size) return;
    try {
      const live = currentProviders();
      if (!live.length) throw new Error("pi-subagents did not register v1 host liveness; update the optional extension");
      const busy = live.some((p) => p.isActive());
      observationError = void 0;
      if (busy && !active) {
        active = true;
        emit("active");
      }
      if (active && !busy && context.isIdle() && !context.hasPendingMessages() && !cancelling) {
        active = false;
        runs.clear();
        stopTimer();
        emit("idle");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (observationError !== message) emit("error", message);
      observationError = message;
    }
  };
  const rpc = (method, deadline, id) => new Promise((resolve2, reject) => {
    const requestId = randomUUID4();
    const event = `subagents:rpc:v1:reply:${requestId}`;
    const timeout = setTimeout(
      () => {
        unsubscribe();
        reject(new Error(`pi-subagents ${method} timed out${id ? ` for ${id}` : ""}`));
      },
      Math.max(1, Math.min(5e3, deadline - Date.now()))
    );
    const unsubscribe = pi.events.on(event, (raw) => {
      const reply = raw;
      if (reply?.version !== 1 || reply.requestId !== requestId) return;
      clearTimeout(timeout);
      unsubscribe();
      if (reply.success === true && reply.data && (method !== "stop" || reply.data.runId === id)) resolve2(reply.data);
      else
        reject(
          Object.assign(
            new Error(
              `pi-subagents ${method} failed${id ? ` for ${id}` : ""}: ${String(reply.error?.message ?? "invalid reply")}`
            ),
            { code: reply.success === false ? reply.error?.code : void 0 }
          )
        );
    });
    pi.events.emit("subagents:rpc:v1:request", {
      version: 1,
      requestId,
      method,
      params: id ? { id } : {},
      source: { extension: "pi-acp" }
    });
  });
  pi.registerCommand("pi-acp-control", {
    description: "Internal ACP lifecycle bridge",
    async handler(args, ctx) {
      context = ctx;
      const [operation, id, deadlineText] = args.split(" ");
      if (operation === "begin" && id && /^[a-f0-9-]{36}$/.test(id)) {
        observe();
        try {
          if (active || runs.size) throw new Error("Previous ACP background work has not drained");
          owner = null;
          if (currentProviders().some((provider) => provider.isActive()))
            throw new Error(
              "Pre-existing or restored background work remains in this session; wait for it to finish or open a new session"
            );
          owner = id;
          cancelling = false;
          interrupted.clear();
          cancellationDiagnostic = void 0;
          emit("ready");
        } catch (error) {
          emit("rejected", error instanceof Error ? error.message : String(error), id);
        }
        return;
      }
      const deadline = Number(deadlineText);
      if (!["cancel", "check"].includes(operation) || id !== owner || !Number.isFinite(deadline) || deadline <= Date.now())
        throw new Error("Invalid ACP lifecycle owner or cancellation deadline");
      cancelling = true;
      try {
        const generation = runGeneration;
        let terminal = true;
        if (runs.size) {
          const status = await rpc("status", deadline);
          const snapshot = status.asyncSnapshot;
          if (snapshot?.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1 || !Array.isArray(snapshot.runs))
            throw new Error("Missing v1 async status snapshot during cancellation");
          if (operation === "cancel") {
            for (const root of runs) {
              if (!canonicalUuid.test(root)) continue;
              const node = snapshot.runs.find((node2) => node2.id === root);
              if (!node) continue;
              const candidates = /* @__PURE__ */ new Set();
              const queue = [...Array.isArray(node.children) ? node.children : []];
              for (let count = 0; queue.length && count < 256; count++) {
                const child = queue.shift();
                if (!child || typeof child !== "object") continue;
                if ((child.kind === "subagent" || child.kind === "workflow") && typeof child.id === "string" && canonicalUuid.test(child.id) && typeof snapshot.caps?.maxStringLength === "number" && child.id.length < snapshot.caps.maxStringLength)
                  candidates.add(child.id);
                if (Array.isArray(child.children)) queue.push(...child.children);
              }
              if (queue.length) continue;
              const statuses = /* @__PURE__ */ new Map();
              await Promise.all(
                [...candidates].map(async (id2) => {
                  try {
                    const status2 = await rpc("status", deadline, id2);
                    const headers = nestedStatus(status2.text, id2);
                    if (headers && id2 !== root && headers.parent !== id2) statuses.set(id2, headers);
                  } catch (error) {
                    if (!(error instanceof Error) || error.code !== "execution_failed")
                      throw error;
                    cancellationDiagnostic = error.message;
                  }
                })
              );
              const verified = /* @__PURE__ */ new Map();
              for (let changed = true; changed; ) {
                changed = false;
                for (const [id2, status2] of statuses) {
                  if (verified.has(id2) || status2.parent !== root && verified.get(status2.parent) !== status2.root)
                    continue;
                  verified.set(id2, status2.root);
                  changed = true;
                }
              }
              await Promise.all(
                [...verified.keys()].map(async (id2) => {
                  const state = statuses.get(id2).state;
                  if (interrupted.has(id2) || state !== "running" && state !== "queued") return;
                  try {
                    await rpc("interrupt", deadline, id2);
                    interrupted.add(id2);
                  } catch (error) {
                    if (!(error instanceof Error) || error.code !== "execution_failed")
                      throw error;
                    cancellationDiagnostic = error.message;
                  }
                })
              );
            }
          }
          await Promise.all(
            [...runs].map(async (id2) => {
              const run = snapshot.runs.find((run2) => run2.id === id2);
              if (!run) {
                terminal = false;
                return;
              }
              if (["complete", "failed", "partial", "paused", "stopped", "rejected"].includes(String(run.state))) return;
              terminal = false;
              if (run.state !== "queued" && run.state !== "running")
                throw new Error(`Invalid pi-subagents state for ${id2}`);
              if (operation === "check") return;
              try {
                await rpc("stop", deadline, id2);
              } catch (error) {
                const code = error.code;
                if (!(error instanceof Error) || /not found in the active session/.test(error.message) || code !== "not_found" && code !== "invalid_state")
                  throw error;
              }
            })
          );
        }
        if (operation === "cancel") {
          emit("stopping", cancellationDiagnostic);
          return;
        }
        const live = currentProviders();
        if (runs.size && !live.length) throw new Error("Missing pi-subagents liveness during cancellation");
        if (generation !== runGeneration || !terminal || live.some((provider) => provider.isActive()) || !ctx.isIdle() || ctx.hasPendingMessages()) {
          emit("pending", cancellationDiagnostic);
          return;
        }
        runs.clear();
        active = false;
        cancelling = false;
        cancellationDiagnostic = void 0;
        stopTimer();
        emit("cancelled");
      } catch (error) {
        stopTimer();
        emit("error", error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (!owner || event.toolName !== "subagent") return;
    const details = event.details;
    const id = details?.asyncId;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return;
    context = ctx;
    runs.add(id);
    runGeneration++;
    if (!active) {
      active = true;
      emit("active");
    }
    observe();
    timer ??= setInterval(observe, 50);
  });
  pi.on("agent_end", () => observe());
  pi.on("session_shutdown", () => {
    stopTimer();
    if (globals[REGISTRY] === registry) {
      if (previous === void 0) delete globals[REGISTRY];
      else globals[REGISTRY] = previous;
    }
  });
}
export {
  ACP_LIFECYCLE_WIDGET,
  acpExtension as default
};
//# sourceMappingURL=acp-extension.js.map