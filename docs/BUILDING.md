# Building Tafreegh

Everything runs on Windows x64. There is no `engines` field: use a current Node.js LTS (typings target Node 24) and npm.

## Prerequisites

| Tool | Why |
|------|-----|
| Node.js LTS + npm | Electron, React, electron-vite, electron-builder |
| Python 3.12 | Only for `TAFREEGH_MOCK=1` UI work and `backend:test`; the packaged app installs its own |
| NVIDIA GPU + driver | Only for real transcription, not for building |
| `build/icon.ico` | Required by `win.icon`; must exist before packaging |

## Commands

```powershell
npm install

npm run dev            # electron-vite dev + Electron window
npm run typecheck      # tsc for tsconfig.node.json and tsconfig.web.json
npm test               # vitest run (tests/unit)
npm run test:watch     # vitest watch
npm run test:e2e       # npm run build && playwright test (tests/e2e)
npm run backend:test   # python -m pytest backend/tests -q

npm run build          # electron-vite build -> out/{main,preload,renderer}
npm run preview        # run the built app without packaging

npm run dist           # build + electron-builder --win (both targets)
npm run dist:msi       # build + electron-builder --win msi
npm run dist:nsis      # build + electron-builder --win nsis
```

`npm run dev` needs models for a real run. For UI-only work:

```powershell
$env:TAFREEGH_MOCK = "1"
npm run dev
```

Mock mode reports setup as complete, returns a fixed Arabic transcript and summary, skips GPU/model checks, and calls the system `py -3.12` for the worker, so the render step still produces a real HTML file. `TAFREEGH_DATA_DIR` can point the app at a scratch directory.

## Packaging

`electron-builder.yml` is the only packaging config: `appId` `com.tafreegh.app`, output `dist`, `files` = `out/**/*` + `package.json` (no sourcemaps), backend shipped as `extraResources` (`backend/` → `resources/backend`, minus caches/tests), `asar: true`, `publish: null`.

| Key | Value |
|-----|-------|
| `win.target` | `nsis` x64 and `msi` x64 |
| `artifactName` | `${productName}-${version}-setup-${arch}.${ext}` |
| `win.requestedExecutionLevel` | `asInvoker` |
| NSIS | per-user, `oneClick: false`, elevation allowed, install dir selectable, desktop + start-menu shortcuts named `تفريغ` |
| MSI | per-user, shortcuts, `runAfterFinish: true` |
| Both | `deleteAppDataOnUninstall: false` |

Produced files: `dist\Tafreegh-1.0.0-setup-x64.exe` and `dist\Tafreegh-1.0.0-setup-x64.msi`.

To ship both installers, either `npm run dist` or build each target. For a clean build:

```powershell
Remove-Item -Recurse -Force out, dist
npm run dist:nsis
npm run dist:msi
```

### Icon

`buildResources: build` plus `win.icon: build/icon.ico` make the ICO a hard requirement; a multi-resolution ICO (16/32/48/128/256 px) is what Windows expects. This repository currently contains no `build/icon.ico`, so packaging fails until one is added. No separate installer icons are configured, so the same file is used for the installer and shortcuts.

### Code signing

No certificate is configured, so both installers are **unsigned** by default and SmartScreen warns on first launch. To sign without editing the YAML, use electron-builder's standard environment variables:

```powershell
$env:CSC_LINK = "C:\certs\tafreegh.pfx"
$env:CSC_KEY_PASSWORD = "..."
npm run dist
```

Timestamping and EV certificates are release-process concerns, not build-config ones.

## CI outline

Windows-only is enough:

1. `actions/checkout` on `windows-latest`, `actions/setup-node` with npm cache, `npm ci`.
2. `npm run typecheck` and `npm test` (fast, no models, no GPU).
3. `npm run build`, then `npm run test:e2e` (runs under `TAFREEGH_MOCK=1`; keep `workers: 1`).
4. `npm run dist` with signing secrets (skip signing on pull requests).
5. Upload `dist/*.exe` and `dist/*.msi` as artifacts.

Never cache `%LOCALAPPDATA%\Tafreegh` or model directories: a CI run must not download the 12 GB Jais snapshot. `backend:test` additionally needs Python 3.12 and `pytest` on the runner (pytest is not in `backend/requirements.txt`).

## Testing an installer

```powershell
.\dist\Tafreegh-1.0.0-setup-x64.exe /S                 # NSIS, silent, per-user
msiexec /i .\dist\Tafreegh-1.0.0-setup-x64.msi /qn     # MSI, silent
```

Check: the app installs under `%LOCALAPPDATA%\Programs\Tafreegh\` by default, the `تفريغ` start-menu entry opens it, the wizard shows GPU and disk rows with the start button disabled when a check fails, `setup.json` appears after provisioning, a short file completes all six steps and writes `transcript.html` + `enhanced.m4a` + `transcript.txt`, the share menu saves exactly three files, and uninstalling leaves `%LOCALAPPDATA%\Tafreegh` intact.

Fast UI smoke test of an installed build:

```powershell
$env:TAFREEGH_MOCK = "1"
& "$env:LOCALAPPDATA\Programs\Tafreegh\Tafreegh.exe"
```

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `cannot find icon` while packaging | `build/icon.ico` is missing |
| `ENOENT ... python.exe` on a real run | setup incomplete; finish the wizard or check `runtime\venv` |
| Setup fails at `probe` | a worker package is missing from the venv (repaired once) or the interpreter is unusable |
| Setup stalls at `jais` | Hugging Face download interrupted; three attempts, then an error |
| Mock mode fails at `run` | no `py -3.12` on PATH |
| Blank result frame | `transcript.html` missing; inspect `jobs\<id>\job.log` |
