const fs = require("fs/promises");
const { existsSync, mkdirSync, readFileSync } = require("fs");
const path = require("path");

/**
 * Master list of requirements.
 *
 * Each entry may have:
 *   id            {string}        Unique identifier.
 *   name          {string}        Display name.
 *   description   {string}        Short description shown in the modal.
 *   checkPaths    {string[]}      Paths relative to the game exe directory that must
 *                                 ALL exist for the requirement to be considered installed.
 *                                 Leave empty ([]) for requirements that cannot be auto-checked.
 *   versionCheck  {object|null}   Optional version check:
 *     jsonPath    {string}        Path to a JSON file relative to the game exe directory.
 *     field       {string}        Dot-separated field path inside the JSON (e.g. "version").
 *     required    {string}        Version constraint string, e.g. ">=3" or ">=1.2.0".
 *   url           {string|null}   External download URL shown as a "Download" button.
 *   zipPath       {string|null}   Path to a bundled zip, relative to the ModManagerApp root.
 *   installPath   {string|null}   Destination directory relative to the game exe directory.
 *                                 Used together with zipPath for one-click installs.
 *
 * Status rules:
 *   - If no checkPaths and no versionCheck → installed = null (unknown/not checkable).
 *   - If checkPaths present → all must exist.
 *   - If versionCheck present → JSON must exist and version must satisfy the constraint.
 *   - Both checks must pass if both are specified.
 *   - If version check fails (file exists but version is wrong) → installed = "outdated".
 */
const REQUIREMENT_DEFS = [
  {
    id: "signature-bypass",
    name: "UTOC Signature Bypass",
    description: "Required to load modded IoStore (.utoc/.ucas) containers.",
    checkPaths: ["dsound.dll", "plugins/JJKCCUTOCSigBypass.asi"],
    versionCheck: null,
    url: "https://www.nexusmods.com/jujutsukaisencursedclash/mods/21",
    zipPath: null,
    installPath: null,
  },
  {
    id: "datatable-patcher",
    name: "DataTable Patcher",
    description: "Required to load modded DataTable JSON files at runtime.",
    checkPaths: [],
    versionCheck: null,
    url: null,
    zipPath: null,
    installPath: null,
  },
  {
    id: "ue4ss",
    name: "UE4SS",
    description: "Unreal Engine scripting system required by some mods.",
    checkPaths: [],
    versionCheck: null,
    url: null,
    zipPath: null,
    installPath: null,
  },
];

/**
 * Returns the requirements definition list.
 * @returns {Array}
 */
function loadRequirementDefs() {
  return REQUIREMENT_DEFS;
}

// ── Version comparison helpers ────────────────────────────────────────────────

/**
 * Parses a version string like "1.2.3" into an array of numbers [1, 2, 3].
 * Non-numeric segments are treated as 0.
 * @param {string} v
 * @returns {number[]}
 */
function parseVersion(v) {
  return String(v)
    .split(".")
    .map((s) => parseInt(s, 10) || 0);
}

/**
 * Compares two version arrays.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {-1|0|1}
 */
function compareVersionArrays(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Checks whether `actual` satisfies the `required` constraint string.
 * Supported operators: >=, >, <=, <, =, == (defaults to ==).
 * Examples: ">=3", ">=1.2.0", "=2", ">1.0"
 *
 * @param {string} actual   The version found in the JSON.
 * @param {string} required The constraint string from the requirement def.
 * @returns {boolean}
 */
function satisfiesVersion(actual, required) {
  const match = String(required).match(/^(>=|>|<=|<|={1,2})?(.+)$/);
  if (!match) return false;
  const op = match[1] || "==";
  const target = match[2].trim();
  const cmp = compareVersionArrays(parseVersion(actual), parseVersion(target));
  switch (op) {
    case ">=": return cmp >= 0;
    case ">":  return cmp > 0;
    case "<=": return cmp <= 0;
    case "<":  return cmp < 0;
    case "=":
    case "==": return cmp === 0;
    default:   return false;
  }
}

/**
 * Reads a dot-separated field from a plain object.
 * e.g. getField({a:{b:1}}, "a.b") → 1
 * @param {object} obj
 * @param {string} fieldPath
 * @returns {*}
 */
function getField(obj, fieldPath) {
  return fieldPath.split(".").reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

// ── Requirement checking ──────────────────────────────────────────────────────

/**
 * Checks whether a single requirement is satisfied given the game exe path.
 *
 * Returns an object with:
 *   installed  {true|false|"outdated"|null}
 *     true      = all checks pass
 *     false     = one or more checkPaths missing
 *     "outdated"= files present but version constraint not met
 *     null      = no checks defined / game path unknown
 *
 * @param {object} req         Requirement definition object.
 * @param {string|null} gameExePath  Absolute path to the game executable.
 * @returns {{ id, name, description, installed, statusDetail, url, zipPath, installPath }}
 */
function checkRequirement(req, gameExePath) {
  const gameDir = gameExePath ? path.dirname(gameExePath) : null;
  const hasPathChecks = Array.isArray(req.checkPaths) && req.checkPaths.length > 0;
  const hasVersionCheck = req.versionCheck != null;

  if (!gameDir || (!hasPathChecks && !hasVersionCheck)) {
    return {
      id: req.id,
      name: req.name,
      description: req.description ?? "",
      installed: null,
      statusDetail: null,
      url: req.url ?? null,
      zipPath: req.zipPath ?? null,
      installPath: req.installPath ?? null,
    };
  }

  // 1. Check that all required paths exist.
  if (hasPathChecks) {
    const missing = req.checkPaths.filter((p) => !existsSync(path.join(gameDir, p)));
    if (missing.length > 0) {
      return {
        id: req.id,
        name: req.name,
        description: req.description ?? "",
        installed: false,
        statusDetail: `Missing: ${missing.join(", ")}`,
        url: req.url ?? null,
        zipPath: req.zipPath ?? null,
        installPath: req.installPath ?? null,
      };
    }
  }

  // 2. Check version constraint if specified.
  if (hasVersionCheck) {
    const { jsonPath, field = "version", required } = req.versionCheck;
    const absJsonPath = path.join(gameDir, jsonPath);

    if (!existsSync(absJsonPath)) {
      return {
        id: req.id,
        name: req.name,
        description: req.description ?? "",
        installed: false,
        statusDetail: `Version file not found: ${jsonPath}`,
        url: req.url ?? null,
        zipPath: req.zipPath ?? null,
        installPath: req.installPath ?? null,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(absJsonPath, "utf8"));
    } catch {
      return {
        id: req.id,
        name: req.name,
        description: req.description ?? "",
        installed: false,
        statusDetail: `Could not parse version file: ${jsonPath}`,
        url: req.url ?? null,
        zipPath: req.zipPath ?? null,
        installPath: req.installPath ?? null,
      };
    }

    const actualVersion = getField(parsed, field);
    if (actualVersion == null) {
      return {
        id: req.id,
        name: req.name,
        description: req.description ?? "",
        installed: false,
        statusDetail: `Version field "${field}" not found in ${jsonPath}`,
        url: req.url ?? null,
        zipPath: req.zipPath ?? null,
        installPath: req.installPath ?? null,
      };
    }

    if (!satisfiesVersion(String(actualVersion), required)) {
      return {
        id: req.id,
        name: req.name,
        description: req.description ?? "",
        installed: "outdated",
        statusDetail: `Version ${actualVersion} does not satisfy ${required}`,
        url: req.url ?? null,
        zipPath: req.zipPath ?? null,
        installPath: req.installPath ?? null,
      };
    }
  }

  // All checks passed.
  return {
    id: req.id,
    name: req.name,
    description: req.description ?? "",
    installed: true,
    statusDetail: null,
    url: req.url ?? null,
    zipPath: req.zipPath ?? null,
    installPath: req.installPath ?? null,
  };
}

/**
 * Checks all requirement definitions against the game path.
 *
 * @param {string|null} gameExePath
 * @returns {Array}
 */
function checkAllRequirements(gameExePath) {
  return loadRequirementDefs().map((req) => checkRequirement(req, gameExePath));
}

/**
 * Returns true if any requirement with checkPaths is not installed.
 *
 * @param {Array} statuses  Output of checkAllRequirements().
 * @returns {boolean}
 */
function hasUnmetRequirements(statuses) {
  return statuses.some((s) => s.installed === false);
}

/**
 * Installs a requirement that has a `zipPath` + `installPath` by:
 *   1. Resolving the zip at `<APP_DIR>/<zipPath>`
 *   2. Extracting it into a temp dir
 *   3. Copying all extracted files into `<gameDir>/<installPath>`
 *
 * @param {object} req         Requirement definition (from requirements.json).
 * @param {string} gameExePath Absolute path to the game executable.
 * @param {string} appDir      Absolute path to the ModManagerApp root.
 * @returns {Promise<void>}
 */
async function installRequirementFromZip(req, gameExePath, appDir) {
  if (!req.zipPath || !req.installPath) {
    throw new Error(`Requirement "${req.id}" does not have zipPath/installPath fields.`);
  }
  if (!gameExePath) {
    throw new Error("No game executable path configured.");
  }

  const AdmZip = require("adm-zip");
  const gameDir = path.dirname(gameExePath);
  const zipAbsPath = path.join(appDir, req.zipPath);
  const destDir = path.join(gameDir, req.installPath);

  if (!existsSync(zipAbsPath)) {
    throw new Error(`Zip file not found: ${zipAbsPath}`);
  }

  // Ensure destination directory exists.
  await fs.mkdir(destDir, { recursive: true });

  const zip = new AdmZip(zipAbsPath);
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryDest = path.join(destDir, entry.entryName);
    const entryDestDir = path.dirname(entryDest);

    // Create any missing parent directories.
    if (!existsSync(entryDestDir)) {
      mkdirSync(entryDestDir, { recursive: true });
    }

    await fs.writeFile(entryDest, entry.getData());
  }
}

module.exports = {
  loadRequirementDefs,
  checkRequirement,
  checkAllRequirements,
  hasUnmetRequirements,
  installRequirementFromZip,
};
