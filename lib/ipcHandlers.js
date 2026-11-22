const { app, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs/promises");
const path = require("path");
const { existsAsync } = require("./asyncUtils");
const { APP_DIR, BUILD_DIR, DEFAULT_GAME_EXE_START_DIR } = require("./constants");
const { readConfig, updateConfig, takeConfigWarning } = require("./config");
const {
  pickGameLocation,
  pickFolder,
  pickZipFile,
  pickSaveJjkmodPath,
  ensureDirectory,
  resolveModsFolder,
  listModDirectoryNames,
  syncEnabledModsWithConfig,
  loadModsStateFromConfig,
  resolveGamePaksModsDir,
  resolveGameScriptsDir,
} = require("./modUtils");
const { DEPLOY_MANIFEST_FILE, targetKey, readManifest } = require("./deploy");
const { fingerprintMods, diffInstalled } = require("./installState");
const { setModPriority } = require("./setModPriority");
const { runCommand } = require("./tools");
const { packageAllMods } = require("./packageAllMods");
const { packageSingleMod, suggestedJjkmodPath } = require("./packageSingleMod");
const { createModManifest } = require("./createModManifest");
const { validateModJson } = require("./validateModJson");
const { dryRunMod } = require("./dryRunMod");
const { installModFromZip, peekModInfo, compareVersions, readVersionFromModFolder } = require("./installModFromZip");
const {
  checkRequirement,
  checkAllRequirements,
  loadRequirementDefs,
  installRequirement,
} = require("./requirements");
const { describeLegacySetup, deleteLegacySetupItems } = require("./setupWizard");
const { checkForAppUpdate } = require("./updateCheck");

// ── Library/build lock ──────────────────────────────────────────────────────
//
// A build reads every enabled mod folder while installs/updates rm and
// re-extract mod folders, so the two must never overlap. One main-process
// lock covers builds and library mutations (install/update/reinstall);
// a second build is rejected too. Callers get a clear error instead of
// waiting silently; OS-opened .jjkmod files are held in main.js until the
// build finishes (see `libraryLock.on("idle")`).

/** @type {null | { kind: "build" | "install", label: string }} */
let activeOperation = null;
const libraryLock = new EventEmitter();

function busyMessage(requestedKind) {
  if (!activeOperation) return null;
  if (activeOperation.kind === "build") {
    return requestedKind === "build"
      ? "A build is already running. Wait for it to finish."
      : "Mods are being installed into the game right now. Wait for the build to finish, then add or update mods.";
  }
  return requestedKind === "build"
    ? `A mod is being added to your library (${activeOperation.label}). Wait for it to finish, then install mods into the game.`
    : `Another mod is being added to your library (${activeOperation.label}). Wait for it to finish.`;
}

async function withLibraryLock(kind, label, fn) {
  const busy = busyMessage(kind);
  if (busy) {
    throw new Error(busy);
  }
  activeOperation = { kind, label };
  try {
    return await fn();
  } finally {
    activeOperation = null;
    libraryLock.emit("idle");
  }
}

function isBuildInProgress() {
  return Boolean(activeOperation && activeOperation.kind === "build");
}

// ── Renderer-supplied path validation ───────────────────────────────────────

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** True when `child` is strictly inside `parent` (not equal to it). */
function isStrictlyInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function configuredModsFolder() {
  const config = await readConfig();
  const gameExePath = config.gameExePath || config.gameLocation || null;
  return resolveModsFolder(gameExePath, config.modsFolderOverride || null);
}

/**
 * Validates a renderer-provided mods folder: it must be the folder the app
 * itself resolves from config. Returns the main-process value.
 */
async function requireConfiguredModsFolder(requested) {
  const modsFolder = await configuredModsFolder();
  if (!modsFolder) {
    throw new Error("Mods folder not available.");
  }
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !samePath(requested, modsFolder)) {
      throw new Error("Refusing to use a folder that is not the configured mods folder.");
    }
  }
  return modsFolder;
}

/**
 * Validates a renderer-provided mod folder path: must be an existing
 * directory directly inside the configured mods folder.
 */
async function requireModFolder(modFolderPath) {
  if (!modFolderPath || typeof modFolderPath !== "string") {
    throw new Error("No mod folder path provided.");
  }
  const modsFolder = await configuredModsFolder();
  if (!modsFolder) {
    throw new Error("Mods folder not available.");
  }
  const resolved = path.resolve(modFolderPath);
  if (!isStrictlyInside(resolved, modsFolder) || !samePath(path.dirname(resolved), modsFolder)) {
    throw new Error("Mod folder must be inside the configured mods folder.");
  }
  if (!(await ensureDirectory(resolved))) {
    throw new Error(`Mod folder not found:\n${resolved}`);
  }
  return resolved;
}

/** .jjkmod save paths the user picked in the native save dialog this session. */
const approvedExportPaths = new Set();

function exportPathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

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
    if (!sender.isDestroyed()) {
      sender.send("package-progress", payload);
    }
  };
}

function registerIpcHandlers() {
  ipcMain.handle("init-app", async () => {
    let config = await readConfig();
    const setupWizardCompleted = Boolean(config.setupWizardCompleted);
    let gameLocation = config.gameExePath || config.gameLocation || null;
    const gameExeStartDir =
      config.gameExeStartDir || (gameLocation ? path.dirname(gameLocation) : DEFAULT_GAME_EXE_START_DIR);

    if (!gameLocation) {
      if (!setupWizardCompleted) {
        // First run: the setup wizard (step 1) handles picking the exe,
        // so don't pop the native dialog underneath the wizard.
        return {
          gameLocation: null,
          modsFolder: null,
          modsFolderOverride: config.modsFolderOverride || null,
          unpackedAssetsPath: config.unpackedAssetsPath || null,
          mods: [],
          error: "No game executable configured.",
          setupWizardCompleted: false,
          configWarning: takeConfigWarning(),
        };
      }
      try {
        gameLocation = await pickGameLocation(gameExeStartDir);
      } catch (error) {
        return {
          gameLocation: null,
          modsFolder: null,
          mods: [],
          error: error instanceof Error ? error.message : String(error),
          setupWizardCompleted: true,
          configWarning: takeConfigWarning(),
        };
      }
      if (!gameLocation) {
        return {
          gameLocation: null,
          modsFolder: null,
          mods: [],
          error: "No game executable selected.",
          setupWizardCompleted: true,
          configWarning: takeConfigWarning(),
        };
      }

      config = await updateConfig((c) => {
        c.gameExePath = gameLocation;
        c.gameExeStartDir = path.dirname(gameLocation);
        delete c.gameLocation;
      });
    }

    const latest = await readConfig();
    const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
    return {
      ...state,
      verboseOutput: Boolean(latest.verboseOutput),
      setupWizardCompleted: Boolean(latest.setupWizardCompleted),
      configWarning: takeConfigWarning(),
    };
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

    await updateConfig((c) => {
      c.gameExePath = nextPath;
      c.gameExeStartDir = path.dirname(nextPath);
      delete c.gameLocation;
    });

    const latest = await readConfig();
    const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
    return {
      cancelled: false,
      ...state,
      verboseOutput: Boolean(latest.verboseOutput),
      setupWizardCompleted: Boolean(latest.setupWizardCompleted),
    };
  });

  ipcMain.handle("set-mod-enabled", async (_, modId, enabled) => {
    if (!modId || typeof modId !== "string") {
      throw new Error("Invalid mod id.");
    }
    // Serialized read-modify-write: rapid toggles can't drop each other.
    await updateConfig((config) => {
      const set = new Set(Array.isArray(config.enabledMods) ? config.enabledMods : []);
      delete config.disabledMods;
      if (enabled) {
        set.add(modId);
      } else {
        set.delete(modId);
      }
      config.enabledMods = Array.from(set).sort((a, b) => a.localeCompare(b));
    });
    // Recompute overlaps from cache (no rescan) so the badge stays fresh.
    try {
      const state = await loadModsStateFromConfig(await readConfig());
      return { ok: true, conflicts: state.conflicts };
    } catch {
      return { ok: true, conflicts: null };
    }
  });

  ipcMain.handle("refresh-mods", async () => {
    const config = await readConfig();
    return await loadModsStateFromConfig(config, { rescanConflicts: true });
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
    await updateConfig((c) => {
      delete c.disabledMods;
      c.enabledMods = modIds.sort((a, b) => a.localeCompare(b));
    });
    return await loadModsStateFromConfig(await readConfig());
  });

  ipcMain.handle("disable-all-mods", async () => {
    await updateConfig((c) => {
      delete c.disabledMods;
      c.enabledMods = [];
    });
    return await loadModsStateFromConfig(await readConfig());
  });

  ipcMain.handle("set-mods-folder-override", async () => {
    const nextPath = await pickFolder("Select mods folder override");
    if (!nextPath) {
      return { cancelled: true };
    }

    await updateConfig((c) => {
      c.modsFolderOverride = nextPath;
    });

    const latest = await readConfig();
    return { cancelled: false, ...(await loadModsStateFromConfig(latest, { rescanConflicts: true })) };
  });

  ipcMain.handle("clear-mods-folder-override", async () => {
    await updateConfig((c) => {
      delete c.modsFolderOverride;
    });

    const latest = await readConfig();
    return await loadModsStateFromConfig(latest, { rescanConflicts: true });
  });

  ipcMain.handle("set-unpacked-assets-path", async () => {
    const nextPath = await pickFolder("Select unpacked assets folder");
    if (!nextPath) {
      return { cancelled: true };
    }

    await updateConfig((c) => {
      c.unpackedAssetsPath = nextPath;
    });

    const latest = await readConfig();
    return { cancelled: false, ...(await loadModsStateFromConfig(latest)) };
  });

  ipcMain.handle("clear-unpacked-assets-path", async () => {
    await updateConfig((c) => {
      delete c.unpackedAssetsPath;
    });

    const latest = await readConfig();
    return await loadModsStateFromConfig(latest);
  });

  ipcMain.handle("set-verbose-output", async (_, verbose) => {
    const config = await updateConfig((c) => {
      c.verboseOutput = Boolean(verbose);
    });
    return { ok: true, verboseOutput: config.verboseOutput };
  });

  ipcMain.handle("open-external-url", async (_, url) => {
    if (!url || typeof url !== "string") {
      throw new Error("Invalid URL.");
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL.");
    }
    // Only web links: never file:, ms-settings:, custom protocol handlers, …
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http(s) links can be opened.");
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });

  ipcMain.handle("open-mods-folder", async (_, modsFolder) => {
    if (!modsFolder || typeof modsFolder !== "string") {
      throw new Error("No mods folder to open.");
    }
    const target = await requireConfiguredModsFolder(modsFolder);
    const err = await shell.openPath(target);
    if (err) {
      throw new Error(err);
    }
    return { ok: true };
  });

  ipcMain.handle("open-mod-folder", async (_, modFolderPath) => {
    const target = await requireModFolder(modFolderPath);
    const err = await shell.openPath(target);
    if (err) {
      throw new Error(err);
    }
    return { ok: true };
  });

  ipcMain.handle("pick-save-jjkmod-path", async (_, modFolderPath) => {
    const modPath = await requireModFolder(modFolderPath);
    // Remember the last folder the user exported to — the save dialog
    // reopens there instead of always resetting to the default location.
    let preferredDir = null;
    try {
      const config = await readConfig();
      const saved = config.jjkmodExportDir;
      if (typeof saved === "string" && saved.trim() && (await existsAsync(saved.trim()))) {
        const stat = await fs.stat(saved.trim());
        if (stat.isDirectory()) {
          preferredDir = saved.trim();
        }
      }
    } catch {
      preferredDir = null;
    }
    const suggested = await suggestedJjkmodPath(modPath, preferredDir);
    const filePath = await pickSaveJjkmodPath(suggested);
    if (!filePath) {
      return { cancelled: true };
    }
    // Only paths chosen in this dialog may be passed back as outPath.
    approvedExportPaths.add(exportPathKey(filePath));
    try {
      await updateConfig((c) => {
        c.jjkmodExportDir = path.dirname(filePath);
      });
    } catch {
      /* remembering the folder is best-effort — never fail the export */
    }
    return { cancelled: false, filePath };
  });

  ipcMain.handle("package-single-mod", async (_, modFolderPath, outPath) => {
    const modPath = await requireModFolder(modFolderPath);
    let approvedOutPath;
    if (outPath !== undefined && outPath !== null && outPath !== "") {
      // The renderer can't write anywhere it likes: outPath must be a path
      // the user picked in the native save dialog (pick-save-jjkmod-path).
      if (typeof outPath !== "string" || !approvedExportPaths.has(exportPathKey(outPath))) {
        throw new Error("Choose where to save the .jjkmod file using the save dialog.");
      }
      approvedOutPath = outPath;
    }
    const result = await packageSingleMod(modPath, approvedOutPath);
    if (approvedOutPath) {
      approvedExportPaths.delete(exportPathKey(approvedOutPath));
    }
    // Also remember the folder when packaging with an explicit path,
    // so direct (dialog-less) exports update the next dialog location.
    try {
      const produced = result && result.jjkmodPath;
      if (typeof produced === "string" && produced.trim()) {
        await updateConfig((c) => {
          c.jjkmodExportDir = path.dirname(produced);
        });
      }
    } catch {
      /* best-effort only */
    }
    return result;
  });

  // Syntax/shape checks, then a patcher dry run (temp dir only) so files the
  // build would reject are reported here too. See lib/dryRunMod.js.
  ipcMain.handle("validate-mod-json", async (_, modFolderPath) => {
    const modPath = await requireModFolder(modFolderPath);
    const result = await validateModJson(modPath);
    let dryRun;
    try {
      dryRun = await dryRunMod(modPath, { skipFiles: new Set(result.errors.map((e) => e.file)) });
    } catch (error) {
      dryRun = {
        ran: false,
        note: `The patcher test could not run (${error instanceof Error ? error.message : String(error)}); only JSON syntax and AssetRegistry shape were checked.`,
        errors: [],
        warnings: [],
        patched: null,
      };
    }
    // Report dry-run findings under the same path spelling as `checked`
    // (the dry run may say "datatables/x.json" for a "Datatables/" folder).
    const canonical = new Map(result.checked.map((f) => [f.toLowerCase(), f]));
    const canon = (list) => list.map((e) => ({ ...e, file: canonical.get(String(e.file).toLowerCase()) || e.file }));
    return {
      ...result,
      errors: [...result.errors, ...canon(dryRun.errors)],
      warnings: [...result.warnings, ...canon(dryRun.warnings)],
      dryRun: { ran: dryRun.ran, note: dryRun.note, patched: dryRun.patched },
    };
  });

  // Writes `priority` into the mod's manifest.json, returns refreshed state.
  ipcMain.handle("set-mod-priority", async (_, modFolderPath, priority) => {
    const modPath = await requireModFolder(modFolderPath);
    if (isBuildInProgress()) {
      throw new Error("Mods are being installed into the game right now. Change the priority when that finishes.");
    }
    const value = typeof priority === "string" && /^\s*-?\d+\s*$/.test(priority) ? Number(priority) : priority;
    await setModPriority(modPath, value);
    return await loadModsStateFromConfig(await readConfig());
  });

  /**
   * Compares the enabled mods (+ content fingerprints) with what the last
   * successful install recorded in the deploy manifest for this game.
   * state: "up-to-date" | "stale" | "never" (nothing installed for this game
   * yet) | "unknown" (installed by an older version, no record) | "no-game".
   */
  ipcMain.handle("get-install-status", async () => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    const modsFolder = gameExePath ? await configuredModsFolder() : null;
    if (!gameExePath || !modsFolder) {
      return { state: "no-game", changes: [], installedAt: null };
    }
    const enabledIds = await syncEnabledModsWithConfig(config, modsFolder);
    const current = await fingerprintMods(enabledIds.map((id) => ({ id, fullPath: path.join(modsFolder, id) })));
    const key = targetKey(resolveGamePaksModsDir(gameExePath), resolveGameScriptsDir(gameExePath));
    const { manifest } = await readManifest(path.join(BUILD_DIR, DEPLOY_MANIFEST_FILE));
    const target = manifest.targets[key];
    if (!target) {
      return {
        state: enabledIds.length > 0 ? "never" : "up-to-date",
        changes: diffInstalled({}, current),
        installedAt: null,
      };
    }
    if (!target.installedMods || typeof target.installedMods !== "object") {
      return { state: "unknown", changes: [], installedAt: target.updatedAt || null };
    }
    const changes = diffInstalled(target.installedMods, current);
    return { state: changes.length > 0 ? "stale" : "up-to-date", changes, installedAt: target.updatedAt || null };
  });

  ipcMain.handle("create-mod-manifest", async (_, modFolderPath) => {
    return createModManifest(await requireModFolder(modFolderPath));
  });

  /**
   * Shared core: install a .jjkmod/.zip at an explicit path into the library.
   * Holds the library lock so it can't run while a build reads mod folders.
   */
  async function installModFileIntoLibrary(zipPath, options = {}) {
    if (!zipPath || typeof zipPath !== "string") {
      throw new Error("No mod file provided.");
    }
    if (!/\.(jjkmod|zip)$/i.test(zipPath)) {
      throw new Error(`Unsupported mod file type (expected .jjkmod or .zip):\n${zipPath}`);
    }
    let stat = null;
    try {
      stat = await fs.stat(zipPath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      throw new Error(`Mod file not found:\n${zipPath}`);
    }
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) {
      throw new Error("No game executable configured.");
    }
    const modsFolder = await resolveModsFolder(gameExePath, config.modsFolderOverride || null);
    if (!modsFolder) {
      throw new Error("Mods folder not available.");
    }

    const result = await withLibraryLock("install", path.basename(zipPath), () =>
      installModFromZip(zipPath, modsFolder, { allowReinstall: Boolean(options && options.allowReinstall) }),
    );
    const latest = await readConfig();
    const state = await loadModsStateFromConfig(latest, { rescanConflicts: true });
    return { cancelled: false, ...result, ...state };
  }

  ipcMain.handle("install-mod-from-zip", async () => {
    const busy = busyMessage("install");
    if (busy) {
      throw new Error(busy);
    }
    const zipPath = await pickZipFile();
    if (!zipPath) {
      return { cancelled: true };
    }
    return installModFileIntoLibrary(zipPath);
  });

  ipcMain.handle("install-mod-from-file", async (_, filePath, options) => {
    return installModFileIntoLibrary(filePath, options);
  });

  // Peek only — returns the NAME for the "Do you want to install NAME?"
  // prompt without touching the mods folder. Includes any already-installed
  // version so the prompt can warn about updates / no-op reinstalls.
  ipcMain.handle("preview-mod-file", async (_, filePath) => {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("No mod file provided.");
    }
    const info = await peekModInfo(filePath);
    let exists = false;
    let existingVersion = null;
    let status = "new";
    try {
      const modsFolder = await configuredModsFolder();
      if (modsFolder) {
        const modPath = path.join(modsFolder, info.modFolderName);
        if (await existsAsync(modPath)) {
          exists = true;
          existingVersion = await readVersionFromModFolder(modPath);
          const cmp = compareVersions(info.version, existingVersion);
          if (cmp === 0) {
            status = "same";
          } else if (cmp > 0) {
            status = "update";
          } else {
            status = "older";
          }
        }
      }
    } catch {
      /* advisory only — install step re-validates */
    }
    return { ...info, exists, existingVersion, status };
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

  ipcMain.handle("package-all-mods", async (event, requestedModsFolder) => {
    if (!requestedModsFolder) {
      throw new Error("No mods folder available.");
    }
    const modsFolder = await requireConfiguredModsFolder(requestedModsFolder);

    return withLibraryLock("build", "build", async () => {
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
  });

  // ── Requirements ────────────────────────────────────────────────────────────

  ipcMain.handle("check-requirements", async () => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    return await checkAllRequirements(gameExePath);
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
    await installRequirement(req, gameExePath, APP_DIR);
    // Return updated statuses after install.
    return await checkAllRequirements(gameExePath);
  });

  // ── Setup wizard ──────────────────────────────────────────────────────────

  // Snapshot for the wizard: selected exe + legacy-file scan + sigpatch state.
  ipcMain.handle("get-setup-status", async () => {
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
    } catch {
      /* advisory only — wizard renders the unknown state */
    }
    return {
      gameExePath,
      exeDir: cleanup.exeDir,
      cleanup,
      sigpatch,
    };
  });

  // Deletes the selected legacy items ("ue4ss" and/or "datatablepatcher")
  // from the game exe directory. Returns the refreshed scan.
  ipcMain.handle("delete-legacy-setup", async (_, targetIds) => {
    const config = await readConfig();
    const gameExePath = config.gameExePath || config.gameLocation || null;
    if (!gameExePath) {
      throw new Error("No game executable configured.");
    }
    const result = await deleteLegacySetupItems(gameExePath, targetIds);
    return { ...result, cleanup: await describeLegacySetup(gameExePath) };
  });

  // Marks the wizard as seen so it doesn't auto-open on next launch.
  // Called on Finish, Skip and dismiss — it can always be rerun from Settings.
  ipcMain.handle("complete-setup-wizard", async () => {
    await updateConfig((c) => {
      c.setupWizardCompleted = true;
    });
    return { ok: true };
  });

  ipcMain.handle("check-app-update", async () => {
    try {
      return await checkForAppUpdate(app.getVersion());
    } catch {
      return {
        ok: false,
        hasRelease: false,
        upToDate: true,
        currentVersion: app.getVersion(),
        latestVersion: null,
        latestUrl: "https://github.com/JJKCursedClashModding/Mod-Manager/releases",
      };
    }
  });
}

module.exports = { registerIpcHandlers, isBuildInProgress, libraryLock };
