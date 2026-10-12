# Remote host mode (experiment/remote-host)

Run the mod-manager backend on the PC that has the game, drive it from a
browser on another PC on the same LAN (remote-IDE style).

> ⚠️ Prototype. The API can read/write files and spawn packaging tools on the
> host — serve on LAN / Tailscale only, **always with `--token`**, never the
> open internet.

## Host (game PC, Windows)

```powershell
npm run remote-host -- --port 3131 --token <secret>
```

- Serves the UI at `http://<host-ip>:3131/`
- `AUTH_TOKEN` env var works too (`REMOTE_TOKEN=<secret> npm run remote-host`)
- No token = open LAN mode (startup warns). Don't do this beyond a quick test.
- Same config/user-data as the desktop app (shared `config.json`).

## Client (any PC with a browser)

1. Open `http://<host-ip>:3131/`
2. If prompted, the banner's **Set host/token** stores them in `localStorage`
   (or append `?host=http://<host-ip>:3131&token=<secret>` to the URL once).
3. Everything runs against host paths — packaging, requirements, setup
   wizard all act on the **host's** game install.

## How it works

- `server.js` — zero-dependency Node HTTP server reusing `lib/*` directly.
  `POST /api/<method>` mirrors the Electron IPC channels, `GET /events`
  streams `package-progress` over SSE, `POST /upload` / `GET /download`
  move `.jjkmod`/`.zip` files across the network.
- `renderer/remote-api.js` — browser shim implementing the same
  `window.modManagerApi` shape as `preload.js` (fetch + EventSource). No-op
  under Electron. `renderer.js` is untouched.
- `lib/platform.js` — Electron-optional `userData` dir / version / shell so
  `lib/*` runs headless. `config.js` + `ipcHandlers.js` now use it; local
  Electron behavior is unchanged.

## Known limitations (follow-ups)

- Path pickers are `prompt()`s for host-local paths — no remote file browser yet.
- `Open folder` buttons are acknowledged no-ops (folders live on the host).
- `Play` launches the game **on the host**.
- `install-mod-from-zip` uses a local file picker + upload under the hood.
- `package-single-mod` auto-downloads the `.jjkmod` to the client after the
  host builds it.
- Single shared-secret auth; per-user accounts / TLS are out of scope.
- `server.js` dedups some glue from `ipcHandlers.js` — extracting a shared
  `lib/services.js` is the natural cleanup before merging.
