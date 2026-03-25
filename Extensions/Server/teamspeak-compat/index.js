import {
  command,
  commandResponse,
  createServerContext,
  extensionSender,
  optionBoolean,
  optionNumber,
  optionString
} from "../../lib/opencom-extension-sdk.js";
import net from "node:net";
import { inflateRawSync } from "node:zlib";

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const TARGET_COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const MANAGER_ROLES = new Set(["owner", "admin", "platform_admin", "platform_owner", "server_admin"]);
const MAX_REMOTE_PACKS = 24;
const MAX_PACK_JSON_CHARS = 120_000;
const MAX_REMOTE_PACK_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_SINGLE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_COMMANDS_PER_PACK = 64;
const MAX_TEXT_LENGTH = 4_000;
const MAX_BRIDGE_OPERATIONS = 32;
const MAX_BRIDGE_GUILD_SNAPSHOTS = 4;
const BRIDGE_ROUTE_PATTERN = /^\/[a-zA-Z0-9/_-]{1,256}$/;
const DEFAULT_BRIDGE_TIMEOUT_MS = 8_000;
const MIN_BRIDGE_TIMEOUT_MS = 500;
const MAX_BRIDGE_TIMEOUT_MS = 30_000;
const DIRECT_BRIDGE_DEFAULT_QUERY_PORT = 10011;
const DIRECT_BRIDGE_DEFAULT_SERVER_PORT = 9987;
const DIRECT_BRIDGE_DEFAULT_SYNC_INTERVAL_SEC = 60;
const DIRECT_BRIDGE_MIN_SYNC_INTERVAL_SEC = 15;
const DIRECT_BRIDGE_MAX_SYNC_INTERVAL_SEC = 900;
const DIRECT_BRIDGE_DEFAULT_CATEGORY_NAME = "teamspeak";
const DIRECT_BRIDGE_MAX_CHANNELS = 256;
const DIRECT_BRIDGE_MAX_BINDINGS = 384;
const DIRECT_BRIDGE_SOCKET_TIMEOUT_MS = 10_000;
const DIRECT_BRIDGE_MAX_BUFFER_CHARS = 256_000;
const COMPAT_MANIFEST_FILE_BASENAMES = new Set([
  "opencom-compat.json",
  "teamspeak-compat.json",
  "opencom-pack.json",
  "opencom-extension.json"
]);
const TEAM_SPEAK_ARCHIVE_EXTENSIONS = [".ts3_plugin", ".ts3_addon", ".ts5addon", ".zip"];

const EXAMPLE_PACK_TEMPLATE = {
  id: "ts-example-pack",
  name: "TeamSpeak Example Pack",
  version: "1.0.0",
  description: "Sample TeamSpeak compatibility pack for OpenCom.",
  commands: [
    {
      name: "whoami",
      action: "reply",
      template: "client_nickname={username} client_database_id={userId} virtualserver_id={serverId}"
    },
    {
      name: "ping",
      action: "opencom_command",
      target: "ping-tools.ping",
      argMap: {
        text: "{message}"
      },
      passThroughArgs: true
    },
    {
      name: "native-ping",
      action: "native_bridge",
      route: "/v1/execute",
      requestTemplate: {
        kind: "ts-native-ping",
        message: "{message}"
      }
    }
  ]
};

const BUILTIN_PACK_DEFS = [
  {
    id: "teamspeak-core",
    name: "TeamSpeak Core",
    version: "1.0.0",
    description: "Official baseline TeamSpeak-style commands for OpenCom.",
    commands: [
      {
        name: "help",
        aliases: ["commands"],
        action: "reply",
        template: "TeamSpeak compatibility is active. Use /ts-compat-list and /ts-compat-run pack=teamspeak-core command=whoami."
      },
      {
        name: "whoami",
        aliases: ["me"],
        action: "reply",
        template: "client_nickname={username} client_database_id={userId} virtualserver_id={serverId}"
      },
      {
        name: "about",
        action: "reply",
        template: "OpenCom TeamSpeak compatibility layer. Pack={packId} Command={command}."
      },
      {
        name: "bridge-help",
        action: "reply",
        template: "Use native bridge commands by adding action=native_bridge in your compat pack."
      }
    ]
  },
  {
    id: "teamspeak-voice-lab",
    name: "TeamSpeak Voice Lab",
    version: "1.0.0",
    description: "Official voice bridge command set for radio/proximity style integrations.",
    commands: [
      {
        name: "radio-on",
        aliases: ["radio"],
        action: "native_bridge",
        route: "/v1/execute",
        requestTemplate: {
          mode: "radio",
          channelId: "{channelId}",
          radioId: "{radioId}"
        }
      },
      {
        name: "radio-off",
        action: "native_bridge",
        route: "/v1/execute",
        requestTemplate: {
          mode: "radio-off",
          channelId: "{channelId}",
          radioId: "{radioId}"
        }
      },
      {
        name: "proximity-apply",
        aliases: ["prox"],
        action: "native_bridge",
        route: "/v1/execute",
        requestTemplate: {
          mode: "proximity",
          nearUserIds: "{nearUserIds}",
          channelId: "{channelId}"
        }
      }
    ]
  }
];

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function asString(value, maxLength = 256) {
  const next = String(value || "").trim();
  if (!next) return "";
  return next.slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function isLocalHost(hostname) {
  const host = asString(hostname, 255).toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeIdentifier(value, pattern, field) {
  const id = asString(value, 256).toLowerCase();
  if (!id || !pattern.test(id)) {
    throw new Error(`Invalid ${field}`);
  }
  return id;
}

function parseCommandTokens(raw = "") {
  const tokens = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match = regex.exec(String(raw || ""));
  while (match) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"));
    match = regex.exec(String(raw || ""));
  }
  return tokens;
}

function coerceScalar(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

function parseRunArgs(rawValue) {
  const raw = asString(rawValue, MAX_PACK_JSON_CHARS);
  if (!raw) return {};
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Args JSON must be an object");
    }
    return parsed;
  }

  const tokens = parseCommandTokens(raw);
  const args = {};
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) {
      args[token] = true;
      continue;
    }
    const key = token.slice(0, idx).trim();
    if (!key) continue;
    args[key] = coerceScalar(token.slice(idx + 1));
  }
  return args;
}

function lookupTemplateValue(vars, path) {
  const direct = vars[path];
  if (direct !== undefined) return direct;
  if (!path.includes(".")) return "";
  const parts = path.split(".").filter(Boolean);
  let cursor = vars;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return "";
    cursor = cursor[part];
  }
  return cursor;
}

function renderTemplate(input, vars) {
  if (typeof input !== "string") return "";
  return input.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, token) => {
    const value = lookupTemplateValue(vars, token);
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function renderTemplateValue(input, vars) {
  if (typeof input === "string") return renderTemplate(input, vars);
  if (Array.isArray(input)) return input.map((item) => renderTemplateValue(item, vars));
  if (!input || typeof input !== "object") return input;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = renderTemplateValue(value, vars);
  }
  return output;
}

function normalizeBridgeBaseUrl(rawUrl) {
  const value = asString(rawUrl, 4096);
  if (!value) return "";

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Bridge URL is invalid");
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost(parsed.hostname))) {
    throw new Error("Bridge URL must use https (or http on localhost)");
  }
  parsed.hash = "";
  const normalized = parsed.toString().replace(/\/+$/, "");
  return normalized;
}

function normalizeBridgeRoute(rawValue) {
  const candidate = asString(rawValue, 260) || "/v1/execute";
  if (!BRIDGE_ROUTE_PATTERN.test(candidate)) {
    throw new Error(`Invalid bridge route '${candidate}'`);
  }
  return candidate;
}

function normalizeBridgeConfig(rawValue) {
  const source = asRecord(rawValue);
  const urlInput = source.baseUrl ?? source.url;
  let baseUrl = "";
  if (urlInput != null && String(urlInput).trim()) {
    baseUrl = normalizeBridgeBaseUrl(urlInput);
  }
  return {
    enabled: Boolean(source.enabled),
    baseUrl,
    authToken: asString(source.authToken ?? source.token, 2048),
    timeoutMs: clampNumber(source.timeoutMs, MIN_BRIDGE_TIMEOUT_MS, MAX_BRIDGE_TIMEOUT_MS, DEFAULT_BRIDGE_TIMEOUT_MS)
  };
}

function sanitizeOpenComChannelName(value, fallback = "teamspeak-channel") {
  const collapsed = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return asString(collapsed, 64) || fallback;
}

function normalizeTeamSpeakHost(rawValue) {
  const value = String(rawValue || "").trim().replace(/^\[|\]$/g, "");
  if (!value) return "";
  if (value.length > 255) throw new Error("TeamSpeak host is too long");
  if (/[/?#\s]/.test(value)) throw new Error("TeamSpeak host is invalid");
  return value;
}

function normalizeDirectBridgeState(rawValue) {
  const source = asRecord(rawValue);
  const bindingsInput = Array.isArray(source.channelBindings) ? source.channelBindings : [];
  const bindings = [];
  for (const rawBinding of bindingsInput.slice(0, DIRECT_BRIDGE_MAX_BINDINGS)) {
    const binding = asRecord(rawBinding);
    const remoteChannelId = asString(binding.remoteChannelId, 64);
    const channelId = asString(binding.channelId, 64);
    if (!remoteChannelId || !channelId) continue;
    bindings.push({
      remoteChannelId,
      channelId
    });
  }
  return {
    categoryChannelId: asString(source.categoryChannelId, 64),
    channelBindings: bindings,
    lastSyncedAt: asString(source.lastSyncedAt, 80),
    lastServerName: asString(source.lastServerName, 160),
    lastError: asString(source.lastError, 800),
    mirroredChannelCount: clampNumber(source.mirroredChannelCount, 0, DIRECT_BRIDGE_MAX_CHANNELS, bindings.length)
  };
}

function normalizeDirectBridgeConfig(rawValue) {
  const source = asRecord(rawValue);
  let host = "";
  if (source.host != null && String(source.host).trim()) {
    host = normalizeTeamSpeakHost(source.host);
  }
  const queryPort = clampNumber(source.queryPort, 1, 65535, DIRECT_BRIDGE_DEFAULT_QUERY_PORT);
  const serverPort = clampNumber(
    source.serverPort ?? source.virtualServerPort,
    1,
    65535,
    DIRECT_BRIDGE_DEFAULT_SERVER_PORT
  );
  return {
    enabled: Boolean(source.enabled),
    host,
    queryPort,
    serverPort,
    serverId: asString(source.serverId ?? source.virtualServerId, 32),
    username: asString(source.username ?? source.clientLoginName, 120),
    password: asString(source.password ?? source.clientLoginPassword, 256),
    categoryName: sanitizeOpenComChannelName(
      source.categoryName,
      DIRECT_BRIDGE_DEFAULT_CATEGORY_NAME
    ),
    syncIntervalSec: clampNumber(
      source.syncIntervalSec,
      DIRECT_BRIDGE_MIN_SYNC_INTERVAL_SEC,
      DIRECT_BRIDGE_MAX_SYNC_INTERVAL_SEC,
      DIRECT_BRIDGE_DEFAULT_SYNC_INTERVAL_SEC
    ),
    syncState: normalizeDirectBridgeState(source.syncState)
  };
}

function ensureDirectBridgeConfigured(directBridge) {
  if (!directBridge.enabled) {
    throw new Error("Direct TeamSpeak bridge is disabled.");
  }
  if (!directBridge.host) throw new Error("TeamSpeak host is required.");
  if (!directBridge.username) throw new Error("TeamSpeak username is required.");
  if (!directBridge.password) throw new Error("TeamSpeak password is required.");
  if (!directBridge.serverId && !directBridge.serverPort) {
    throw new Error("TeamSpeak server port or server id is required.");
  }
}

function encodeTeamSpeakQueryValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/ /g, "\\s")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function decodeTeamSpeakQueryValue(value) {
  return String(value ?? "").replace(/\\([\\\/psnrtabfv])/g, (_, token) => {
    switch (token) {
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "p":
        return "|";
      case "s":
        return " ";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "a":
        return "\u0007";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      default:
        return token;
    }
  });
}

function parseTeamSpeakFieldSegment(segment) {
  const fields = {};
  const tokens = String(segment || "").trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = decodeTeamSpeakQueryValue(token.slice(0, idx));
    const value = decodeTeamSpeakQueryValue(token.slice(idx + 1));
    fields[key] = value;
  }
  return fields;
}

function parseTeamSpeakRecordLines(lines) {
  const rows = [];
  for (const rawLine of lines || []) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    for (const segment of line.split("|")) {
      const parsed = parseTeamSpeakFieldSegment(segment);
      if (Object.keys(parsed).length) rows.push(parsed);
    }
  }
  return rows;
}

function parseTeamSpeakErrorLine(rawLine) {
  const fields = parseTeamSpeakFieldSegment(String(rawLine || "").replace(/^error\s+/i, ""));
  return {
    id: Number(fields.id || 0),
    message: asString(fields.msg || fields.message, 400) || "unknown error"
  };
}

async function openTeamSpeakQueryClient(directBridge) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let buffer = "";
    const pending = [];
    const socket = net.createConnection({
      host: directBridge.host,
      port: directBridge.queryPort
    });

    function rejectPending(error) {
      while (pending.length) {
        const entry = pending.shift();
        entry.reject(error);
      }
    }

    function handleFatal(error) {
      const err = error instanceof Error ? error : new Error(String(error || "TEAMSPEAK_QUERY_FAILED"));
      if (!settled) {
        settled = true;
        reject(err);
      }
      rejectPending(err);
    }

    function finalizeResolve() {
      if (settled) return;
      settled = true;
      resolve({
        async execute(commandText) {
          if (closed) throw new Error("TeamSpeak query client is closed.");
          return new Promise((resolveCommand, rejectCommand) => {
            pending.push({
              lines: [],
              resolve: resolveCommand,
              reject: rejectCommand
            });
            socket.write(`${commandText}\n`);
          });
        },
        close() {
          if (closed) return;
          closed = true;
          socket.end();
        }
      });
    }

    function handleLine(rawLine) {
      const line = String(rawLine || "").replace(/\r$/, "").trim();
      if (!line) return;
      const current = pending[0];
      if (!current) return;
      if (/^error\s+/i.test(line)) {
        pending.shift();
        const parsedError = parseTeamSpeakErrorLine(line);
        if (parsedError.id !== 0) {
          current.reject(new Error(`TEAMSPEAK_QUERY_${parsedError.id}: ${parsedError.message}`));
          return;
        }
        current.resolve(current.lines);
        return;
      }
      current.lines.push(line);
    }

    socket.setEncoding("utf8");
    socket.setTimeout(DIRECT_BRIDGE_SOCKET_TIMEOUT_MS);
    socket.on("connect", finalizeResolve);
    socket.on("timeout", () => socket.destroy(new Error("TEAMSPEAK_QUERY_TIMEOUT")));
    socket.on("error", handleFatal);
    socket.on("close", () => rejectPending(new Error("TEAMSPEAK_QUERY_DISCONNECTED")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > DIRECT_BRIDGE_MAX_BUFFER_CHARS) {
        socket.destroy(new Error("TEAMSPEAK_QUERY_RESPONSE_TOO_LARGE"));
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
}

async function fetchDirectBridgeSnapshot(directBridge) {
  ensureDirectBridgeConfigured(directBridge);
  const client = await openTeamSpeakQueryClient(directBridge);
  try {
    await client.execute(
      `login client_login_name=${encodeTeamSpeakQueryValue(directBridge.username)} ` +
      `client_login_password=${encodeTeamSpeakQueryValue(directBridge.password)}`
    );
    if (directBridge.serverId) {
      await client.execute(`use sid=${encodeTeamSpeakQueryValue(directBridge.serverId)}`);
    } else {
      await client.execute(`use port=${directBridge.serverPort}`);
    }

    const serverInfoRows = parseTeamSpeakRecordLines(await client.execute("serverinfo"));
    const channelRows = parseTeamSpeakRecordLines(await client.execute("channellist -flags -voice -limits"));
    const channels = channelRows
      .map((rawChannel) => {
        const channelId = asString(rawChannel.cid, 64);
        if (!channelId) return null;
        const name = sanitizeOpenComChannelName(
          rawChannel.channel_name,
          `teamspeak-${channelId}`
        );
        return {
          channelId,
          parentId: asString(rawChannel.pid, 64),
          orderAfterId: asString(rawChannel.channel_order, 64),
          name,
          totalClients: clampNumber(rawChannel.total_clients, 0, 10_000, 0)
        };
      })
      .filter(Boolean);
    if (channels.length > DIRECT_BRIDGE_MAX_CHANNELS) {
      throw new Error(`TeamSpeak server has too many channels to mirror (${channels.length} > ${DIRECT_BRIDGE_MAX_CHANNELS}).`);
    }

    return {
      serverName: sanitizeOpenComChannelName(
        serverInfoRows[0]?.virtualserver_name,
        "TeamSpeak"
      ),
      channels
    };
  } finally {
    await client.execute("quit").catch(() => {});
    client.close();
  }
}

function orderTeamSpeakSiblings(siblings) {
  const byId = new Map(siblings.map((channel) => [channel.channelId, channel]));
  const childrenByPrev = new Map();

  for (const channel of siblings) {
    const prevId = channel.orderAfterId && byId.has(channel.orderAfterId)
      ? channel.orderAfterId
      : "__root__";
    const bucket = childrenByPrev.get(prevId) || [];
    bucket.push(channel);
    childrenByPrev.set(prevId, bucket);
  }

  for (const bucket of childrenByPrev.values()) {
    bucket.sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      return byName || left.channelId.localeCompare(right.channelId);
    });
  }

  const ordered = [];
  const visited = new Set();

  function appendChain(prevId) {
    const bucket = childrenByPrev.get(prevId) || [];
    for (const channel of bucket) {
      if (visited.has(channel.channelId)) continue;
      visited.add(channel.channelId);
      ordered.push(channel);
      appendChain(channel.channelId);
    }
  }

  appendChain("__root__");
  for (const channel of siblings) {
    if (visited.has(channel.channelId)) continue;
    visited.add(channel.channelId);
    ordered.push(channel);
    appendChain(channel.channelId);
  }
  return ordered;
}

function flattenTeamSpeakChannels(channels) {
  const channelMap = new Map(channels.map((channel) => [channel.channelId, channel]));
  const childrenByParent = new Map();

  for (const channel of channels) {
    const parentId = channel.parentId && channelMap.has(channel.parentId)
      ? channel.parentId
      : "__root__";
    const bucket = childrenByParent.get(parentId) || [];
    bucket.push(channel);
    childrenByParent.set(parentId, bucket);
  }

  const ordered = [];

  function visit(parentId, pathParts) {
    const siblings = orderTeamSpeakSiblings(childrenByParent.get(parentId) || []);
    for (const channel of siblings) {
      const nextPath = [...pathParts, channel.name];
      ordered.push({
        ...channel,
        displayName: sanitizeOpenComChannelName(
          nextPath.join(" / "),
          `teamspeak-${channel.channelId}`
        )
      });
      visit(channel.channelId, nextPath);
    }
  }

  visit("__root__", []);
  return ordered;
}

async function getCurrentServerInfo(ctx) {
  const payload = await ctx.apis.core.get("/v1/servers");
  const servers = Array.isArray(payload?.servers) ? payload.servers : [];
  return servers.find((server) => String(server?.id || "") === String(ctx.serverId)) || null;
}

async function saveDirectBridgeConfig(ctx, baseConfig, directBridge) {
  const current = asRecord(await ctx.config.get().catch(() => baseConfig || {}));
  const nextConfig = {
    ...current,
    directBridge
  };
  await ctx.config.set(nextConfig);
  return nextConfig;
}

async function saveDirectBridgeFailure(ctx, runtime, directBridge, error) {
  const nextDirectBridge = {
    ...directBridge,
    syncState: {
      ...directBridge.syncState,
      lastError: asString(error?.message || "Direct TeamSpeak bridge failed.", 800)
    }
  };
  await saveDirectBridgeConfig(ctx, runtime.config, nextDirectBridge);
}

function buildDirectBridgeStatusLine(directBridge) {
  if (!directBridge.enabled) return "disabled";
  const target = directBridge.host
    ? `${directBridge.host}:${directBridge.queryPort}`
    : "(missing host)";
  const lastSync = directBridge.syncState.lastSyncedAt
    ? `, last sync ${directBridge.syncState.lastSyncedAt}`
    : "";
  return `enabled -> ${target}${lastSync}`;
}

async function syncDirectTeamSpeakBridge(ctx, runtime) {
  const directBridge = normalizeDirectBridgeConfig(runtime.config.directBridge);
  ensureDirectBridgeConfigured(directBridge);

  const serverInfo = await getCurrentServerInfo(ctx);
  const guildId = asString(serverInfo?.defaultGuildId ?? serverInfo?.default_guild_id, 64);
  if (!guildId) {
    throw new Error("This server has no default guild to mirror TeamSpeak into.");
  }

  const snapshot = await fetchDirectBridgeSnapshot(directBridge);
  const flattenedChannels = flattenTeamSpeakChannels(snapshot.channels);
  const currentChannelsPayload = await ctx.apis.node.get(`/v1/guilds/${guildId}/channels`);
  const currentChannels = Array.isArray(currentChannelsPayload?.channels) ? currentChannelsPayload.channels : [];
  const currentById = new Map(currentChannels.map((channel) => [String(channel.id), channel]));

  let category = currentById.get(directBridge.syncState.categoryChannelId);
  if (!category || category.type !== "category") {
    category = currentChannels.find((channel) => channel.type === "category" && channel.name === directBridge.categoryName) || null;
  }
  if (!category) {
    const createdCategory = await ctx.apis.node.post(`/v1/guilds/${guildId}/channels`, {
      name: directBridge.categoryName,
      type: "category",
      syncPermissions: false
    });
    const categoryId = asString(createdCategory?.channelId, 64);
    category = {
      id: categoryId,
      name: directBridge.categoryName,
      type: "category",
      position: currentChannels.reduce((max, channel) => Math.max(max, Number(channel.position) || 0), -1) + 1,
      parent_id: null
    };
    currentById.set(category.id, category);
  }

  const bindingMap = new Map();
  for (const binding of directBridge.syncState.channelBindings) {
    const existingChannel = currentById.get(binding.channelId);
    if (!existingChannel || existingChannel.type !== "voice") continue;
    bindingMap.set(binding.remoteChannelId, binding.channelId);
  }

  const managedChannelIds = new Set(bindingMap.values());
  const unmanagedMaxPosition = currentChannels.reduce((max, channel) => {
    if (channel.id === category.id) return max;
    if (managedChannelIds.has(channel.id)) return max;
    return Math.max(max, Number(channel.position) || 0);
  }, -1);
  const categoryPosition = unmanagedMaxPosition + 1;
  if (
    category.name !== directBridge.categoryName
    || Number(category.position) !== categoryPosition
  ) {
    await ctx.apis.node.patch(`/v1/channels/${category.id}`, {
      name: directBridge.categoryName,
      position: categoryPosition
    });
    category = {
      ...category,
      name: directBridge.categoryName,
      position: categoryPosition
    };
  }

  const unmatchedExisting = currentChannels.filter((channel) => (
    channel.type === "voice"
    && channel.parent_id === category.id
    && !managedChannelIds.has(channel.id)
  ));
  const nextBindings = [];
  const nextRemoteIds = new Set();
  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  for (let index = 0; index < flattenedChannels.length; index += 1) {
    const remoteChannel = flattenedChannels[index];
    nextRemoteIds.add(remoteChannel.channelId);
    const desiredPosition = categoryPosition + index + 1;
    let openComChannelId = bindingMap.get(remoteChannel.channelId) || "";
    let currentChannel = openComChannelId ? currentById.get(openComChannelId) : null;

    if (!currentChannel) {
      const adoptIndex = unmatchedExisting.findIndex((channel) => channel.name === remoteChannel.displayName);
      if (adoptIndex >= 0) {
        currentChannel = unmatchedExisting.splice(adoptIndex, 1)[0];
        openComChannelId = String(currentChannel.id);
      }
    }

    if (!currentChannel) {
      const created = await ctx.apis.node.post(`/v1/guilds/${guildId}/channels`, {
        name: remoteChannel.displayName,
        type: "voice",
        parentId: category.id,
        position: desiredPosition,
        syncPermissions: true
      });
      openComChannelId = asString(created?.channelId, 64);
      currentChannel = {
        id: openComChannelId,
        name: remoteChannel.displayName,
        type: "voice",
        parent_id: category.id,
        position: desiredPosition
      };
      currentById.set(openComChannelId, currentChannel);
      createdCount += 1;
    } else {
      const needsUpdate = (
        currentChannel.name !== remoteChannel.displayName
        || currentChannel.parent_id !== category.id
        || Number(currentChannel.position) !== desiredPosition
      );
      if (needsUpdate) {
        await ctx.apis.node.patch(`/v1/channels/${openComChannelId}`, {
          name: remoteChannel.displayName,
          parentId: category.id,
          position: desiredPosition,
          syncPermissions: true
        });
        currentChannel = {
          ...currentChannel,
          name: remoteChannel.displayName,
          parent_id: category.id,
          position: desiredPosition
        };
        currentById.set(openComChannelId, currentChannel);
        updatedCount += 1;
      }
    }

    nextBindings.push({
      remoteChannelId: remoteChannel.channelId,
      channelId: openComChannelId
    });
  }

  for (const binding of directBridge.syncState.channelBindings) {
    if (nextRemoteIds.has(binding.remoteChannelId)) continue;
    const staleChannel = currentById.get(binding.channelId);
    if (!staleChannel || staleChannel.type !== "voice") continue;
    if (staleChannel.parent_id !== category.id) continue;
    await ctx.apis.node.del(`/v1/channels/${binding.channelId}`);
    deletedCount += 1;
  }

  const nextDirectBridge = {
    ...directBridge,
    syncState: {
      ...directBridge.syncState,
      categoryChannelId: category.id,
      channelBindings: nextBindings,
      lastSyncedAt: new Date().toISOString(),
      lastServerName: snapshot.serverName,
      lastError: "",
      mirroredChannelCount: nextBindings.length
    }
  };
  await saveDirectBridgeConfig(ctx, runtime.config, nextDirectBridge);

  return {
    guildId,
    categoryName: directBridge.categoryName,
    serverName: snapshot.serverName,
    mirroredChannelCount: nextBindings.length,
    createdCount,
    updatedCount,
    deletedCount
  };
}

function normalizePackCommand(rawCommand) {
  const source = asRecord(rawCommand);
  const name = normalizeIdentifier(source.name, COMMAND_NAME_PATTERN, "pack command name");
  const actionInput = asString(source.action || "reply", 64).toLowerCase();
  const action = actionInput === "bridge" ? "native_bridge" : actionInput;
  if (action !== "reply" && action !== "opencom_command" && action !== "native_bridge") {
    throw new Error(`Unsupported action '${actionInput}' for command '${name}'`);
  }

  const aliases = Array.isArray(source.aliases)
    ? source.aliases
      .map((item) => asString(item, 128).toLowerCase())
      .filter((item) => item && item !== name && COMMAND_NAME_PATTERN.test(item))
      .slice(0, 12)
    : [];

  if (action === "reply") {
    const template = asString(source.template, MAX_TEXT_LENGTH);
    if (!template) throw new Error(`Command '${name}' is missing template`);
    return {
      name,
      aliases,
      action,
      description: asString(source.description, 240),
      template
    };
  }

  if (action === "native_bridge") {
    return {
      name,
      aliases,
      action,
      description: asString(source.description, 240),
      route: normalizeBridgeRoute(source.route ?? source.endpoint ?? "/v1/execute"),
      requestTemplate: asRecord(source.requestTemplate)
    };
  }

  const target = asString(source.target, 128).toLowerCase();
  if (!TARGET_COMMAND_PATTERN.test(target)) {
    throw new Error(`Command '${name}' has an invalid target`);
  }

  return {
    name,
    aliases,
    action,
    description: asString(source.description, 240),
    target,
    argMap: asRecord(source.argMap),
    passThroughArgs: Boolean(source.passThroughArgs)
  };
}

function normalizePack(rawPack, { source = "remote", builtin = false } = {}) {
  const candidate = asRecord(rawPack);
  const id = normalizeIdentifier(candidate.id, PACK_ID_PATTERN, "pack id");
  const name = asString(candidate.name, 120);
  if (!name) throw new Error(`Pack '${id}' is missing name`);
  const version = asString(candidate.version, 40) || "1.0.0";

  const commandsInput = Array.isArray(candidate.commands) ? candidate.commands : [];
  if (!commandsInput.length) throw new Error(`Pack '${id}' has no commands`);
  if (commandsInput.length > MAX_COMMANDS_PER_PACK) {
    throw new Error(`Pack '${id}' exceeds max command count (${MAX_COMMANDS_PER_PACK})`);
  }

  const commandMap = new Map();
  for (const item of commandsInput) {
    const normalized = normalizePackCommand(item);
    if (!commandMap.has(normalized.name)) {
      commandMap.set(normalized.name, normalized);
    }
  }

  if (!commandMap.size) throw new Error(`Pack '${id}' has no valid commands`);

  return {
    id,
    name,
    version,
    description: asString(candidate.description, 400),
    source: asString(candidate.source || source, 2048),
    builtin: Boolean(builtin),
    commands: Array.from(commandMap.values())
  };
}

function normalizePackUrl(rawUrl) {
  const value = asString(rawUrl, 4096);
  if (!value) throw new Error("URL is required");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost(parsed.hostname))) {
    throw new Error("Only https URLs are allowed (http is allowed for localhost)");
  }
  return parsed.toString();
}

function normalizeArchivePath(rawPath) {
  return String(rawPath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

function looksLikeZip(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && (
      (buffer[2] === 0x03 && buffer[3] === 0x04)
      || (buffer[2] === 0x05 && buffer[3] === 0x06)
      || (buffer[2] === 0x07 && buffer[3] === 0x08)
    );
}

function hasArchiveFileExtension(url) {
  const lower = asString(url, 4096).toLowerCase();
  return TEAM_SPEAK_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function findZipEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0x10000 - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (
      buffer[offset] === 0x50
      && buffer[offset + 1] === 0x4b
      && buffer[offset + 2] === 0x05
      && buffer[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

function extractZipFiles(buffer) {
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("Archive is missing central directory");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Archive has too many entries (${totalEntries} > ${MAX_ARCHIVE_ENTRIES})`);
  }
  if (centralDirectoryOffset >= buffer.length) {
    throw new Error("Archive central directory offset is invalid");
  }

  const files = new Map();
  let cursor = centralDirectoryOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error("Corrupted archive central directory");
    const signature = buffer.readUInt32LE(cursor);
    if (signature !== 0x02014b50) throw new Error("Invalid archive central directory signature");

    const generalPurposeBitFlag = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraFieldLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const fileNameStart = cursor + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > buffer.length) throw new Error("Corrupted archive file name");
    const fileName = normalizeArchivePath(buffer.subarray(fileNameStart, fileNameEnd).toString("utf8"));

    cursor = fileNameEnd + extraFieldLength + fileCommentLength;
    if (!fileName || fileName.endsWith("/")) continue;

    if (generalPurposeBitFlag & 0x0001) {
      throw new Error("Encrypted archive entries are not supported");
    }
    if (uncompressedSize > MAX_ARCHIVE_SINGLE_FILE_BYTES) {
      throw new Error(`Archive file '${fileName}' exceeds ${MAX_ARCHIVE_SINGLE_FILE_BYTES} bytes`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(`Archive total uncompressed size exceeds ${MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES} bytes`);
    }
    if (localHeaderOffset + 30 > buffer.length) throw new Error("Archive local header is invalid");

    const localSignature = buffer.readUInt32LE(localHeaderOffset);
    if (localSignature !== 0x04034b50) throw new Error("Invalid archive local file header signature");

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`Archive data for '${fileName}' is out of bounds`);

    const compressedData = buffer.subarray(dataStart, dataEnd);
    let fileData;
    if (compressionMethod === 0) {
      fileData = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      fileData = inflateRawSync(compressedData);
    } else {
      throw new Error(`Archive file '${fileName}' uses unsupported compression method ${compressionMethod}`);
    }

    if (!(generalPurposeBitFlag & 0x0008) && fileData.length !== uncompressedSize) {
      throw new Error(`Archive file '${fileName}' size mismatch`);
    }

    files.set(fileName, fileData);
  }

  return files;
}

function findArchiveFileByBasename(files, basenames) {
  for (const [filePath, data] of files.entries()) {
    const segments = filePath.split("/");
    const basename = asString(segments[segments.length - 1], 255).toLowerCase();
    if (basenames.has(basename)) {
      return { filePath, data };
    }
  }
  return null;
}

function parseIniFile(rawText) {
  const input = String(rawText || "");
  const sections = {};
  let section = "";
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const nextSection = line.match(/^\[([^\]]+)\]$/);
    if (nextSection) {
      section = asString(nextSection[1], 64).toLowerCase();
      if (!sections[section]) sections[section] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = asString(line.slice(0, eq), 120).toLowerCase();
    const value = line.slice(eq + 1).trim();
    const target = sections[section] || (sections[section] = {});
    if (key) target[key] = value;
  }
  return sections;
}

function createIdFromPluginName(input) {
  const base = asString(input, 120).toLowerCase();
  const collapsed = base
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  const candidate = collapsed || "teamspeak-imported";
  return candidate.length >= 2 ? candidate.slice(0, 64) : "teamspeak-imported";
}

function buildMetadataOnlyPackFromPackageIni(rawIni, sourceUrl) {
  const parsed = parseIniFile(rawIni);
  const plugin = asRecord(parsed.plugin || parsed.general || parsed.package || {});
  const name = asString(
    plugin.name
      || plugin.title
      || plugin.package_name
      || "TeamSpeak Imported Package",
    120
  );
  const version = asString(plugin.version || plugin.package_version || "1.0.0", 40) || "1.0.0";
  const id = createIdFromPluginName(plugin.api || plugin.id || plugin.name || plugin.package_id || name);
  const description = asString(
    plugin.description || plugin.summary || "Imported from TeamSpeak package metadata.",
    400
  );
  return normalizePack({
    id,
    name,
    version,
    description,
    commands: [
      {
        name: "about",
        action: "reply",
        template: `Imported TeamSpeak package '${name}' (${version}). Source: ${sourceUrl}`
      }
    ]
  }, {
    source: `${sourceUrl}#package.ini`,
    builtin: false
  });
}

function parseArchiveIntoPack(archiveBuffer, sourceUrl) {
  const files = extractZipFiles(archiveBuffer);
  const manifestEntry = findArchiveFileByBasename(files, COMPAT_MANIFEST_FILE_BASENAMES);
  if (manifestEntry) {
    const text = manifestEntry.data.toString("utf8");
    if (text.length > MAX_PACK_JSON_CHARS) {
      throw new Error(`Compatibility manifest '${manifestEntry.filePath}' exceeds ${MAX_PACK_JSON_CHARS} characters`);
    }
    const parsed = JSON.parse(text);
    return normalizePack(parsed, { source: `${sourceUrl}#${manifestEntry.filePath}`, builtin: false });
  }

  const nativeBinaries = Array.from(files.keys())
    .filter((filePath) => /\.(dll|so|dylib)$/i.test(filePath));

  const packageIniEntry = findArchiveFileByBasename(files, new Set(["package.ini"]));
  if (nativeBinaries.length) {
    throw new Error(
      `This TeamSpeak package contains native plugin binaries (${nativeBinaries.slice(0, 3).join(", ")}). ` +
      "Native TeamSpeak binaries cannot run inside OpenCom. Add opencom-compat.json to the archive for direct import."
    );
  }
  if (packageIniEntry) {
    return buildMetadataOnlyPackFromPackageIni(packageIniEntry.data.toString("utf8"), sourceUrl);
  }

  throw new Error(
    "Archive is missing a compatibility manifest. Add opencom-compat.json (or teamspeak-compat.json) to import directly."
  );
}

function parseJsonTextIntoPack(rawText, sourceUrl) {
  const text = String(rawText || "").trim();
  if (!text) throw new Error("Remote response was empty");
  if (text.length > MAX_PACK_JSON_CHARS) {
    throw new Error(`Remote payload exceeds ${MAX_PACK_JSON_CHARS} characters`);
  }
  const parsed = JSON.parse(text);
  return normalizePack(parsed, { source: sourceUrl, builtin: false });
}

async function fetchRemoteResource(rawUrl) {
  const url = normalizePackUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, application/zip, application/octet-stream, text/plain;q=0.9, */*;q=0.8"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_REMOTE_PACK_BYTES) {
      throw new Error(`Remote payload exceeds ${MAX_REMOTE_PACK_BYTES} bytes`);
    }
    return {
      bytes,
      sourceUrl: url,
      contentType: asString(response.headers.get("content-type"), 200).toLowerCase()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAndParsePackFromUrl(rawUrl) {
  const remote = await fetchRemoteResource(rawUrl);
  const shouldTreatAsArchive = looksLikeZip(remote.bytes)
    || hasArchiveFileExtension(remote.sourceUrl)
    || remote.contentType.includes("application/zip");

  if (shouldTreatAsArchive) {
    const pack = parseArchiveIntoPack(remote.bytes, remote.sourceUrl);
    return { pack, sourceUrl: remote.sourceUrl, importedFromArchive: true };
  }

  const text = remote.bytes.toString("utf8");
  const pack = parseJsonTextIntoPack(text, remote.sourceUrl);
  return { pack, sourceUrl: remote.sourceUrl, importedFromArchive: false };
}

const BUILTIN_PACKS = BUILTIN_PACK_DEFS.map((pack) => normalizePack(pack, { source: "builtin", builtin: true }));
const BUILTIN_PACK_IDS = new Set(BUILTIN_PACKS.map((pack) => pack.id));

function buildPackMap(config) {
  const packMap = new Map();
  for (const pack of BUILTIN_PACKS) {
    packMap.set(pack.id, pack);
  }

  const remotePacks = Array.isArray(config.remotePacks) ? config.remotePacks : [];
  for (const rawPack of remotePacks) {
    try {
      const normalized = normalizePack(rawPack, { source: asString(rawPack?.source, 2048) || "saved", builtin: false });
      if (BUILTIN_PACK_IDS.has(normalized.id)) continue;
      packMap.set(normalized.id, normalized);
    } catch {
      // Skip malformed remote packs to keep runtime stable.
    }
  }

  return packMap;
}

function buildEnabledPackSet(config, packMap) {
  if (!Array.isArray(config.enabledPackIds)) {
    return new Set(BUILTIN_PACKS.map((pack) => pack.id));
  }
  const ids = config.enabledPackIds
    .map((item) => asString(item, 120).toLowerCase())
    .filter((id) => id && packMap.has(id));
  return new Set(ids);
}

function resolvePackCommand(pack, inputName) {
  const wanted = asString(inputName, 120).toLowerCase();
  if (!wanted) return null;
  return pack.commands.find((item) => item.name === wanted || item.aliases.includes(wanted)) || null;
}

function formatResultValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, MAX_TEXT_LENGTH);
  return JSON.stringify(value).slice(0, MAX_TEXT_LENGTH);
}

async function saveRemotePack(ctx, runtime, pack) {
  if (BUILTIN_PACK_IDS.has(pack.id)) {
    throw new Error(`Pack '${pack.id}' is reserved for built-in packs and cannot be replaced.`);
  }

  const previousRemotePacks = Array.isArray(runtime.config.remotePacks) ? runtime.config.remotePacks : [];
  const remote = previousRemotePacks
    .filter((item) => asString(item?.id, 120).toLowerCase() !== pack.id);
  if (remote.length >= MAX_REMOTE_PACKS) {
    throw new Error(`Cannot install more than ${MAX_REMOTE_PACKS} remote packs.`);
  }

  remote.push(pack);
  const nextEnabled = new Set(runtime.enabledPackIds);
  nextEnabled.add(pack.id);

  await ctx.config.set({
    ...runtime.config,
    remotePacks: remote,
    enabledPackIds: Array.from(nextEnabled.values()).sort()
  });
}

async function getRuntime(ctx) {
  const config = asRecord(await ctx.config.get().catch(() => ({})));
  const senderName = asString(config.senderName, 64) || "TeamSpeak Bridge";
  const senderAvatarUrl = asString(config.senderAvatarUrl, 4096);
  let sender = extensionSender(senderName);
  if (senderAvatarUrl) {
    try {
      sender = extensionSender(senderName, senderAvatarUrl);
    } catch {
      sender = extensionSender(senderName);
    }
  }
  const packMap = buildPackMap(config);
  const enabledPackIds = buildEnabledPackSet(config, packMap);
  const bridge = normalizeBridgeConfig(config.bridge);
  const directBridge = normalizeDirectBridgeConfig(config.directBridge);
  return { config, sender, packMap, enabledPackIds, bridge, directBridge };
}

async function canManageCompatibility(ctx) {
  const payload = await ctx.apis.core.get("/v1/servers").catch(() => null);
  const servers = Array.isArray(payload?.servers) ? payload.servers : [];
  const match = servers.find((server) => String(server?.id || "") === String(ctx.serverId));
  const roles = Array.isArray(match?.roles) ? match.roles : [];
  return roles.some((role) => MANAGER_ROLES.has(asString(role, 64).toLowerCase()));
}

async function requireManager(ctx, sender, actionLabel) {
  if (await canManageCompatibility(ctx)) return null;
  return commandResponse({
    content: `Only server owners/admins can ${actionLabel}.`,
    sender
  });
}

function buildStatusSummary(runtime) {
  const remoteCount = Array.isArray(runtime.config.remotePacks) ? runtime.config.remotePacks.length : 0;
  const enabled = Array.from(runtime.enabledPackIds.values()).sort();
  const runAccess = runtime.config.allowMemberExecution ? "all members" : "owners/admins only";
  const bridgeState = runtime.bridge.enabled
    ? `enabled -> ${runtime.bridge.baseUrl || "(missing url)"}`
    : "disabled";
  const directBridgeState = buildDirectBridgeStatusLine(runtime.directBridge);
  return [
    "TeamSpeak compatibility layer is active.",
    `Execution access: ${runAccess}.`,
    `Native bridge: ${bridgeState}.`,
    `Direct TeamSpeak mirror: ${directBridgeState}.`,
    `Packs installed: ${runtime.packMap.size} (${remoteCount} remote).`,
    `Enabled packs: ${enabled.length ? enabled.join(", ") : "none"}.`,
    "Run commands with /ts-compat-run pack=<pack> command=<command> [args=\"key=value ...\"]"
  ].join("\n");
}

async function buildTemplateVars(ctx, args, pack, packCommand) {
  const me = await ctx.apis.core.get("/v1/me").catch(() => null);
  const username = asString(me?.username, 120) || ctx.userId;
  const vars = {
    userId: ctx.userId,
    serverId: ctx.serverId,
    username,
    extensionId: ctx.meta.extensionId,
    packId: pack.id,
    packName: pack.name,
    command: packCommand.name,
    nowIso: new Date().toISOString(),
    args: asRecord(args)
  };
  for (const [key, value] of Object.entries(args || {})) {
    if (!(key in vars)) vars[key] = value;
  }
  return vars;
}

function normalizeBridgeResponse(payload, fallbackSender) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const content = typeof payload.content === "string" ? payload.content.slice(0, MAX_TEXT_LENGTH) : "";
    const embeds = Array.isArray(payload.embeds)
      ? payload.embeds.filter((item) => item && typeof item === "object").slice(0, 5)
      : [];
    if (content || embeds.length) {
      return { content, embeds, sender: payload.sender && typeof payload.sender === "object" ? payload.sender : fallbackSender };
    }
  }
  return null;
}

async function executeNativeBridgeCommand(ctx, runtime, pack, packCommand, args, vars) {
  if (!runtime.bridge.enabled) {
    return commandResponse({
      content: "Native bridge is disabled. Use /ts-compat-bridge-config enabled=true url=<...> to enable it.",
      sender: runtime.sender
    });
  }
  if (!runtime.bridge.baseUrl) {
    return commandResponse({
      content: "Native bridge URL is missing. Configure it with /ts-compat-bridge-config url=<...>.",
      sender: runtime.sender
    });
  }

  const route = normalizeBridgeRoute(packCommand.route || "/v1/execute");
  const basePayload = {
    pack: {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      source: pack.source
    },
    command: {
      name: packCommand.name,
      action: packCommand.action,
      route
    },
    context: {
      extensionId: ctx.meta.extensionId,
      extensionName: ctx.meta.extensionName,
      userId: ctx.userId,
      serverId: ctx.serverId,
      username: asString(vars.username, 120),
      nowIso: asString(vars.nowIso, 80)
    },
    args: asRecord(args)
  };
  const templated = renderTemplateValue(packCommand.requestTemplate || {}, vars);
  const payload = {
    ...basePayload,
    ...(templated && typeof templated === "object" && !Array.isArray(templated) ? templated : {})
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), runtime.bridge.timeoutMs);
  try {
    const response = await fetch(`${runtime.bridge.baseUrl}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(runtime.bridge.authToken ? { Authorization: `Bearer ${runtime.bridge.authToken}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const contentType = asString(response.headers.get("content-type"), 200).toLowerCase();
    const bodyText = await response.text().catch(() => "");
    const responseJson = contentType.includes("application/json")
      ? JSON.parse(bodyText || "{}")
      : null;

    if (!response.ok) {
      const responseMessage = responseJson && typeof responseJson === "object"
        ? asString(responseJson.error || responseJson.message, 300)
        : asString(bodyText, 300);
      return commandResponse({
        content: `Native bridge error (${response.status})${responseMessage ? `: ${responseMessage}` : ""}`,
        sender: runtime.sender
      });
    }

    if (responseJson) {
      const direct = normalizeBridgeResponse(responseJson, runtime.sender);
      if (direct) return direct;
      const nested = normalizeBridgeResponse(responseJson.result, runtime.sender);
      if (nested) return nested;
      const message = asString(responseJson.message || responseJson.status, MAX_TEXT_LENGTH);
      if (message) return commandResponse({ content: message, sender: runtime.sender });
      if (responseJson.result !== undefined) {
        return commandResponse({ content: formatResultValue(responseJson.result), sender: runtime.sender });
      }
      return commandResponse({ content: "Native bridge executed successfully.", sender: runtime.sender });
    }

    const text = asString(bodyText, MAX_TEXT_LENGTH) || "Native bridge executed successfully.";
    return commandResponse({ content: text, sender: runtime.sender });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? `Native bridge timed out after ${runtime.bridge.timeoutMs}ms`
      : `Native bridge request failed: ${error?.message || "UNKNOWN_ERROR"}`;
    return commandResponse({ content: message, sender: runtime.sender });
  } finally {
    clearTimeout(timeout);
  }
}

async function runCompatibilityCommand(ctx, runtime, pack, packCommand, args) {
  const vars = await buildTemplateVars(ctx, args, pack, packCommand);
  if (packCommand.action === "reply") {
    const content = asString(renderTemplate(packCommand.template, vars), MAX_TEXT_LENGTH) || "(empty response)";
    return commandResponse({ content, sender: runtime.sender });
  }

  if (packCommand.action === "native_bridge") {
    return executeNativeBridgeCommand(ctx, runtime, pack, packCommand, args, vars);
  }

  const target = asString(packCommand.target, 128).toLowerCase();
  if (!target) {
    return commandResponse({ content: "Pack command target is missing.", sender: runtime.sender });
  }
  if (target === ctx.meta.commandName || target.startsWith(`${ctx.meta.extensionId}.`)) {
    return commandResponse({ content: `Refusing recursive target '${target}'.`, sender: runtime.sender });
  }

  const mapped = renderTemplateValue(packCommand.argMap || {}, vars);
  const mappedArgs = mapped && typeof mapped === "object" && !Array.isArray(mapped) ? mapped : {};
  const finalArgs = packCommand.passThroughArgs ? { ...args, ...mappedArgs } : mappedArgs;

  try {
    const nested = await ctx.apis.node.post(`/v1/extensions/commands/${encodeURIComponent(target)}/execute`, {
      args: finalArgs
    });
    const nestedResult = nested?.result;
    if (nestedResult && typeof nestedResult === "object" && (typeof nestedResult.content === "string" || Array.isArray(nestedResult.embeds))) {
      return nestedResult;
    }
    const rendered = nestedResult == null
      ? `Executed mapped command '${target}'.`
      : formatResultValue(nestedResult);
    return commandResponse({ content: rendered || `Executed mapped command '${target}'.`, sender: runtime.sender });
  } catch (error) {
    return commandResponse({
      content: `Mapped command '${target}' failed: ${error?.message || "UNKNOWN_ERROR"}`,
      sender: runtime.sender
    });
  }
}

export const commands = [
  command({
    name: "ts-compat-status",
    description: "Show TeamSpeak compatibility-layer status",
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      return commandResponse({ content: buildStatusSummary(runtime), sender: runtime.sender });
    }
  }),
  command({
    name: "ts-compat-list",
    description: "List installed TeamSpeak compatibility packs",
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const lines = Array.from(runtime.packMap.values())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((pack) => {
          const enabled = runtime.enabledPackIds.has(pack.id) ? "enabled" : "disabled";
          const source = pack.builtin ? "builtin" : "remote";
          const commandList = pack.commands.slice(0, 6).map((item) => item.name).join(", ");
          const suffix = pack.commands.length > 6 ? ` +${pack.commands.length - 6} more` : "";
          return `- ${pack.id} [${enabled}, ${source}] -> ${commandList}${suffix}`;
        });
      return commandResponse({
        content: lines.length ? `Compatibility packs:\n${lines.join("\n")}` : "No compatibility packs installed.",
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-compat-enable",
    description: "Enable or disable a TeamSpeak compatibility pack",
    options: [
      optionString("pack", "Pack id", true),
      optionBoolean("enabled", "true to enable, false to disable", true)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "enable or disable compatibility packs");
      if (denied) return denied;

      let packId;
      try {
        packId = normalizeIdentifier(ctx.args?.pack, PACK_ID_PATTERN, "pack id");
      } catch (error) {
        return commandResponse({ content: error?.message || "Invalid pack id.", sender: runtime.sender });
      }
      if (!runtime.packMap.has(packId)) {
        return commandResponse({ content: `Pack '${packId}' was not found.`, sender: runtime.sender });
      }
      const enabled = Boolean(ctx.args?.enabled);
      const nextEnabled = new Set(runtime.enabledPackIds);
      if (enabled) nextEnabled.add(packId);
      else nextEnabled.delete(packId);

      await ctx.config.set({
        ...runtime.config,
        enabledPackIds: Array.from(nextEnabled.values()).sort()
      });
      return commandResponse({
        content: `${enabled ? "Enabled" : "Disabled"} pack '${packId}'.`,
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-compat-access",
    description: "Set whether non-admin members can run compatibility commands",
    options: [
      optionBoolean("allowMembers", "true to allow all members to run pack commands", true)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "change compatibility execution access");
      if (denied) return denied;

      const allowMembers = Boolean(ctx.args?.allowMembers);
      await ctx.config.set({
        ...runtime.config,
        allowMemberExecution: allowMembers
      });
      return commandResponse({
        content: `Compatibility command execution is now ${allowMembers ? "open to all members" : "restricted to owners/admins"}.`,
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-compat-bridge-status",
    description: "Show native bridge connectivity settings",
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const bridge = runtime.bridge;
      return commandResponse({
        content: [
          "Native bridge settings:",
          `- enabled: ${bridge.enabled ? "true" : "false"}`,
          `- url: ${bridge.baseUrl || "(not configured)"}`,
          `- token: ${bridge.authToken ? "(set)" : "(not set)"}`,
          `- timeoutMs: ${bridge.timeoutMs}`
        ].join("\n"),
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-compat-bridge-config",
    description: "Configure isolated native bridge service",
    options: [
      optionBoolean("enabled", "Enable or disable native bridge", false),
      optionString("url", "Bridge base URL (https, or http://localhost)", false),
      optionString("token", "Optional bearer token for bridge auth", false),
      optionNumber("timeoutMs", "Bridge timeout in milliseconds", false),
      optionBoolean("clearUrl", "Clear configured bridge URL", false),
      optionBoolean("clearToken", "Clear configured bridge token", false)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "configure native bridge");
      if (denied) return denied;

      const current = runtime.bridge;
      const nextBridge = { ...current };

      if (typeof ctx.args?.enabled === "boolean") {
        nextBridge.enabled = ctx.args.enabled;
      }
      if (ctx.args?.url != null && String(ctx.args.url).trim()) {
        try {
          nextBridge.baseUrl = normalizeBridgeBaseUrl(ctx.args.url);
        } catch (error) {
          return commandResponse({
            content: error?.message || "Invalid bridge URL",
            sender: runtime.sender
          });
        }
      }
      if (ctx.args?.token != null && String(ctx.args.token).trim()) {
        nextBridge.authToken = asString(ctx.args.token, 2048);
      }
      if (ctx.args?.timeoutMs != null) {
        nextBridge.timeoutMs = clampNumber(
          ctx.args.timeoutMs,
          MIN_BRIDGE_TIMEOUT_MS,
          MAX_BRIDGE_TIMEOUT_MS,
          DEFAULT_BRIDGE_TIMEOUT_MS
        );
      }
      if (ctx.args?.clearUrl === true) nextBridge.baseUrl = "";
      if (ctx.args?.clearToken === true) nextBridge.authToken = "";

      if (nextBridge.enabled && !nextBridge.baseUrl) {
        return commandResponse({
          content: "Bridge cannot be enabled without a URL. Set url=<...> first or keep enabled=false.",
          sender: runtime.sender
        });
      }

      await ctx.config.set({
        ...runtime.config,
        bridge: nextBridge
      });

      return commandResponse({
        content: [
          "Updated native bridge settings.",
          `- enabled: ${nextBridge.enabled ? "true" : "false"}`,
          `- url: ${nextBridge.baseUrl || "(not configured)"}`,
          `- token: ${nextBridge.authToken ? "(set)" : "(not set)"}`,
          `- timeoutMs: ${nextBridge.timeoutMs}`
        ].join("\n"),
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-direct-bridge-status",
    description: "Show direct TeamSpeak mirror settings",
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const directBridge = runtime.directBridge;
      const selection = directBridge.serverId
        ? `sid=${directBridge.serverId}`
        : `port=${directBridge.serverPort}`;
      return commandResponse({
        content: [
          "Direct TeamSpeak mirror:",
          `- enabled: ${directBridge.enabled ? "true" : "false"}`,
          `- host: ${directBridge.host || "(not configured)"}`,
          `- queryPort: ${directBridge.queryPort}`,
          `- virtualServer: ${selection}`,
          `- username: ${directBridge.username ? "(set)" : "(not configured)"}`,
          `- password: ${directBridge.password ? "(set)" : "(not set)"}`,
          `- categoryName: ${directBridge.categoryName}`,
          `- syncIntervalSec: ${directBridge.syncIntervalSec}`,
          `- lastServerName: ${directBridge.syncState.lastServerName || "(unknown)"}`,
          `- lastSyncedAt: ${directBridge.syncState.lastSyncedAt || "(never)"}`,
          `- mirroredChannels: ${directBridge.syncState.mirroredChannelCount}`,
          `- lastError: ${directBridge.syncState.lastError || "(none)"}`
        ].join("\n"),
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-direct-bridge-config",
    description: "Configure direct TeamSpeak channel mirroring into the server",
    options: [
      optionBoolean("enabled", "Enable or disable direct TeamSpeak mirroring", false),
      optionString("host", "TeamSpeak ServerQuery hostname or IP", false),
      optionNumber("queryPort", "TeamSpeak ServerQuery port (default 10011)", false),
      optionNumber("serverPort", "TeamSpeak virtual server port (default 9987)", false),
      optionString("serverId", "Optional TeamSpeak virtual server id (sid)", false),
      optionString("username", "TeamSpeak ServerQuery username", false),
      optionString("password", "TeamSpeak ServerQuery password", false),
      optionString("categoryName", "OpenCom category name for mirrored channels", false),
      optionNumber("syncIntervalSec", "Suggested client-side sync interval in seconds", false),
      optionBoolean("clearPassword", "Clear the saved TeamSpeak password", false),
      optionBoolean("clearServerId", "Clear the saved TeamSpeak virtual server id", false)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "configure direct TeamSpeak mirroring");
      if (denied) return denied;

      const nextDirectBridge = {
        ...runtime.directBridge,
        syncState: {
          ...runtime.directBridge.syncState,
          lastError: ""
        }
      };

      if (typeof ctx.args?.enabled === "boolean") {
        nextDirectBridge.enabled = ctx.args.enabled;
      }
      if (ctx.args?.host != null && String(ctx.args.host).trim()) {
        try {
          nextDirectBridge.host = normalizeTeamSpeakHost(ctx.args.host);
        } catch (error) {
          return commandResponse({
            content: error?.message || "Invalid TeamSpeak host",
            sender: runtime.sender
          });
        }
      }
      if (ctx.args?.queryPort != null) {
        nextDirectBridge.queryPort = clampNumber(
          ctx.args.queryPort,
          1,
          65535,
          DIRECT_BRIDGE_DEFAULT_QUERY_PORT
        );
      }
      if (ctx.args?.serverPort != null) {
        nextDirectBridge.serverPort = clampNumber(
          ctx.args.serverPort,
          1,
          65535,
          DIRECT_BRIDGE_DEFAULT_SERVER_PORT
        );
      }
      if (ctx.args?.serverId != null && String(ctx.args.serverId).trim()) {
        nextDirectBridge.serverId = asString(ctx.args.serverId, 32);
      }
      if (ctx.args?.username != null && String(ctx.args.username).trim()) {
        nextDirectBridge.username = asString(ctx.args.username, 120);
      }
      if (ctx.args?.password != null && String(ctx.args.password).trim()) {
        nextDirectBridge.password = asString(ctx.args.password, 256);
      }
      if (ctx.args?.categoryName != null && String(ctx.args.categoryName).trim()) {
        nextDirectBridge.categoryName = sanitizeOpenComChannelName(
          ctx.args.categoryName,
          DIRECT_BRIDGE_DEFAULT_CATEGORY_NAME
        );
      }
      if (ctx.args?.syncIntervalSec != null) {
        nextDirectBridge.syncIntervalSec = clampNumber(
          ctx.args.syncIntervalSec,
          DIRECT_BRIDGE_MIN_SYNC_INTERVAL_SEC,
          DIRECT_BRIDGE_MAX_SYNC_INTERVAL_SEC,
          DIRECT_BRIDGE_DEFAULT_SYNC_INTERVAL_SEC
        );
      }
      if (ctx.args?.clearPassword === true) nextDirectBridge.password = "";
      if (ctx.args?.clearServerId === true) nextDirectBridge.serverId = "";

      await saveDirectBridgeConfig(ctx, runtime.config, nextDirectBridge);

      const summaryLines = [
        "Updated direct TeamSpeak mirror settings.",
        `- enabled: ${nextDirectBridge.enabled ? "true" : "false"}`,
        `- host: ${nextDirectBridge.host || "(not configured)"}`,
        `- queryPort: ${nextDirectBridge.queryPort}`,
        `- virtualServer: ${nextDirectBridge.serverId ? `sid=${nextDirectBridge.serverId}` : `port=${nextDirectBridge.serverPort}`}`,
        `- username: ${nextDirectBridge.username ? "(set)" : "(not configured)"}`,
        `- password: ${nextDirectBridge.password ? "(set)" : "(not set)"}`,
        `- categoryName: ${nextDirectBridge.categoryName}`,
        `- syncIntervalSec: ${nextDirectBridge.syncIntervalSec}`
      ];

      if (
        nextDirectBridge.enabled
        && nextDirectBridge.host
        && nextDirectBridge.username
        && nextDirectBridge.password
      ) {
        try {
          const syncResult = await syncDirectTeamSpeakBridge(ctx, {
            ...runtime,
            config: {
              ...runtime.config,
              directBridge: nextDirectBridge
            }
          });
          summaryLines.push(
            "",
            `Initial sync complete for ${syncResult.serverName}.`,
            `- mirroredChannels: ${syncResult.mirroredChannelCount}`,
            `- created: ${syncResult.createdCount}`,
            `- updated: ${syncResult.updatedCount}`,
            `- deleted: ${syncResult.deletedCount}`
          );
        } catch (error) {
          await saveDirectBridgeFailure(ctx, runtime, nextDirectBridge, error).catch(() => {});
          summaryLines.push("", `Initial sync failed: ${error?.message || "UNKNOWN_ERROR"}`);
        }
      }

      return commandResponse({
        content: summaryLines.join("\n"),
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-direct-bridge-sync",
    description: "Sync TeamSpeak channels into the server's teamspeak category now",
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "sync TeamSpeak mirrored channels");
      if (denied) return denied;

      try {
        const result = await syncDirectTeamSpeakBridge(ctx, runtime);
        return commandResponse({
          content: [
            `Mirrored ${result.mirroredChannelCount} TeamSpeak channels from '${result.serverName}'.`,
            `Category: ${result.categoryName}`,
            `Created: ${result.createdCount}`,
            `Updated: ${result.updatedCount}`,
            `Deleted: ${result.deletedCount}`
          ].join("\n"),
          sender: runtime.sender
        });
      } catch (error) {
        await saveDirectBridgeFailure(ctx, runtime, runtime.directBridge, error).catch(() => {});
        return commandResponse({
          content: `TeamSpeak mirror sync failed: ${error?.message || "UNKNOWN_ERROR"}`,
          sender: runtime.sender
        });
      }
    }
  }),
  command({
    name: "ts-compat-install-url",
    description: "Install a compatibility pack from URL (JSON or TeamSpeak package archive)",
    options: [
      optionString("url", "Pack URL (https, or http://localhost for dev)", true)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "install compatibility packs");
      if (denied) return denied;

      try {
        const imported = await fetchAndParsePackFromUrl(ctx.args?.url);
        await saveRemotePack(ctx, runtime, imported.pack);

        return commandResponse({
          content:
            `Installed pack '${imported.pack.id}' from ${imported.sourceUrl}` +
            `${imported.importedFromArchive ? " (archive import)." : "."}`,
          sender: runtime.sender
        });
      } catch (error) {
        return commandResponse({
          content: `Install failed: ${error?.message || "UNKNOWN_ERROR"}`,
          sender: runtime.sender
        });
      }
    }
  }),
  command({
    name: "ts-compat-import",
    description: "Import a TeamSpeak/OpenCom extension package from URL",
    options: [
      optionString("url", "Extension package URL", true)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "import compatibility packs");
      if (denied) return denied;

      try {
        const imported = await fetchAndParsePackFromUrl(ctx.args?.url);
        await saveRemotePack(ctx, runtime, imported.pack);
        return commandResponse({
          content:
            `Imported '${imported.pack.id}' from ${imported.sourceUrl}` +
            `${imported.importedFromArchive ? " (archive import)." : "."}`,
          sender: runtime.sender
        });
      } catch (error) {
        return commandResponse({
          content: `Import failed: ${error?.message || "UNKNOWN_ERROR"}`,
          sender: runtime.sender
        });
      }
    }
  }),
  command({
    name: "ts-compat-install-json",
    description: "Install a compatibility pack from raw JSON",
    options: [
      optionString("json", "Pack JSON object", true)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "install compatibility packs");
      if (denied) return denied;

      const raw = asString(ctx.args?.json, MAX_PACK_JSON_CHARS);
      if (!raw) {
        return commandResponse({ content: "JSON payload is required.", sender: runtime.sender });
      }

      try {
        const parsed = JSON.parse(raw);
        const normalized = normalizePack(parsed, { source: "inline", builtin: false });
        await saveRemotePack(ctx, runtime, normalized);

        return commandResponse({
          content: `Installed inline pack '${normalized.id}'.`,
          sender: runtime.sender
        });
      } catch (error) {
        return commandResponse({
          content: `Install failed: ${error?.message || "UNKNOWN_ERROR"}`,
          sender: runtime.sender
        });
      }
    }
  }),
  command({
    name: "ts-compat-remove",
    description: "Remove an installed remote compatibility pack",
    options: [
      optionString("pack", "Pack id", true)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const denied = await requireManager(ctx, runtime.sender, "remove compatibility packs");
      if (denied) return denied;

      let packId;
      try {
        packId = normalizeIdentifier(ctx.args?.pack, PACK_ID_PATTERN, "pack id");
      } catch (error) {
        return commandResponse({ content: error?.message || "Invalid pack id.", sender: runtime.sender });
      }
      if (BUILTIN_PACK_IDS.has(packId)) {
        return commandResponse({
          content: `Pack '${packId}' is built-in and cannot be removed.`,
          sender: runtime.sender
        });
      }

      const remote = (Array.isArray(runtime.config.remotePacks) ? runtime.config.remotePacks : [])
        .filter((item) => asString(item?.id, 120).toLowerCase() !== packId);
      if (remote.length === (Array.isArray(runtime.config.remotePacks) ? runtime.config.remotePacks.length : 0)) {
        return commandResponse({
          content: `Pack '${packId}' was not found in remote packs.`,
          sender: runtime.sender
        });
      }

      const nextEnabled = new Set(runtime.enabledPackIds);
      nextEnabled.delete(packId);

      await ctx.config.set({
        ...runtime.config,
        remotePacks: remote,
        enabledPackIds: Array.from(nextEnabled.values()).sort()
      });
      return commandResponse({
        content: `Removed pack '${packId}'.`,
        sender: runtime.sender
      });
    }
  }),
  command({
    name: "ts-compat-run",
    description: "Execute a TeamSpeak compatibility command from an installed pack",
    options: [
      optionString("pack", "Pack id", true),
      optionString("command", "Pack command name", true),
      optionString("args", "Optional args as key=value pairs or JSON", false)
    ],
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const allowMembers = Boolean(runtime.config.allowMemberExecution);
      if (!allowMembers) {
        const denied = await requireManager(ctx, runtime.sender, "run compatibility commands");
        if (denied) return denied;
      }

      let packId;
      try {
        packId = normalizeIdentifier(ctx.args?.pack, PACK_ID_PATTERN, "pack id");
      } catch (error) {
        return commandResponse({ content: error?.message || "Invalid pack id.", sender: runtime.sender });
      }

      const pack = runtime.packMap.get(packId);
      if (!pack) {
        return commandResponse({ content: `Pack '${packId}' was not found.`, sender: runtime.sender });
      }
      if (!runtime.enabledPackIds.has(packId)) {
        return commandResponse({ content: `Pack '${packId}' is installed but disabled.`, sender: runtime.sender });
      }

      const requestedCommand = asString(ctx.args?.command, 120).toLowerCase();
      const packCommand = resolvePackCommand(pack, requestedCommand);
      if (!packCommand) {
        const available = pack.commands.map((item) => item.name).join(", ");
        return commandResponse({
          content: `Unknown command '${requestedCommand}' for pack '${packId}'. Available: ${available}`,
          sender: runtime.sender
        });
      }

      let parsedArgs;
      try {
        parsedArgs = parseRunArgs(ctx.args?.args);
      } catch (error) {
        return commandResponse({
          content: `Invalid args: ${error?.message || "Could not parse args"}`,
          sender: runtime.sender
        });
      }

      return runCompatibilityCommand(ctx, runtime, pack, packCommand, parsedArgs);
    }
  }),
  command({
    name: "ts-compat-template",
    description: "Show a JSON template for creating compatibility packs",
    async execute(ctx) {
      const runtime = await getRuntime(ctx);
      const template = JSON.stringify(EXAMPLE_PACK_TEMPLATE, null, 2);
      return commandResponse({
        content: `Compatibility pack template:\n${template}`,
        sender: runtime.sender
      });
    }
  })
];

export async function activate(ctx) {
  const context = createServerContext(ctx);
  const runtime = await getRuntime(ctx);
  context.log(
    `Activated TeamSpeak compatibility layer for server ${ctx.serverId} ` +
    `(packs=${runtime.packMap.size}, enabled=${runtime.enabledPackIds.size}, directMirror=${runtime.directBridge.enabled ? "on" : "off"})`
  );
}

export async function deactivate(ctx) {
  const context = createServerContext(ctx);
  context.log(`Deactivated TeamSpeak compatibility layer for server ${ctx.serverId}`);
}
