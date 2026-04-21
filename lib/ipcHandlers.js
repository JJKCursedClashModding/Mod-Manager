const { ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const { existsSync } = require("fs");
const { APP_DIR, DEFAULT_GAME_EXE_START_DIR, ASSET_MAPPINGS_USMAP } = require("./constants");
const { readConfig, writeConfig } = require("./config");
const {
  pickGameLocation,
  pickFolder,
  ensureDirectory,
  resolveModsFolder,
  listModDirectoryNames,
  syncEnabledModsWithConfig,
  loadModsStateFromConfig,
} = require("./modUtils");
const { runCommand } = require("./tools");
const { packageAllMods } = require("./packageAllMods");
const { packageSingleMod } = require("./packageSingleMod");
const {
  checkAllRequirements,
  loadRequirementDefs,
  installRequirementFromZip,
} = require("./requirements");

/**
 * Creates a reporter function for a given IPC event sender.
 * When `verbose` is false, log entries from external command streams
 * (stdout, stderr, cmd) are suppressed so the console only shows
 * the high-level info messages emitted by the pipeline itself.
 *
 * @param {Electron.WebContents} sender
 * @param {boolean} verbose
 */
function makeReporter(sender, verbose) {
  return (payload) => {
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "log") {
      const stream = payload.stream;
      if (!verbose && (stream === "stdout" || stream === "stderr" || stream === "cmd")) {
        return; // suppress raw command output when not in verbose mode
      }
    }
    sender.send("package-progress", payload);
  };
}

function registerIpcHandlers() {
  ipcMain.handle("init-app", async () => {
    const config = await readConfig();
    let gameLocation = config.gameExePath || config.gameLocation || null;
    const gameExeStartDir =
      config.gameExeStartDir || (gameLocation ? path.dirname(gameLocation) : DEFAULT_GAME_EXE_START_DIR);

    if (!gameLocation) {
      try {
        gameLocation = await pickGameLocation(gameExeStartDir);
      } catch (error) {
        return {
          gameLocation: null,
          modsFolder: null,
          mods: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!gameLocation) {
        return {
          gameLocation: null,
          modsFolder: null,
          mods: [],
          error: "No game executable selected.",
        };
      }

      config.gameExePath = gameLocation;
      config.gameExeStartDir = path.dirname(gameLocation);
      delete config.gameLocation;
      await writeConfig(config);
    }

    const latest = await readConfig();
    const state = await loadModsStateFromConfig(latest);
    return { ...state, verboseOutput: Boolean(latest.verboseOutput) };
  });

  ipcMain.handle("change-game-location", async () => {
    let nextPath;
    const config = await readConfig();
    const gameExeStartDir =
      config.gameExeStartDir ||
      (config.gameExePath ? path.dirname(config.gameExePath) : DEFAULT_GAME_EXE_START_DIR);
    try {
      nextPath = await pickGameLocation(gameExeStartDir);
    } catch (error) {
      return {
        cancelled: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!nextPath) {
      return { cancelled: true };
    }

    config.gameExePath = nextPath;
    config.gameExeStartDir = path.dirname(nextPath);
    delete config.gameLocation;
    await writeConfig(config);

    const latest = await readConfig();
    const state = await loadModsStateFromConfig(latest);
    return { cancelled: false, ...state, verboseOutput: Boolean(latest.verboseOutput) };
  });

  ipcMain.handle("set-mod-enabled", async (_, modId, enabled) => {
    const config = await readConfig();
    const set = new Set(Array.isArray(config.enabledMods) ? config.enabledMods : []);
    delete config.disabledMods;
    if (enabled) {
      set.add(modId);
    } else {
      set.delete(modId);
    }
    config.enabledMods = Array.from(set).sort((a, b) => a.localeCompare(b));
    await writeConfig(config);
    return { ok: true };
  });

  ipcMain.handle("refresh-mods", async () => {
    const config = await readConfig();
    return await loadModsStateFromConfig(config);
  });

  ipcMain.handle("enable-all-mods", async () => {
    const config = await readConfig();
    const gameLocation = config.gameExePath || config.gameLocation || null;
    if (!gameLocation) {
      throw new Error("No game executable configured.");
    }
    const modsFolder = await resolveModsFolder(gameLocation, config.modsFolderOverride || null);
    if (!modsFolder) {
      throw new Error("Mods folder not available.");
    }
    const modIds = await listModDirectoryNames(modsFolder);
    delete config.disabledMods;
    config.enabledMods = modIds.sort((a, b) => a.localeCompare(b));
    await writeConfig(config);
    return await loadModsStateFromConfig(await readConfig());
  });

  ipcMain.handle("disable-all-mods", async () => {
    const config = await readConfig();
    delete config.disabledMods;
    config.enabledMods = [];
    await writeConfig(config);
    return await loadModsStateFromConfig(await readConfig());
  });

  ipcMain.handle("set-mods-folder-override", async () => {
    const nextPath = await pickFolder("Select mods folder override");
    if (!nextPath) {
      return { cancelled: true };
    }

    const config = await readConfig();
    config.modsFolderOverride = nextPath;
    await writeConfig(config);

    const latest = await readConfig();
    return { cancelled: false, ...(await loadModsStateFromConfig(latest)) };
  });

  ipcMain.handle("clear-mods-folder-override", async () => {
    const config = await readConfig();
    delete config.modsFolderOverride;
    await writeConfig(config);

    const latest = await readConfig();
    return await loadModsStateFromConfig(latest);
  });

  ipcMain.handle("set-unpacked-assets-path", async () => {
    const nextPath = await pickFolder("Select unpacked assets folder");
    if (!nextPath) {
      return { cancelled: true };
    }

    const config = await readConfig();
    config.unpackedAssetsPath = nextPath;
    await writeConfig(config);

    const latest = await readConfig();
    return { cancelled: false, ...(await loadModsStateFromConfig(latest)) };
  });

  ipcMain.handle("clear-unpacked-assets-path", async () => {
    const config = await readConfig();
    delete config.unpackedAssetsPath;
    await writeConfig(config);

    const latest = await readConfig();
    return await loadModsStateFromConfig(latest);
  });

  ipcMain.handle("set-verbose-output", async (_, verbose) => {
    const config = await readConfig();
    config.verboseOutput = Boolean(verbose);
    await writeConfig(config);
    return { ok: true, verboseOutput: config.verboseOutput };
  });

  ipcMain.handle("open-external-url", async (_, url) => {
    if (!url || typeof url !== "string") {
      throw new Error("Invalid URL.");
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("open-mods-folder", async (_, modsFolder) => {
    if (!modsFolder || typeof modsFolder !== "string") {
      throw new Error("No mods folder to open.");
    }
    const err = await shell.openPath(modsFolder);
    if (err) {
      throw new Error(err);
    }
    return { ok: true };
  });

  ipcMain.handle("open-mod-folder", async (_, modFolderPath) => {
    if (!modFolderPath || typeof modFolderPath !== "string") {
      throw new Error("No mod folder path provided.");
    }
    const err = await shell.openPath(modFolderPath);
    if (err) {
      throw new Error(err);
    }
    return { ok: true };
  });

  ipcMain.handle("package-single-mod", async (_, modFolderPath) => {
    if (!modFolderPath || typeof modFolderPath !== "string") {
      throw new Error("No mod folder path provided.");
    }
    const result = await packageSingleMod(modFolderPath);
    return result;
  });

  ipcMain.handle("launch-game", async () => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) {
      throw new Error("No game executable configured. Please set the game location in Settings.");
    }
    const child = spawn(gameExePath, [], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(gameExePath),
    });
    child.unref();
    return { ok: true };
  });

  ipcMain.handle("package-all-mods", async (event, modsFolder) => {
    if (!modsFolder) {
      throw new Error("No mods folder available.");
    }

    const config = await readConfig();
    const enabledMods = await syncEnabledModsWithConfig(config, modsFolder);
    const gameExePath = config.gameExePath || config.gameLocation || null;
    const reporter = makeReporter(event.sender, Boolean(config.verboseOutput));
    reporter({ type: "progress", step: "Starting packaging", progress: 2 });
    try {
      const result = await packageAllMods(modsFolder, enabledMods, reporter, gameExePath);
      reporter({ type: "done", message: "Packaging finished" });
      return result;
    } catch (error) {
      reporter({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  // ── Requirements ────────────────────────────────────────────────────────────

  ipcMain.handle("check-requirements", async () => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    return checkAllRequirements(gameExePath);
  });

  ipcMain.handle("install-requirement", async (_, reqId) => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) {
      throw new Error("No game executable configured.");
    }
    const req = loadRequirementDefs().find((r) => r.id === reqId);
    if (!req) {
      throw new Error(`Unknown requirement id: ${reqId}`);
    }
    await installRequirementFromZip(req, gameExePath, APP_DIR);
    // Return updated statuses after install.
    return checkAllRequirements(gameExePath);
  });
}

module.exports = { registerIpcHandlers };
