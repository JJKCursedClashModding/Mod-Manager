const { dialog } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { existsSync } = require("fs");
const { GAME_EXE_NAME } = require("./constants");
const { writeConfig } = require("./config");

async function pickGameLocation(defaultStartDir) {
  const result = await dialog.showOpenDialog({
    title: `Select ${GAME_EXE_NAME}`,
    properties: ["openFile"],
    filters: [{ name: "Executable", extensions: ["exe"] }],
    defaultPath: defaultStartDir,
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const selected = result.filePaths[0];
  if (path.basename(selected) !== GAME_EXE_NAME) {
    throw new Error(`Please select "${GAME_EXE_NAME}".`);
  }

  return selected;
}

async function pickFolder(title) {
  const result = await dialog.showOpenDialog({
    title,
    properties: ["openDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return result.filePaths[0];
}

async function ensureDirectory(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function findModsFolder(gameExePath) {
  const candidate = path.resolve(path.dirname(gameExePath), "../../Content/Mods");
  await fs.mkdir(candidate, { recursive: true });
  return candidate;
}

/** Same base as mod workspace: exe dir → ../../Content/… */
function resolveGamePaksModsDir(gameExePath) {
  if (!gameExePath || typeof gameExePath !== "string") {
    return null;
  }
  return path.resolve(path.dirname(gameExePath), "../../Content/Paks/~mods");
}

async function copyPackagedIoStoreToGamePaksMods(gameExePath, outputDir, ioBase, reporter) {
  const destDir = resolveGamePaksModsDir(gameExePath);
  if (!destDir) {
    reporter?.({
      type: "log",
      stream: "stdout",
      message: "No game executable path set; skipped copy to Content/Paks/~mods.",
    });
    return null;
  }
  const names = [`${ioBase}.pak`, `${ioBase}.utoc`, `${ioBase}.ucas`];
  for (const name of names) {
    const src = path.join(outputDir, name);
    if (!existsSync(src)) {
      throw new Error(`Expected output file missing after packaging: ${src}`);
    }
  }
  await fs.mkdir(destDir, { recursive: true });
  for (const name of names) {
    const src = path.join(outputDir, name);
    const dest = path.join(destDir, name);
    await fs.copyFile(src, dest);
    reporter?.({ type: "log", stream: "stdout", message: `Copied ${name} → ${dest}` });
  }
  return destDir;
}

async function resolveModsFolder(gameLocation, modsFolderOverride) {
  if (modsFolderOverride && (await ensureDirectory(modsFolderOverride))) {
    return modsFolderOverride;
  }

  if (!gameLocation) {
    return null;
  }

  return findModsFolder(gameLocation);
}

function manifestVersionFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const v = parsed.version;
  if (typeof v === "string" && v.trim()) {
    return v.trim();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return undefined;
}

async function readModManifestJson(modPath, folderName) {
  const manifestPath = path.join(modPath, "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { title: folderName, description: "No description", version: undefined };
    }
    const title =
      typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : folderName;
    const description =
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim()
        : "No description";
    const rawPriority = parsed.priority;
    const priority =
      typeof rawPriority === "number" && Number.isFinite(rawPriority) ? rawPriority : 0;
    return { title, description, version: manifestVersionFromParsed(parsed), priority };
  } catch {
    return { title: folderName, description: "No description", version: undefined, priority: 0 };
  }
}

async function listModDirectoryNames(modsFolder) {
  const entries = await fs.readdir(modsFolder, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Whitelist: only mods in enabledMods are on. New installs default to [] (all off).
 * Migrates legacy disabledMods once into enabledMods.
 */
async function syncEnabledModsWithConfig(config, modsFolder) {
  const modIds = await listModDirectoryNames(modsFolder);
  const idSet = new Set(modIds);
  let enabledList;
  let changed = false;

  if (Array.isArray(config.enabledMods)) {
    enabledList = config.enabledMods.filter((id) => idSet.has(id));
    if (enabledList.length !== config.enabledMods.length) changed = true;
  } else if (Array.isArray(config.disabledMods)) {
    const disabled = new Set(config.disabledMods);
    enabledList = modIds.filter((id) => !disabled.has(id));
    delete config.disabledMods;
    changed = true;
  } else {
    enabledList = [];
    changed = true;
  }

  const sorted = [...enabledList].sort((a, b) => a.localeCompare(b));
  if (changed || JSON.stringify(config.enabledMods) !== JSON.stringify(sorted)) {
    config.enabledMods = sorted;
    await writeConfig(config);
  }
  return sorted;
}

async function modRootHasMatchingPakUtocUcas(modPath) {
  const entries = await fs.readdir(modPath, { withFileTypes: true });
  const byBase = new Map();
  for (const e of entries) {
    if (!e.isFile()) {
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (ext !== ".pak" && ext !== ".utoc" && ext !== ".ucas") {
      continue;
    }
    const base = e.name.slice(0, -ext.length);
    const baseKey = process.platform === "win32" ? base.toLowerCase() : base;
    if (!byBase.has(baseKey)) {
      byBase.set(baseKey, new Set());
    }
    byBase.get(baseKey).add(ext);
  }
  for (const exts of byBase.values()) {
    if (exts.has(".pak") && exts.has(".utoc") && exts.has(".ucas")) {
      return true;
    }
  }
  return false;
}

async function computeModChecklist(modPath) {
  return {
    registry: existsSync(path.join(modPath, "AssetRegistry.json")),
    packages: await modRootHasMatchingPakUtocUcas(modPath),
    assets: await ensureDirectory(path.join(modPath, "assets")),
    datatables: await ensureDirectory(path.join(modPath, "datatables")),
    pakAssets: await ensureDirectory(path.join(modPath, "pak_assets")),
  };
}

async function loadMods(modsFolder, enabledMods = []) {
  const entries = await fs.readdir(modsFolder, { withFileTypes: true });
  const mods = [];
  const enabledSet = new Set(enabledMods);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const modPath = path.join(modsFolder, entry.name);
    const checklist = await computeModChecklist(modPath);
    const details = await readModManifestJson(modPath, entry.name);
    mods.push({
      id: entry.name,
      folderName: entry.name,
      fullPath: modPath,
      title: details.title,
      description: details.description,
      version: details.version,
      priority: details.priority ?? 0,
      enabled: enabledSet.has(entry.name),
      checklist,
    });
  }

  // UI order: highest priority first; ties broken alphabetically by title.
  return mods.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.title.localeCompare(b.title);
  });
}

async function loadModsStateFromConfig(config) {
  const gameLocation = config.gameExePath || config.gameLocation || null;
  const modsFolderOverride = config.modsFolderOverride || null;
  const unpackedAssetsPath = config.unpackedAssetsPath || null;
  if (!gameLocation) {
    return {
      gameLocation: null,
      modsFolder: null,
      modsFolderOverride,
      unpackedAssetsPath,
      mods: [],
      error: "No game executable configured.",
    };
  }

  const modsFolder = await resolveModsFolder(gameLocation, modsFolderOverride);
  if (!modsFolder) {
    return {
      gameLocation,
      modsFolder: null,
      modsFolderOverride,
      unpackedAssetsPath,
      mods: [],
      error: "Could not find a mods folder relative to the selected game path.",
    };
  }

  const enabledMods = await syncEnabledModsWithConfig(config, modsFolder);
  const mods = await loadMods(modsFolder, enabledMods);
  return {
    gameLocation,
    modsFolder,
    modsFolderOverride,
    unpackedAssetsPath,
    mods,
    error: null,
  };
}

module.exports = {
  pickGameLocation,
  pickFolder,
  ensureDirectory,
  findModsFolder,
  resolveGamePaksModsDir,
  copyPackagedIoStoreToGamePaksMods,
  resolveModsFolder,
  readModManifestJson,
  listModDirectoryNames,
  syncEnabledModsWithConfig,
  loadMods,
  loadModsStateFromConfig,
};
