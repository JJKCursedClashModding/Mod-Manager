# JJK CC Mod Manager

[![Beta release](https://github.com/JJKCursedClashModding/Mod-Manager/actions/workflows/beta-release.yml/badge.svg)](https://github.com/JJKCursedClashModding/Mod-Manager/releases/tag/beta)

Electron desktop app for managing and installing mods for **Jujutsu Kaisen Cursed Clash**.

> Prefer a download over source? Grab the latest automated build from the [**beta** release](https://github.com/JJKCursedClashModding/Mod-Manager/releases/tag/beta) (NSIS installer, rebuilt on every push to `main`; filenames carry the UTC build date and commit).

It scans your mod folders, lets you enable/disable mods, checks required runtime components, and builds a merged mod package for `Content/Paks/~mods`.

## Quick Start (Players)

1. Install dependencies and launch the app:
   ```bash
   npm install
   npm start
   ```
2. On first launch, select `Jujutsu Kaisen CC.exe`.
3. Put your mods in the detected `Content/Mods` folder (or set an override in Settings).
4. Enable the mods you want in the list.
5. Click **Install enabled mods** to install them into `Content/Paks/~mods`.
6. Click **Play** to launch the game.

## Features

- Detects mods from your `Content/Mods` folder (or a custom override).
- Enable/disable individual mods, or toggle all mods at once.
- Shows per-mod content checklist:
  - `AssetRegistry.json`
  - prebuilt packages (`.pak/.utoc/.ucas`)
  - `assets/`
  - `datatables/`
  - `parameters/`
  - `pak_assets/`
  - `scripts/`
- Search, filter (All / Enabled / Disabled), and sort (priority / name / enabled-first) the mod library.
- Overlap detection: warns when enabled mods write to the same path or row (see below).
- Installs all enabled mods via one pipeline:
  - merges DataTable JSON files and patches cooked DataTables
  - merges AssetRegistry entries
  - stages loose assets
  - builds IoStore files (`.utoc/.ucas`) via `retoc`
  - builds registry `.pak` via `repak`
  - deploys output to game `Content/Paks/~mods`
- Supports packaging a single mod folder into a `.jjkmod` file (you pick the save location), and creating a default `manifest.json` from a mod's Tools menu.
- `.jjkmod` mod files: renamed zips containing a mod folder with `manifest.json`. Double-click one (or use **Add mod**) to install it into your library.
- Built-in requirements checker with optional install/download actions.
- Launch game directly from the app.

### `.jjkmod` files

A `.jjkmod` file is just a zip with a `.jjkmod` extension. It must contain either a single top-level mod folder or a root-level `manifest.json`. Installing from one follows the same rules as zip installs (newer `manifest.json` versions replace older ones, otherwise the install is skipped as up to date).

The Windows installer associates `.jjkmod` with the app, so double-clicking a `.jjkmod` file installs it (the app opens/focuses and asks for confirmation first). The **Add mod** picker accepts both `.jjkmod` and `.zip`.

Installing from a file shows a confirmation prompt with the mod title, its version, and any already-installed version status (new install, update, same-version reinstall, or older than installed), plus a reminder to only install mods from sources you trust.

> Note: file association is registered by the installer build (`npm run build`). A portable build (`npm run build:portable`) does not register associations — use **Add mod** there. The automated beta release ships the installer only.

## Requirements

- Windows
- `Jujutsu Kaisen CC.exe`
- Node.js + npm (for building/running from source)

The app also checks runtime modding dependencies from the Requirements modal, including:

- UTOC Signature Bypass

## Installation (From Source)

```bash
git clone --recurse-submodules <repo-url>
npm install
```

`postinstall` also installs dependencies for `AssetRegistryPatcher` and `CookedDatatablePatcher` (both are git submodules — on an existing clone run `git submodule update --init --recursive` if those folders are empty).

## Run

```bash
npm start
```

On first launch, select `Jujutsu Kaisen CC.exe` when prompted.

## Build

Create Windows installer:

```bash
npm run build
```

Create portable Windows build (local only, no file association):

```bash
npm run build:portable
```

The installer lands in `dist/`. Pushing to `main` publishes a fresh installer to the [beta release](https://github.com/JJKCursedClashModding/Mod-Manager/releases/tag/beta) automatically.

## Mod Folder Structure

Each mod should be a folder under your mods workspace (normally `.../Content/Mods/<ModId>`).  
A mod can contain any of the following:

- `manifest.json` (metadata: `title`, `description`, `version`, `priority`, `icon` — see below)
- `AssetRegistry.json` (array of asset registry entries)
- `assets/` (loose files mirroring game-relative content structure)
- `datatables/*.json` (merged by filename, then applied to cooked DataTables)
- `parameters/*.json` (merged by filename, then applied to cooked Blueprint parameter assets — see below)
- `pak_assets/` (files added into the generated registry pak)
- `scripts/` (ASI/DLL plugins + sidecars deployed to the game `scripts/` dir next to the exe for Ultimate ASI Loader)
- prebuilt package files in mod root:
  - `*.pak`
  - `*.utoc`
  - `*.ucas`

### manifest.json

```json
{
  "title": "My Cool Mod",
  "description": "What this mod does.",
  "version": "1.2.0",
  "priority": 10,
  "icon": "icon.png"
}
```

- `priority` (number, default `0`): higher wins when enabled mods overlap. Ties break alphabetically.
- `icon` (optional): image file **relative to the mod folder** (e.g. `"icon.png"`).
  Supported types: `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` `.svg` `.ico`, max 512 KB.
  Paths must stay inside the mod folder (`../` escapes are ignored). Mods without an icon get a letter tile.

### Overlaps

The toolbar shows a `⚠ N overlaps` button whenever **enabled** mods write to the same place:

- same datatable row key (`datatables/<Table>.json` → same top-level key),
- same parameter row key (`parameters/<name>.json` → same top-level key),
- same `assets/`, `pak_assets/`, or `scripts/` relative path,
- same `AssetRegistry.json` `objectName`,
- same prebuilt package file name in the mod root.

Click it (or a mod's `⚠ N overlaps` badge) to see each overlap and which mod wins.
The check reads only file paths and datatable row *keys* (never full asset bytes),
scans each mod once, and caches results — toggling mods recomputes instantly with no disk I/O.
Only enabled mods are checked; disabled mods never reach the packaging pipeline.

Example:

```text
MyCoolMod/
  manifest.json
  icon.png
  AssetRegistry.json
  assets/
    Jujutsu Kaisen CC/
      Content/
        Mods/
          MyCoolMod/
            SomeAsset.uasset
  datatables/
    AttackSetDataTable.json
  parameters/
    character.json
  scripts/
    MyPlugin.asi
  pak_assets/
    Jujutsu Kaisen CC/
      Config/
        DefaultEngine.ini
  MyCoolMod_P.pak
  MyCoolMod_P.utoc
  MyCoolMod_P.ucas
```

### parameters/*.json (new-character Blueprint rows)

Character mods register their characters as **data rows with literal values**
instead of shipping whole patched Blueprint assets (which would clobber each
other). Each file is a datatables-style row dump mapping a **new ID** to its
**complete row value** — no donors, no cloning. `$`-prefixed keys (e.g.
`$comment`) are author annotations and are ignored everywhere.

```json
// parameters/character.json
{ "CP_300": { "CommonMinimumDistanceOffset": { "X": 0, "Y": 0, "Z": -32 } } }
// parameters/sceneCapture.json
{ "CP_300": "/Game/Widgets/Commons/Parameters/GameWidgetCharacterSceneCapture_CP_010_BP" }
```

- `parameters/` holds one JSON per editable asset (short names):
  - `sceneCapture.json` → `GameWidgetSceneCaptureParameter_BP` (3D preview;
    keys are character IDs; values name the capture asset to reference — a
    short ID like `"CP_010"` or a full package path. The target must already
    be imported; all 48 vanilla capture assets are. Its Transform decides the
    preview framing; new per-character capture assets are not supported.)
  - `character.json` → `GameWidgetCharacterParameter_BP` (model-viewer
    framing; keys are character IDs; values are literal
    `GameWidgetCharaModelViewerParameter` structs, sparse OK)
  - `storyDemo.json` → `GameWidgetStoryDemoParameter_BP` (story-demo framing;
    keys are character IDs; literal `GameStoryDemoCharacterParameter` structs)
  - `exchangeImage.json` → `GameWidgetExchangeImageParameter_BP` (per-costume
    UI image offsets; keys are costume IDs like `CP_300_00`). Values are
    `{ "Offset": {X,Y}, "entries"?: {...} }`: without `entries` the row
    goes to all 19 image-type entries, with an `entries` map
    (`{ "<Entry>": {X,Y} }`, `E…::` prefix optional) it goes to exactly those
    entries with per-entry offsets.
  - `dynamicIcon.json` → `GameWidgetDynamicIconParameter_BP` (input-guide
    icon fallbacks; keys are costume IDs; literal
    `GameWidgetFallbackInputGuideParameter` structs)
- Unknown struct fields and unknown image entries are build errors that list
  the valid names. A key that already exists in the base asset is a build
  error (new characters must use new IDs); the same new key in several mods
  resolves by priority with a visible warning.
- Merged rows are written into pristine bases (`data/parameters/`, verified
  by SHA-256 in `base-manifest.json` — a mismatch stops the build with a
  re-extract hint) and staged at
  `Jujutsu Kaisen CC/Content/Widgets/Commons/`. Nothing is emitted when no
  enabled mod contributes rows.
- Do **not** ship these 5 assets whole under `assets/` anymore — the merged
  output overwrites them and the build logs a warning telling you to migrate
  the rows to `parameters/`.
- Full working example: the Urame mod's `parameters/` folder (all 5 files
  with literal values for CP_300 + 30 costumes).

## Packaging Behavior

When you click **Install enabled mods**, the app:

1. Resolves enabled mods and applies mod priority (low to high, high priority wins on conflicts).
2. Clears the game `Content/Paks/~mods` folder for a clean deployment.
3. Clears any stale `Content/DataTables/_ModManager` folder from older installs.
4. Combines `datatables/*.json` into a temp patch set.
5. Builds merged `AssetRegistry.bin`.
6. Stages loose assets from enabled mods.
7. Patches cooked tables from `data/datatables` into staging (after assets, so JSON patches win over any cooked DataTables shipped in `assets/`).
8. Combines `parameters/*.json` into a temp patch set, then patches the pristine cooked Blueprint parameter assets from `data/parameters` into staging (after assets, so merged rows win over any whole parameter asset shipped in `assets/` — which also logs a migration warning).
9. Produces:
   - `build/output/zModLoader_P.pak`
   - `build/output/zModLoader_P.utoc`
   - `build/output/zModLoader_P.ucas`
10. Copies generated files (plus any mod prebuilt packages) to:
    - `Content/Paks/~mods`

## Project Scripts

- `npm start` - build patchers then launch Electron app
- `npm run patcher:build` - build `AssetRegistryPatcher` and `CookedDatatablePatcher`
- `npm run build` - package app via `electron-builder` (Windows x64)
- `npm run build:portable` - portable Windows package

## Repository Layout

- `main.js` - Electron bootstrap
- `preload.js` - secure IPC bridge to renderer
- `lib/` - packaging pipeline, IPC handlers, helpers
- `renderer/` - UI markup, styles, frontend logic
- `AssetRegistryPatcher/` - registry patcher project
- `CookedDatatablePatcher/` - cooked DataTable patcher project
- `data/` - baseline data (including `DefaultGame.ini`, cooked datatables, and cooked Blueprint parameter bases + `base-manifest.json`)
- `tools/` - external tool binaries/resources used by packaging

## Notes

- Build outputs and generated mod artifacts are intentionally ignored via `.gitignore` (`build/`, `mods/`, `node_modules/`, `dist/`).
- See [CHANGELOG.md](./CHANGELOG.md) for what changed in each release.

## Credits

This project utilizes the following open-source components:

* **[UniversalSigBypasser](https://github.com/rm-NoobInCoding/UniversalSigBypasser)** by [rm-NoobInCoding](https://github.com/rm-NoobInCoding)
  * Licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
* **[CookedDatatablePatcher](https://github.com/JJKCursedClashModding/CookedDatatablePatcher)** by [JJKCursedClashModding](https://github.com/JJKCursedClashModding)

