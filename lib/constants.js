const path = require("path");
const { existsSync, statSync } = require("fs");

/**
 * Resolves the runtime app directory in a layout-agnostic way.
 *
 * Supports:
 * - dev/source runs (project root)
 * - packaged builds with `extraResources` (inside `resources/`)
 * - packaged builds with root-level files next to the `.exe`
 *
 * @returns {string}
 */
function resolveAppDir() {
  const candidates = [];

  // Source/dev run: `lib/` sits under the project root.
  candidates.push(path.join(__dirname, ".."));

  // Packaged Electron layouts.
  if (process?.resourcesPath) {
    candidates.push(process.resourcesPath);
  }
  if (process?.execPath) {
    candidates.push(path.dirname(process.execPath));
  }

  for (const dir of candidates) {
    // If candidate points to app.asar, treat its parent as the real directory.
    const normalized = String(dir).toLowerCase().endsWith(".asar")
      ? path.dirname(dir)
      : dir;

    let isDirectory = false;
    try {
      isDirectory = statSync(normalized).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;

    const hasData = existsSync(path.join(normalized, "data"));
    const hasTools = existsSync(path.join(normalized, "tools"));
    if (hasData && hasTools) {
      return normalized;
    }
  }

  // Safe fallback to source-style structure.
  return path.join(__dirname, "..");
}

/** Absolute path to the ModManager app runtime directory. */
const APP_DIR = resolveAppDir();

const CONFIG_FILE = "config.json";
const GAME_EXE_NAME = "Jujutsu Kaisen CC.exe";
const RETOC_AES_KEY = "0xBABFB8ACBA15424956C49B4E6CE9CFA43D5924D0B82FFDF8B6D5D70BE4F9DC82";
const RETOC_ENGINE_VERSION = "UE5_1";
const REPAK_VERSION = "V11";
const REPAK_MOUNT_POINT = "../../../";

const DATA_DIR = path.join(APP_DIR, "data");
const DATATABLES_DIR = path.join(APP_DIR, "data", "datatables");
const PARAMETERS_DIR = path.join(APP_DIR, "data", "parameters");
const PARAMETERS_MANIFEST = path.join(PARAMETERS_DIR, "base-manifest.json");
const BASE_REGISTRY_BIN = path.join(DATA_DIR, "AssetRegistry.bin");
/**
 * Electron `app` when running inside Electron; null under plain node
 * (scripts/tests), where `require("electron")` is just the binary path.
 */
function electronApp() {
  try {
    const electron = require("electron");
    return electron && typeof electron === "object" && electron.app ? electron.app : null;
  } catch {
    return null;
  }
}

/**
 * Writable per-user directory for generated files. In packaged builds
 * APP_DIR is `resources/` (often under Program Files → EPERM), so anything
 * the app writes goes to userData instead. Dev/source runs keep using the
 * project root so `build/` stays easy to inspect.
 */
function resolveWritableDir(devDir, ...userDataSegments) {
  const app = electronApp();
  if (app && app.isPackaged) {
    try {
      return path.join(app.getPath("userData"), ...userDataSegments);
    } catch {
      /* fall through */
    }
  }
  return devDir;
}

/** Default folder for exported .jjkmod files (packaged: Documents). */
function resolveDefaultExportDir() {
  const devDir = path.join(APP_DIR, "mods", "jjkmod");
  const app = electronApp();
  if (app && app.isPackaged) {
    try {
      return path.join(app.getPath("documents"), "JJK CC Mod Manager", "jjkmod");
    } catch {
      return resolveWritableDir(devDir, "jjkmod");
    }
  }
  return devDir;
}

/** Build workspace (staging, output, merged patch files, deploy manifest). */
const BUILD_DIR = resolveWritableDir(path.join(APP_DIR, "build"), "build");
const DEFAULT_EXPORT_DIR = resolveDefaultExportDir();
const TOOLS_DIR = path.join(APP_DIR, "tools");
const DEFAULT_GAME_EXE_START_DIR =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Jujutsu Kaisen CC\\Jujutsu Kaisen CC\\Binaries\\Win64";

module.exports = {
  APP_DIR,
  CONFIG_FILE,
  GAME_EXE_NAME,
  RETOC_AES_KEY,
  RETOC_ENGINE_VERSION,
  REPAK_VERSION,
  REPAK_MOUNT_POINT,
  DATA_DIR,
  DATATABLES_DIR,
  PARAMETERS_DIR,
  PARAMETERS_MANIFEST,
  BASE_REGISTRY_BIN,
  BUILD_DIR,
  DEFAULT_EXPORT_DIR,
  TOOLS_DIR,
  DEFAULT_GAME_EXE_START_DIR,
};
