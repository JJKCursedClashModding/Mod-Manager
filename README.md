# JJK CC Mod Manager

[![Beta release](https://github.com/JJKCursedClashModding/Mod-Manager/actions/workflows/beta-release.yml/badge.svg)](https://github.com/JJKCursedClashModding/Mod-Manager/releases/tag/beta)

Electron desktop app for managing and installing mods for **Jujutsu Kaisen Cursed Clash**.

> Prefer a download over source? Grab the latest automated build from the [**beta** release](https://github.com/JJKCursedClashModding/Mod-Manager/releases/tag/beta) (installer + portable exe, rebuilt on every push to `main`; filenames carry the UTC build date and commit).

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
  - `pak_assets/`
- Installs all enabled mods via one pipeline:
  - merges DataTable JSON files and patches cooked DataTables
  - merges AssetRegistry entries
  - stages loose assets
  - builds IoStore files (`.utoc/.ucas`) via `retoc`
  - builds registry `.pak` via `repak`
  - deploys output to game `Content/Paks/~mods`
- Supports packaging a single mod folder into a zip file.
- `.jjkmod` mod files: renamed zips containing a mod folder with `manifest.json`. Double-click one (or use **Add mod**) to install it into your library.
- Built-in requirements checker with optional install/download actions.
- Launch game directly from the app.

### `.jjkmod` files

A `.jjkmod` file is just a zip with a `.jjkmod` extension. It must contain either a single top-level mod folder or a root-level `manifest.json`. Installing from one follows the same rules as zip installs (newer `manifest.json` versions replace older ones, otherwise the install is skipped as up to date).

The Windows installer associates `.jjkmod` with the app, so double-clicking a `.jjkmod` file installs it (the app opens/focuses and reports the result). The **Add mod** picker accepts both `.jjkmod` and `.zip`.

> Note: file association is registered by the installer build (`npm run build`). Portable builds do not register associations — use **Add mod** there.

## Requirements

- Windows
- `Jujutsu Kaisen CC.exe`
- Node.js + npm (for building/running from source)

The app also checks runtime modding dependencies from the Requirements modal, including:

- UTOC Signature Bypass

## Installation (From Source)

```bash
npm install
```

`postinstall` also installs dependencies for `AssetRegistryPatcher` and `CookedDatatablePatcher`.

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

Create portable Windows build:

```bash
npm run build:portable
```

## Mod Folder Structure

Each mod should be a folder under your mods workspace (normally `.../Content/Mods/<ModId>`).  
A mod can contain any of the following:

- `manifest.json` (metadata: `title`, `description`, `version`, `priority`, `icon` — see below)
- `AssetRegistry.json` (array of asset registry entries)
- `assets/` (loose files mirroring game-relative content structure)
- `datatables/*.json` (merged by filename, then applied to cooked DataTables)
- `pak_assets/` (files added into the generated registry pak)
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
- same `assets/` or `pak_assets/` relative path,
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
  pak_assets/
    Jujutsu Kaisen CC/
      Config/
        DefaultEngine.ini
  MyCoolMod_P.pak
  MyCoolMod_P.utoc
  MyCoolMod_P.ucas
```

## Packaging Behavior

When you click **Install enabled mods**, the app:

1. Resolves enabled mods and applies mod priority (low to high, high priority wins on conflicts).
2. Clears the game `Content/Paks/~mods` folder for a clean deployment.
3. Clears any stale `Content/DataTables/_ModManager` folder from older installs.
4. Combines `datatables/*.json` into a temp patch set.
5. Builds merged `AssetRegistry.bin`.
6. Stages loose assets from enabled mods.
7. Patches cooked tables from `data/datatables` into staging (after assets, so JSON patches win over any cooked DataTables shipped in `assets/`).
8. Produces:
   - `build/output/zModLoader_P.pak`
   - `build/output/zModLoader_P.utoc`
   - `build/output/zModLoader_P.ucas`
9. Copies generated files (plus any mod prebuilt packages) to:
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
- `data/` - baseline data (including `DefaultGame.ini` and cooked datatables)
- `tools/` - external tool binaries/resources used by packaging

## Notes

- Build outputs and generated mod artifacts are intentionally ignored via `.gitignore` (`build/`, `mods/`, `node_modules/`, `dist/`).
- This repository currently has active local changes; if you plan to commit this README separately, stage only `README.md`.

## Credits

This project utilizes the following open-source components:

* **[UniversalSigBypasser](https://github.com/rm-NoobInCoding/UniversalSigBypasser)** by [rm-NoobInCoding](https://github.com/rm-NoobInCoding)
  * Licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)
* **[CookedDatatablePatcher](https://github.com/JJKCursedClashModding/CookedDatatablePatcher)** by [JJKCursedClashModding](https://github.com/JJKCursedClashModding)

