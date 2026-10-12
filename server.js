/**
 * server.js — headless remote host for JJK CC Mod Manager (experiment/remote-host).
 *
 * Runs the SAME lib/* backend without Electron and exposes it over HTTP so a
 * browser on another PC can drive the machine that actually has the game:
 *
 *   npm run remote-host -- --port 3131 --token <secret>
 *   # or: node server.js --port 3131 --token <secret>
 *
 * Client opens http://<host>:3131/ in a browser. The served renderer uses
 * renderer/remote-api.js (fetch + EventSource) instead of Electron IPC.
 *
 * Zero dependencies — only Node built-ins. Auth is a shared-secret bearer
 * token; serve on LAN / Tailscale only, never the open internet (this API
 * can read/write files and spawn packaging tools on the host).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const { APP_DIR, GAME_EXE_NAME } = require("./lib/constants");
const { readConfig, writeConfig } = require("./lib/config");
const { getAppVersion } = require("./lib/platform");
const { existsAsync } = require("./lib/asyncUtils");
const {
  resolveModsFolder,
  listModDirectoryNames,
  syncEnabledModsWithConfig,
  loadModsStateFromConfig,
} = require("./lib/modUtils");
const { packageAllMods } = require("./lib/packageAllMods");
const { packageSingleMod, suggestedJjkmodPath } = require("./lib/packageSingleMod");
const { createModManifest } = require("./lib/createModManifest");
const { validateModJson } = require("./lib/validateModJson");
const {
  installModFromZip,
  peekModInfo,
  compareVersions,
  readVersionFromModFolder,
} = require("./lib/installModFromZip");
const {
  checkRequirement,
  checkAllRequirements,
  loadRequirementDefs,
  installRequirement,
} = require("./lib/requirements");
const { describeLegacySetup, deleteLegacySetupItems } = require("./lib/setupWizard");
const { checkForAppUpdate } = require("./lib/updateCheck");

const RENDERER_DIR = path.join(__dirname, "renderer");
const UPLOAD_DIR = path.join(os.tmpdir(), "jjkmm-uploads");

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { port: 3131, token: process.env.REMOTE_TOKEN || "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a === "--token" && argv[i + 1]) out.token = argv[++i];
    else if (a.startsWith("--token=")) out.token = a.slice(8);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node server.js [--port 3131] [--token <secret>]");
      process.exit(0);
    }
  }
  return out;
}

const { port: PORT, token: AUTH_TOKEN } = parseArgs(process.argv);

// ── SSE progress hub ─────────────────────────────────────────────────────────
// Client opens GET /events?clientId=xxx (EventSource) then includes the same
// clientId in POST /api/package-all-mods so live logs route to its stream.
// (package-all-mods is the only long-running call; everything else is fast.)

const sseClients = new Map(); // clientId -> Set<http.ServerResponse>

function sseSend(clientId, payload) {
  if (!clientId) {
    // No routing key — broadcast (single-user LAN case).
    for (const set of sseClients.values()) {
      for (const res of set) {
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* dead client */ }
      }
    }
    return;
  }
  const set = sseClients.get(clientId);
  if (!set) return;
  for (const res of set) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch { /* dead client */ }
  }
}

function makeReporter(clientId, verbose) {
  return (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "log" && !verbose) {
      const stream = payload.stream;
      if (stream === "stdout" || stream === "stderr" || stream === "cmd") return;
    }
    sseSend(clientId, payload);
  };
}

// ── Service layer (mirrors lib/ipcHandlers.js glue, dialog-free) ────────────

async function installModFileIntoLibrary(zipPath) {
  if (!zipPath || typeof zipPath !== "string") throw new Error("No mod file provided.");
  if (!/\.(jjkmod|zip)$/i.test(zipPath)) {
    throw new Error(`Unsupported mod file type (expected .jjkmod or .zip):\n${zipPath}`);
  }
  let stat = null;
  try {
    stat = await fsp.stat(zipPath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) throw new Error(`Mod file not found:\n${zipPath}`);
  const config = await readConfig();
  const gameExePath = config.gameExePath || config.gameLocation || null;
  if (!gameExePath) throw new Error("No game executable configured.");
  const modsFolder = await resolveModsFolder(gameExePath, config.modsFolderOverride || null);
  if (!modsFolder) throw new Error("Mods folder not available.");
  const result = await installModFromZip(zipPath, modsFolder);
  const latest = await readConfig();
  const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
  return { cancelled: false, ...result, ...state };
}

function validateGameExePath(p) {
  if (!p || typeof p !== "string") throw new Error("No game executable path provided.");
  if (path.basename(p) !== GAME_EXE_NAME) {
    throw new Error(`Please select "${GAME_EXE_NAME}".`);
  }
  return p;
}

/** Method table: name -> async (args, ctx) => result. ctx = { clientId }. */
const methods = {
  "init-app": async () => {
    const config = await readConfig();
    const latest = await readConfig();
    const gameLocation = config.gameExePath || config.gameLocation || null;
    if (!gameLocation) {
      return {
        gameLocation: null,
        modsFolder: null,
        modsFolderOverride: config.modsFolderOverride || null,
        unpackedAssetsPath: config.unpackedAssetsPath || null,
        mods: [],
        error: "No game executable configured.",
        setupWizardCompleted: Boolean(config.setupWizardCompleted),
      };
    }
    const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
    return {
      ...state,
      verboseOutput: Boolean(latest.verboseOutput),
      setupWizardCompleted: Boolean(latest.setupWizardCompleted),
    };
  },

  // Remote: pass an explicit host-local exe path, or null to just read state.
  "change-game-location": async ([nextPath]) => {
    const config = await readConfig();
    if (!nextPath) {
      const latest = await readConfig();
      const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
      return {
        cancelled: true,
        ...state,
        verboseOutput: Boolean(latest.verboseOutput),
        setupWizardCompleted: Boolean(latest.setupWizardCompleted),
      };
    }
    validateGameExePath(nextPath);
    if (!(await existsAsync(nextPath))) throw new Error(`File not found:\n${nextPath}`);
    config.gameExePath = nextPath;
    config.gameExeStartDir = path.dirname(nextPath);
    delete config.gameLocation;
    await writeConfig(config);
    const latest = await readConfig();
    const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
    return {
      cancelled: false,
      ...state,
      verboseOutput: Boolean(latest.verboseOutput),
      setupWizardCompleted: Boolean(latest.setupWizardCompleted),
    };
  },

  "set-mod-enabled": async ([modId, enabled]) => {
    const config = await readConfig();
    const set = new Set(Array.isArray(config.enabledMods) ? config.enabledMods : []);
    delete config.disabledMods;
    if (enabled) set.add(modId);
    else set.delete(modId);
    config.enabledMods = Array.from(set).sort((a, b) => a.localeCompare(b));
    await writeConfig(config);
    try {
      const state = await loadModsStateFromConfig(await readConfig());
      return { ok: true, conflicts: state.conflicts };
    } catch {
      return { ok: true, conflicts: null };
    }
  },

  "refresh-mods": async () => loadModsStateFromConfig(await readConfig(), { rescanConflicts: true }),

  "enable-all-mods": async () => {
    const config = await readConfig();
    const gameLocation = config.gameExePath || config.gameLocation || null;
    if (!gameLocation) throw new Error("No game executable configured.");
    const modsFolder = await resolveModsFolder(gameLocation, config.modsFolderOverride || null);
    if (!modsFolder) throw new Error("Mods folder not available.");
    const modIds = await listModDirectoryNames(modsFolder);
    delete config.disabledMods;
    config.enabledMods = modIds.sort((a, b) => a.localeCompare(b));
    await writeConfig(config);
    return loadModsStateFromConfig(await readConfig());
  },

  "disable-all-mods": async () => {
    const config = await readConfig();
    delete config.disabledMods;
    config.enabledMods = [];
    await writeConfig(config);
    return loadModsStateFromConfig(await readConfig());
  },

  // Remote: explicit host-local folder path (no dialog).
  "set-mods-folder-override": async ([nextPath]) => {
    if (!nextPath) return { cancelled: true };
    const config = await readConfig();
    config.modsFolderOverride = nextPath;
    await writeConfig(config);
    const latest = await readConfig();
    return { cancelled: false, ...(await loadModsStateFromConfig(latest, { rescanConflicts: true })) };
  },

  "clear-mods-folder-override": async () => {
    const config = await readConfig();
    delete config.modsFolderOverride;
    await writeConfig(config);
    return loadModsStateFromConfig(await readConfig(), { rescanConflicts: true });
  },

  "set-unpacked-assets-path": async ([nextPath]) => {
    if (!nextPath) return { cancelled: true };
    const config = await readConfig();
    config.unpackedAssetsPath = nextPath;
    await writeConfig(config);
    return { cancelled: false, ...(await loadModsStateFromConfig(await readConfig())) };
  },

  "clear-unpacked-assets-path": async () => {
    const config = await readConfig();
    delete config.unpackedAssetsPath;
    await writeConfig(config);
    return loadModsStateFromConfig(await readConfig());
  },

  "set-verbose-output": async ([verbose]) => {
    const config = await readConfig();
    config.verboseOutput = Boolean(verbose);
    await writeConfig(config);
    return { ok: true, verboseOutput: config.verboseOutput };
  },

  // Host has no window to open — acknowledge; the browser client opens URLs itself.
  "open-external-url": async () => ({ ok: true, openedRemotely: false }),
  "open-mods-folder": async () => ({ ok: true, openedRemotely: false }),
  "open-mod-folder": async () => ({ ok: true, openedRemotely: false }),

  // Returns the suggested host-local save path (client then calls package-single-mod).
  "pick-save-jjkmod-path": async ([modFolderPath]) => {
    if (!modFolderPath || typeof modFolderPath !== "string") {
      throw new Error("No mod folder path provided.");
    }
    let preferredDir = null;
    try {
      const config = await readConfig();
      const saved = config.jjkmodExportDir;
      if (typeof saved === "string" && saved.trim() && (await existsAsync(saved.trim()))) {
        const stat = await fsp.stat(saved.trim());
        if (stat.isDirectory()) preferredDir = saved.trim();
      }
    } catch {
      preferredDir = null;
    }
    const filePath = await suggestedJjkmodPath(modFolderPath, preferredDir);
    return { cancelled: false, filePath };
  },

  "package-single-mod": async ([modFolderPath, outPath]) => {
    if (!modFolderPath || typeof modFolderPath !== "string") {
      throw new Error("No mod folder path provided.");
    }
    const result = await packageSingleMod(modFolderPath, outPath);
    try {
      const produced = result && result.jjkmodPath;
      if (typeof produced === "string" && produced.trim()) {
        const config = await readConfig();
        config.jjkmodExportDir = path.dirname(produced);
        await writeConfig(config);
      }
    } catch { /* best-effort */ }
    // Include a download URL so the browser client can fetch the file.
    return { ...result, downloadUrl: `/download?path=${encodeURIComponent(result.jjkmodPath)}` };
  },

  "validate-mod-json": async ([modFolderPath]) => {
    if (!modFolderPath || typeof modFolderPath !== "string") {
      throw new Error("No mod folder path provided.");
    }
    return validateModJson(modFolderPath);
  },

  "create-mod-manifest": async ([modFolderPath]) => {
    if (!modFolderPath || typeof modFolderPath !== "string") {
      throw new Error("No mod folder path provided.");
    }
    return createModManifest(modFolderPath);
  },

  // Dialog-based install has no remote equivalent — upload first, then call this.
  "install-mod-from-zip": async () => {
    throw new Error("Use file upload + install-mod-from-file on a remote host.");
  },
  "install-mod-from-file": async ([filePath]) => installModFileIntoLibrary(filePath),

  "preview-mod-file": async ([filePath]) => {
    if (!filePath || typeof filePath !== "string") throw new Error("No mod file provided.");
    const info = await peekModInfo(filePath);
    let exists = false;
    let existingVersion = null;
    let status = "new";
    try {
      const config = await readConfig();
      const gameExePath = config.gameExePath || config.gameLocation || null;
      const modsFolder = await resolveModsFolder(gameExePath, config.modsFolderOverride || null);
      if (modsFolder) {
        const modPath = path.join(modsFolder, info.modFolderName);
        if (await existsAsync(modPath)) {
          exists = true;
          existingVersion = await readVersionFromModFolder(modPath);
          const cmp = compareVersions(info.version, existingVersion);
          status = cmp === 0 ? "same" : cmp > 0 ? "update" : "older";
        }
      }
    } catch { /* advisory */ }
    return { ...info, exists, existingVersion, status };
  },

  "launch-game": async () => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) throw new Error("No game executable configured.");
    const { spawn } = require("child_process");
    const child = spawn(gameExePath, [], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(gameExePath),
    });
    child.unref();
    return { ok: true };
  },

  "package-all-mods": async ([modsFolder], ctx) => {
    if (!modsFolder) throw new Error("No mods folder available.");
    const config = await readConfig();
    const enabledMods = await syncEnabledModsWithConfig(config, modsFolder);
    const gameExePath = config.gameExePath || config.gameLocation || null;
    const reporter = makeReporter(ctx.clientId, Boolean(config.verboseOutput));
    reporter({ type: "progress", step: "Starting packaging", progress: 2 });
    try {
      const result = await packageAllMods(modsFolder, enabledMods, reporter, gameExePath);
      reporter({ type: "done", message: "Packaging finished" });
      return result;
    } catch (error) {
      reporter({ type: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  "check-requirements": async () => {
    const config = await readConfig();
    return checkAllRequirements(config.gameExePath || config.gameLocation || null);
  },

  "install-requirement": async ([reqId]) => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) throw new Error("No game executable configured.");
    const req = loadRequirementDefs().find((r) => r.id === reqId);
    if (!req) throw new Error(`Unknown requirement id: ${reqId}`);
    await installRequirement(req, gameExePath, APP_DIR);
    return checkAllRequirements(gameExePath);
  },

  "get-setup-status": async () => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    const cleanup = await describeLegacySetup(gameExePath);
    let sigpatch = { installed: null, statusDetail: null };
    try {
      const def = loadRequirementDefs().find((r) => r.id === "signature-bypass");
      if (def) {
        const checked = await checkRequirement(def, gameExePath);
        sigpatch = { installed: checked.installed, statusDetail: checked.statusDetail };
      }
    } catch { /* advisory */ }
    return { gameExePath, exeDir: cleanup.exeDir, cleanup, sigpatch };
  },

  "delete-legacy-setup": async ([targetIds]) => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) throw new Error("No game executable configured.");
    const result = await deleteLegacySetupItems(gameExePath, targetIds);
    return { ...result, cleanup: await describeLegacySetup(gameExePath) };
  },

  "complete-setup-wizard": async () => {
    const config = await readConfig();
    config.setupWizardCompleted = true;
    await writeConfig(config);
    return { ok: true };
  },

  "check-app-update": async () => {
    try {
      return await checkForAppUpdate(getAppVersion());
    } catch {
      return {
        ok: false,
        hasRelease: false,
        upToDate: true,
        currentVersion: getAppVersion(),
        latestVersion: null,
        latestUrl: "https://github.com/JJKCursedClashModding/Mod-Manager/releases",
      };
    }
  },

  // ── Remote file browser ──────────────────────────────────────────────
  // Lets a browser client walk the HOST filesystem to pick paths (game exe,
  // mods override, unpacked assets) instead of typing them blind.

  "browse-drives": async () => {
    if (process.platform === "win32") {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const root = `${String.fromCharCode(c)}:\\`;
        try {
          const st = await fsp.stat(root);
          if (st.isDirectory()) drives.push({ path: root, label: root });
        } catch { /* drive absent */ }
      }
      return { drives, home: os.homedir(), sep: path.sep };
    }
    return { drives: [{ path: "/", label: "/ (root)" }], home: os.homedir(), sep: path.sep };
  },

  "browse-list": async ([dir]) => {
    if (!dir || typeof dir !== "string") throw new Error("No directory provided.");
    const resolved = path.resolve(dir);
    let stat = null;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      stat = null;
    }
    if (!stat) throw new Error(`Folder not found:\n${dir}`);
    if (!stat.isDirectory()) throw new Error(`Not a folder:\n${dir}`);
    let names;
    try {
      names = await fsp.readdir(resolved);
    } catch (e) {
      throw new Error(`Cannot read folder (permission?):\n${resolved}`);
    }
    const entries = [];
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const abs = path.join(resolved, name);
      let st = null;
      try {
        st = await fsp.stat(abs);
      } catch { continue; } // vanishing / forbidden entries are skipped
      const isDir = st.isDirectory();
      if (!isDir && !st.isFile()) continue;
      entries.push({
        name,
        path: abs,
        isDir,
        size: isDir ? 0 : st.size,
        mtimeMs: st.mtimeMs,
      });
      if (entries.length >= 5000) break;
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    const parent = path.dirname(resolved);
    return { dir: resolved, parent: parent === resolved ? null : parent, entries };
  },

  "renderer-ready": async () => [],
};

// ── HTTP plumbing (zero-dep) ─────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".woff2": "font/woff2",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Remote-Token, X-Client-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function isAuthorized(req, url) {
  if (!AUTH_TOKEN) return true; // open LAN mode (warned at startup)
  const h = req.headers || {};
  const bearer = typeof h.authorization === "string" && h.authorization.startsWith("Bearer ")
    ? h.authorization.slice(7)
    : "";
  const custom = h["x-remote-token"];
  const query = url.searchParams.get("token");
  return bearer === AUTH_TOKEN || custom === AUTH_TOKEN || query === AUTH_TOKEN;
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const abs = path.normalize(path.join(RENDERER_DIR, rel));
  if (!abs.startsWith(RENDERER_DIR + path.sep) && abs !== RENDERER_DIR) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const DOWNLOAD_ALLOW = new Set([".jjkmod", ".zip", ".log", ".json"]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Remote-Token, X-Client-Id",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    if (pathname === "/health") {
      return sendJson(res, 200, { ok: true, version: getAppVersion(), remote: true });
    }

    // Live progress stream for package-all-mods.
    if (pathname === "/events" && req.method === "GET") {
      if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      const clientId = url.searchParams.get("clientId") || "default";
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`: connected as ${clientId}\n\n`);
      if (!sseClients.has(clientId)) sseClients.set(clientId, new Set());
      sseClients.get(clientId).add(res);
      req.on("close", () => {
        const set = sseClients.get(clientId);
        if (set) {
          set.delete(res);
          if (set.size === 0) sseClients.delete(clientId);
        }
      });
      return;
    }

    // Raw-binary mod upload: POST /upload?filename=mod.jjkmod
    if (pathname === "/upload" && req.method === "POST") {
      if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      const filename = path.basename(url.searchParams.get("filename") || "upload.jjkmod");
      if (!/\.(jjkmod|zip)$/i.test(filename)) {
        return sendJson(res, 400, { ok: false, error: "Only .jjkmod or .zip uploads are accepted." });
      }
      await fsp.mkdir(UPLOAD_DIR, { recursive: true });
      const dest = path.join(UPLOAD_DIR, `${Date.now()}-${filename}`);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        req.on("error", reject);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
      return sendJson(res, 200, { ok: true, path: dest, filename });
    }

    // Download packaged outputs: GET /download?path=<host-absolute>
    if (pathname === "/download" && req.method === "GET") {
      if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      const p = url.searchParams.get("path");
      if (!p) return sendJson(res, 400, { ok: false, error: "Missing path." });
      if (!DOWNLOAD_ALLOW.has(path.extname(p).toLowerCase())) {
        return sendJson(res, 400, { ok: false, error: "File type not downloadable." });
      }
      try {
        const stat = await fsp.stat(p);
        if (!stat.isFile()) throw new Error("not a file");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="${path.basename(p)}"`,
          "Access-Control-Allow-Origin": "*",
        });
        fs.createReadStream(p).pipe(res);
      } catch {
        return sendJson(res, 404, { ok: false, error: "File not found." });
      }
      return;
    }

    // JSON-RPC-ish dispatch: POST /api/<method> { args: [...], clientId }
    if (pathname.startsWith("/api/") && req.method === "POST") {
      if (!isAuthorized(req, url)) return sendJson(res, 401, { ok: false, error: "Unauthorized." });
      const name = pathname.slice("/api/".length);
      const fn = methods[name];
      if (!fn) return sendJson(res, 404, { ok: false, error: `Unknown method: ${name}` });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }
      const args = Array.isArray(body.args) ? body.args : [];
      const clientId =
        body.clientId || req.headers["x-client-id"] || url.searchParams.get("clientId") || "default";
      try {
        const result = await fn(args, { clientId });
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Everything else: the renderer UI.
    if (req.method === "GET") return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end("Method not allowed");
  } catch (e) {
    try {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    } catch { /* socket gone */ }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`JJK Mod Manager remote host on http://0.0.0.0:${PORT}/`);
  console.log(`Serving renderer from: ${RENDERER_DIR}`);
  console.log(`User data dir:          ${require("./lib/config").getConfigPath()}`);
  if (AUTH_TOKEN) console.log("Auth: token required (Authorization: Bearer / ?token=).");
  else console.log("Auth: NONE — anyone on the network can control this host. Set --token.");
});
