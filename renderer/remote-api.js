/* JJK CC Mod Manager — remote-api shim (experiment/remote-host).
 *
 * Under Electron, preload.js already defines window.modManagerApi and this
 * file is a no-op. In a browser (served by `node server.js` on the game PC)
 * it implements the same surface over fetch + EventSource so renderer.js
 * works unmodified against a remote host.
 *
 * Config (stored in localStorage, overridable via URL query):
 *   ?host=http://game-pc:3131  — host base URL (default: same origin)
 *   ?token=secret               — auth token (default: localStorage jjkmm.token)
 * Console helpers: window.__jjkmmRemote.setHost(url), .setToken(t)
 */
"use strict";

(function () {
  if (typeof window === "undefined") return;
  if (window.modManagerApi) return; // Electron — preload owns the API.

  const params = new URLSearchParams(window.location.search || "");
  const storedHost = window.localStorage.getItem("jjkmm.host") || "";
  const storedToken = window.localStorage.getItem("jjkmm.token") || "";
  let HOST = params.get("host") || storedHost || window.location.origin;
  HOST = HOST.replace(/\/+$/, "");
  let TOKEN = params.get("token") || storedToken || "";
  if (params.get("host")) window.localStorage.setItem("jjkmm.host", HOST);
  if (params.get("token")) window.localStorage.setItem("jjkmm.token", TOKEN);

  const clientId = `web-${Math.random().toString(36).slice(2, 10)}`;
  const progressHandlers = new Set();

  function headers(extra) {
    const h = { "Content-Type": "application/json" };
    if (TOKEN) h["X-Remote-Token"] = TOKEN;
    h["X-Client-Id"] = clientId;
    return { ...h, ...(extra || {}) };
  }

  async function call(method, args) {
    const url = `${HOST}/api/${method}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ args: args || [], clientId }),
      });
    } catch (e) {
      throw new Error(`Cannot reach remote host at ${HOST} (${e.message}). Is server.js running?`);
    }
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Bad response from remote host (${res.status}).`);
    }
    if (!res.ok || body.ok === false) {
      const msg = (body && body.error) || `Request failed (${res.status})`;
      if (res.status === 401) {
        throw new Error("Unauthorized — set the remote token (see connection banner).");
      }
      throw new Error(msg);
    }
    return body.result;
  }

  // Live progress for package-all-mods via SSE.
  function connectEvents() {
    try {
      const qs = `clientId=${encodeURIComponent(clientId)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ""}`;
      const es = new EventSource(`${HOST}/events?${qs}`);
      es.onmessage = (ev) => {
        let payload = null;
        try {
          payload = JSON.parse(ev.data);
        } catch {
          return;
        }
        progressHandlers.forEach((cb) => {
          try {
            cb(payload);
          } catch (e) {
            console.error(e);
          }
        });
      };
      es.onerror = () => {
        /* EventSource auto-retries; the banner covers prolonged outages */
      };
    } catch {
      /* progress stays silent — packaging result still returns */
    }
  }

  function askHostPath(title, current) {
    const hint = current ? ` (current: ${current})` : "";
    const v = window.prompt(`${title}${hint}\nEnter a folder path ON THE HOST PC:`, current || "");
    if (v === null) return null;
    const t = v.trim();
    return t ? t : null;
  }

  function pickLocalFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".jjkmod,.zip";
      input.onchange = () => resolve(input.files && input.files[0]);
      input.oncancel = () => resolve(null);
      input.click();
      // Fallback for browsers without oncancel:
      setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          try {
            input.remove();
          } catch { /* noop */ }
        }
      }, 60000);
      // Resolve-with-null when the dialog is dismissed is best-effort;
      // most flows treat undefined selection as cancel on next tick.
      window.addEventListener(
        "focus",
        function onFocus() {
          window.removeEventListener("focus", onFocus);
          setTimeout(() => {
            if (!input.files || input.files.length === 0) resolve(null);
          }, 300);
        },
        { once: true },
      );
    });
  }

  async function uploadFile(file) {
    const url = `${HOST}/upload?filename=${encodeURIComponent(file.name)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ""}`;
    const res = await fetch(url, {
      method: "POST",
      headers: TOKEN ? { "X-Remote-Token": TOKEN } : {},
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error((body && body.error) || `Upload failed (${res.status})`);
    }
    return body.path;
  }

  function triggerDownload(downloadUrl, fallbackName) {
    const a = document.createElement("a");
    a.href = `${HOST}${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`;
    a.download = fallbackName || "mod.jjkmod";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Connection banner so a wrong host/token is obvious, not a blank screen.
  function showBannerIfOffline() {
    fetch(`${HOST}/health`)
      .then((r) => r.json())
      .then((h) => {
        if (h && h.ok) return;
        throw new Error("unhealthy");
      })
      .catch(() => {
        const bar = document.createElement("div");
        bar.id = "remoteBanner";
        bar.style.cssText =
          "position:fixed;top:0;left:0;right:0;z-index:9999;background:#7c2d12;color:#fff;" +
          "font:13px system-ui;padding:8px 12px;display:flex;gap:8px;align-items:center;justify-content:center";
        bar.innerHTML =
          `<span>Cannot reach remote host at ${HOST}. ` +
          `Start it with <code>npm run remote-host</code> on the game PC, then ` +
          `<button id="remoteCfgBtn" style="margin-left:8px">Set host/token</button></span>`;
        document.body.prepend(bar);
        document.getElementById("remoteCfgBtn").onclick = configure;
      });
  }

  function configure() {
    const h = window.prompt("Remote host URL (game PC):", HOST);
    if (h && h.trim()) {
      HOST = h.trim().replace(/\/+$/, "");
      window.localStorage.setItem("jjkmm.host", HOST);
    }
    const t = window.prompt("Auth token (empty if none):", TOKEN);
    if (t !== null) {
      TOKEN = t.trim();
      window.localStorage.setItem("jjkmm.token", TOKEN);
    }
    window.location.reload();
  }

  window.__jjkmmRemote = {
    get host() {
      return HOST;
    },
    get token() {
      return TOKEN ? "(set)" : "";
    },
    setHost: (u) => {
      window.localStorage.setItem("jjkmm.host", u);
      window.location.reload();
    },
    setToken: (t) => {
      window.localStorage.setItem("jjkmm.token", t);
      window.location.reload();
    },
    configure,
  };

  window.modManagerApi = {
    initApp: () => call("init-app"),
    changeGameLocation: async () => {
      const p = askHostPath("Game executable path on the HOST PC");
      if (!p) return { cancelled: true };
      return call("change-game-location", [p]);
    },
    setModEnabled: (modId, enabled) => call("set-mod-enabled", [modId, enabled]),
    refreshMods: () => call("refresh-mods"),
    enableAllMods: () => call("enable-all-mods"),
    disableAllMods: () => call("disable-all-mods"),
    setModsFolderOverride: async () => {
      const p = askHostPath("Mods folder override (path on HOST PC)");
      if (!p) return { cancelled: true };
      return call("set-mods-folder-override", [p]);
    },
    clearModsFolderOverride: () => call("clear-mods-folder-override"),
    setUnpackedAssetsPath: async () => {
      const p = askHostPath("Unpacked assets folder (path on HOST PC)");
      if (!p) return { cancelled: true };
      return call("set-unpacked-assets-path", [p]);
    },
    clearUnpackedAssetsPath: () => call("clear-unpacked-assets-path"),
    packageAllMods: (modsFolder) => call("package-all-mods", [modsFolder]),

    // Browser: pick a LOCAL file, upload it to the host, install from there.
    installModFromZip: async () => {
      const file = await pickLocalFile();
      if (!file) return { cancelled: true };
      const remotePath = await uploadFile(file);
      return call("install-mod-from-file", [remotePath]);
    },
    installModFromFile: async (filePath) => {
      // Host-local path passthrough (used by open-mod-file flows on the host).
      return call("install-mod-from-file", [filePath]);
    },
    previewModFile: (filePath) => call("preview-mod-file", [filePath]),
    notifyRendererReady: async () => [],
    onOpenModFile: () => () => {},
    onPackageProgress: (cb) => {
      progressHandlers.add(cb);
      return () => progressHandlers.delete(cb);
    },

    openModsFolder: async () => {
      console.info("[remote] mods folder lives on the host — no local folder to open.");
      return { ok: true };
    },
    openExternalUrl: async (url) => {
      window.open(url, "_blank", "noopener");
      return { ok: true };
    },
    openModFolder: async () => {
      console.info("[remote] mod folders live on the host — no local folder to open.");
      return { ok: true };
    },
    pickSaveJjkmodPath: (modFolderPath) => call("pick-save-jjkmod-path", [modFolderPath]),
    packageSingleMod: async (modFolderPath, outPath) => {
      const result = await call("package-single-mod", [modFolderPath, outPath]);
      // Pull the packaged file down to the client automatically.
      if (result && result.downloadUrl) {
        const name = (result.jjkmodPath || "mod.jjkmod").split(/[/\\]/).pop();
        triggerDownload(result.downloadUrl, name);
      }
      return result;
    },
    createModManifest: (modFolderPath) => call("create-mod-manifest", [modFolderPath]),
    validateModJson: (modFolderPath) => call("validate-mod-json", [modFolderPath]),
    setVerboseOutput: (v) => call("set-verbose-output", [v]),
    // Play runs on the HOST (where the game is installed).
    launchGame: () => call("launch-game"),
    checkRequirements: () => call("check-requirements"),
    installRequirement: (reqId) => call("install-requirement", [reqId]),
    getSetupStatus: () => call("get-setup-status"),
    deleteLegacySetup: (ids) => call("delete-legacy-setup", [ids]),
    completeSetupWizard: () => call("complete-setup-wizard"),
    checkAppUpdate: () => call("check-app-update"),
  };

  connectEvents();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showBannerIfOffline);
  } else {
    showBannerIfOffline();
  }
})();
