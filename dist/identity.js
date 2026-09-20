#!/usr/bin/env node

// src/runtime/identity.ts
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync as statSync2,
  unlinkSync,
  writeFileSync
} from "fs";
import { isAbsolute, join as join2 } from "path";

// src/acp/paths.ts
import { homedir } from "os";
import { join, resolve } from "path";
function getPiAcpDir() {
  return process.env.PI_ACP_DIR ? resolve(process.env.PI_ACP_DIR) : join(homedir(), ".pi", "pi-acp");
}

// src/pi-rpc/command.ts
import { statSync } from "fs";
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
    return statSync(path).isFile();
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
var bindingKey = /* @__PURE__ */ Symbol.for("@liuser/pi-acp/named-identity/v1");
var IDENTITY_CAPABILITY = "pi-acp/identity/v1";
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
  const root = join2(getPiAcpDir(), "identities");
  mkdirSync(root, { recursive: true, mode: 448 });
  const base = join2(root, identity.identityId);
  return { owner: `${base}.json`, guard: `${base}.guard`, cursor: `${base}.cursor.json` };
}
function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
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
      mkdirSync(paths.guard, { mode: 448 });
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
  const owner = { ...identity, nonce: randomUUID(), launcherPid: process.pid, childPid: null, cwd };
  guarded(() => {
    if (existsSync(paths.owner)) {
      const previous = JSON.parse(readFileSync(paths.owner, "utf8"));
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
    const current = JSON.parse(readFileSync(paths.owner, "utf8"));
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
function processIdentity() {
  const globals = globalThis;
  if (globals[bindingKey] !== void 0) return globals[bindingKey];
  const raw = process.env[ENV];
  delete process.env[ENV];
  let identity = null;
  if (raw) {
    const pointer = JSON.parse(raw);
    const owner = JSON.parse(readFileSync(pointer.path, "utf8"));
    if (owner.nonce === pointer.nonce && owner.childPid === process.pid) identity = parseIdentity(owner);
  }
  globals[bindingKey] = identity;
  return identity;
}
function rememberIdentitySession(identity, sessionFile, runtimeId) {
  writeAtomic(files(identity).cursor, { ...identity, sessionFile, runtimeId });
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
    const st = statSync2(path);
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
  const cursor = JSON.parse(readFileSync(path, "utf8"));
  if (cursor.identityId !== identity.identityId || cursor.agentDirectory !== identity.agentDirectory)
    throw new Error("Identity session directory mismatch");
  return cursor.sessionFile && existsSync(cursor.sessionFile) ? cursor.sessionFile : void 0;
}
function identitySession(identity) {
  return takeUsableSessionFile(recordedIdentitySessionPath(identity));
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
    env.PI_CODING_AGENT_SESSION_DIR = join2(identity.agentDirectory, "sessions");
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
async function runNamedTui(value) {
  const identity = parseIdentity(value);
  const sessionFile = resolveIdentitySessionFile(identity, value.sessionFile);
  const args = ["--session-dir", join2(identity.agentDirectory, "sessions")];
  if (sessionFile) args.push("--session", sessionFile);
  const child = spawnNamedPi(
    getPiCommand(process.env.PI_ACP_PI_COMMAND),
    args,
    value.cwd,
    { stdio: "inherit", env: { ...process.env, PI_MCP_TOOL_EXPOSURE: "proxy-only" } },
    identity
  );
  const forward = (signal) => {
    child.kill(signal);
  };
  const term = () => forward("SIGTERM");
  process.on("SIGTERM", term);
  try {
    return await new Promise((resolve2, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve2(code ?? 1));
    });
  } finally {
    process.off("SIGTERM", term);
  }
}
export {
  IDENTITY_CAPABILITY,
  claimIdentity,
  identitySession,
  parseIdentity,
  processIdentity,
  rememberIdentitySession,
  resolveIdentitySessionFile,
  runNamedTui,
  spawnNamedPi,
  usablePiSessionFile
};
//# sourceMappingURL=identity.js.map