# Architecture

Tafreegh is a three-process Electron app plus a short-lived Python worker. The renderer never touches the filesystem; the main process owns files and network, and the worker is invoked per stage.

```
renderer (sandboxed) --typed IPC--> main (Node) --spawn--> Python worker (venv)
        |                              |                      |
        |                    jobs/, settings.json,            JSONL events on a
        |                    secrets.json, history.json       duplicated fd
        +-- iframe: tafreegh://job/<id>/transcript.html
```

## Process model

| Process | Entry | Responsibility |
|---------|-------|----------------|
| Main | `src/main/index.ts` | Window, `tafreegh://` handler, CSP headers, single-instance lock, file-open arguments, service wiring |
| Preload | `src/preload/index.ts` | `contextBridge` surface only: `window.tafreegh` (`app`, `setup`, `jobs`, `settings`, `providers`) |
| Renderer | `src/renderer/src/App.tsx` | React 19 UI, Zustand store, RTL styling; no Node APIs |
| Worker | `backend/worker.py` | One CLI subcommand per invocation: `probe`, `models-status`, `setup-models`, `run`, `render` |

The window uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. Hardware acceleration is disabled on purpose: the 4-bit ASR model needs nearly all VRAM on a 6 GB card and the UI composites fine in software.

Services in `src/main/services/`: `paths` (all data paths, `MOCK` flag), `setup` (runtime + model provisioning, GPU/disk probes), `worker` (spawn + JSONL parsing), `jobs` (queue, progress mapping, render, exports), `summarize` (chunking, map-reduce, moments), `providers` (catalog + HTTP), `settings` (settings + encrypted secrets), `history` (index, reconciliation, interrupted-job recovery).

## Typed IPC

`src/shared/ipc.ts` holds channel names, `src/shared/api.ts` declares `TafreeghAPI`, and the preload implements exactly that interface — no raw `ipcRenderer`. Events flow main → renderer via `broadcast()` on `jobs:event` and `setup:event`; `subscribe()` returns an unsubscribe function.

Every handler in `src/main/ipc.ts` validates arguments with Zod: `settingsPatchSchema` (strict; language enum, dialect 1–8, temperature 0–1.5, maxTokens 256–16000), `startSchema` (path 3–2048, language 1–8, boolean), provider query schemas (15-id enum, baseUrl ≤ 300, key ≤ 500), job ids 4–64, export kind enum. URLs must be `http(s)`; revealed paths must stay under the data root. Validation errors are Arabic user-facing strings.

## Python worker protocol

The worker duplicates fd 1 for events, then points fd 1 at stderr so library prints cannot corrupt the channel. The main process parses each line as JSON; non-JSON becomes a log entry.

| Event | Payload |
|-------|---------|
| `progress` | `stage`, `overall` (worker-local 0–100), `stageFraction`, `indeterminate`, `message`, optional `window`/`windows` |
| `log` | `message` |
| `setup` | `phase`, `pct`, `bytesDone`, `bytesTotal`, `message` |
| `done` | `result`, `elapsed` |
| `error` | `message`, `errorType`, `traceback` (last 8000 chars) |
| `cancelled` | emitted on `KeyboardInterrupt` |

Environment: `cwd=backend`, `PYTHONUNBUFFERED=1`, `PYTHONUTF8=1`, `NEMO_DIAR_DEVICE=cpu`, `JAIS_LOCAL_DIR=<models>/jais-asr`, `TAFREEGH_DATA_DIR=<root>`. Cancellation is `taskkill /T /F` on Windows, `SIGTERM` elsewhere.

## Job pipeline and progress

`JobService` runs one job at a time from an in-memory queue: `queued → running → summarizing → rendering → done` (or `error` / `cancelled`).

The worker derives `overall` from `STAGE_RANGES` in `pipeline.py`; the main process rescales it:

| Worker stages | Worker range | UI overall |
|---------------|--------------|------------|
| copy, decode, enhance, diarize, load, transcribe, audio, artifacts | 0–100 (`copy` 0–2 … `artifacts` 94–100) | `2 + overall × 0.76` (2–78) |
| summary (main) | — | fixed 80, indeterminate |
| render (main) | — | `92 + overall × 0.07` (92–99) |
| done | — | 100 |

`ProgressView` groups these into six steps: decode, enhance, diarize, transcribe (`load`+`transcribe`), summary, render (`audio`+`artifacts`+`render`+`done`).

Pipeline detail:

1. **decode** — ffmpeg (imageio-ffmpeg) to mono 16 kHz.
2. **enhance** — `noisereduce` spectral gating, speech-band biquads, RMS compression/AGC. Torch-free by design: no neural denoiser and no CUDA wheels in Python.
3. **diarize** — downloaded `nemo-speech` binary runs `diarize --format rttm --model nvidia/Nemotron-3-Diarization`; RTTM turns are parsed.
4. **windowing** — turns merge across gaps ≤ 15 s, need ≥ 3 s of speech, are padded ±1 s, then sliced into 30 s windows.
5. **transcribe** — Jais-ASR GGUF through the bundled `llama-server` (Q4_K_M or Q8_0), window audio written as 16 kHz WAV, language pinned with the code-switch prompt.
6. **audio** — enhanced signal → mono AAC 64 kbit/s 44.1 kHz, trimmed to speech ±1 s; copied to `enhanced.m4a` and embedded as base64.
7. **artifacts** — base HTML (clause spans with `data-start`/`data-end`), `transcript.txt`, `transcript.json`.

## Summary providers

`PROVIDERS` is a static catalog of 15 entries: 5 local (`ollama`, `lmstudio`, `llamacpp`, `vllm`, `custom`) and 10 cloud. Each declares `kind`, `requiresKey`, `defaultBaseUrl`, model suggestions and docs URL.

`ProvidersService.complete()` resolves base URL, model and key (request → settings → catalog default), then dispatches by protocol:

- **OpenAI-compatible** (most cloud, all local): `POST {base}/chat/completions`; `max_completion_tokens` for OpenAI `o*`/`gpt-5*`, otherwise `max_tokens`.
- **Anthropic**: `POST {base}/messages` with `x-api-key` and `anthropic-version: 2023-06-01`.
- **Google**: `POST {base}/models/{model}:generateContent?key=…` with `systemInstruction`.

Timeouts are 180 s per call with linear-backoff retries (`retries` defaults to 2). Error bodies are redacted (key and `sk-…`) and truncated before reaching the UI. Model listing uses `/models`, `/api/tags` for Ollama first, and Gemini's `models` endpoint.

### Ollama lifecycle (`services/ollama.ts`)

Local summaries need no terminal steps:

- **Start**: if `/api/tags` does not answer and the base URL is loopback, `ollama serve` is spawned detached from the install location (`%LOCALAPPDATA%\Programs\Ollama`, Program Files, or `PATH`) and polled for up to 25 s. Remote base URLs are never started.
- **Pull**: a missing tag is downloaded through `POST /api/pull` (NDJSON stream), with `%` progress forwarded to the job's progress message. A `Test` button sets `autoPull: false` so it never downloads gigabytes.
- **Chat**: `POST /api/chat` with `options.num_ctx` (8192, `TAFREEGH_OLLAMA_CTX` overrides) instead of the OpenAI-compatible endpoint, because `/v1` ignores `num_ctx` and Ollama defaults to a 4096-token window that truncates Arabic transcripts. `think: false` keeps `num_predict` for the answer instead of hidden reasoning (gemma4 and qwen3 spend the whole map budget on it and return empty content); a reasoning-only build that rejects the flag is retried without it. Falls back to `/v1/chat/completions` when a proxy has no native API (404).
- **Release**: after the summary (or a test) `POST /api/generate { keep_alive: 0 }` unloads the model, so a following transcription is not competing for VRAM on 6 GB cards.

`summarizeTranscript` takes an `onStatus` callback, which `jobs` maps onto the summary stage progress; that is how "تنزيل … 42%" reaches the UI.

`summarize.ts` renders lines as `[mm:ss] Speaker: text`. Chunk size follows the provider: 12,000 characters for a local model, 42,000 for cloud, because Arabic costs ~3 characters per token and the local window is 8192 — a 42k chunk plus the prompt overflowed and the daemon silently dropped the system rules, which is what made small models answer in their own format. Notes are capped at ~3,500 tokens in total for local runs by shrinking per-chunk `num_predict`. Each chunk gets a map prompt that must keep names, numbers, decisions and timestamps; merged notes feed a reduce prompt returning Arabic markdown (overview, key points with timestamps, action points). The reduce prompt lives in the system message and defines the key-moment criteria explicitly (critique, decision, assignment, recommendation, definition, decisive number, topic shift), the label shape (3–8 word noun phrase, no speaker, no question mark) and the heading format; headings without a time range and `###` outlines are rejected. Moments come from `**Title (mm:ss–mm:ss):**` headings, else bullet timestamps, else sampled lines (2–12). A summary failure never fails the job: `summaryError` is stored, status is `done`, and retry reuses `transcript.json`.

## HTML rendering

`pipeline.build_outputs()` writes a functional self-contained player (audio data URI, speaker colors, click-to-seek clauses). `render.py` then:

1. `add_summary.inject_html()` appends the summary card (markdown-lite, `- [ ]` checkboxes persisted in `localStorage`); `inject_txt()` adds a bidi-marked summary to the TXT.
2. `_move_summary_to_top()` moves `<section class="summary" id="recording-summary">` (with its script) before `<main>`, giving summary-then-transcript order and 01/02/03 numbering.
3. `apply_ui.apply()` rebuilds the chrome in place: drafting-sheet theme, inlined Cairo/Archivo/JetBrains fonts from `backend/assets/fonts`, key-moments rail, title block, colophon.

The app shows the same file through `tafreegh://job/<id>/transcript.html`.

### Speaker names

`apply_ui` builds a speaker strip inside the sticky `.playerbar` (so it is pinned under the player) with one chip per speaker, plus a `<script type="application/json" id="ui-speaker-names">` block. Clicking a chip swaps its label for an inline input; Enter commits, Escape cancels, and the committed map is posted to the parent window. The renderer forwards it to `jobs:rename-speakers`, which:

1. sanitises the map (letters A-H, 40 characters, single spaces),
2. stores it as `JobSummary.speakerNames` in `meta.json` (without touching `updatedAt`, so the result iframe is not remounted mid-edit),
3. rewrites the JSON block inside `transcript.html` so the file itself carries the names (also for exports and for `Open in browser`).

`render` passes `--speaker-names` on a summary retry, and `apply_ui.apply()` falls back to the names already in the page when the flag is absent, so a re-render never drops them. Palette: `pipeline.SPEAKER_COLORS` and `apply_ui.PALETTE` are the same eight high-contrast colours (blue, teal, purple, magenta, amber, green, cyan, slate); a backend test pins the two maps equal. Colour is not the only cue — named speakers are also disclosed as `title` on each clause.

## Model setup

`SetupService.start()` is sequential and abortable:

1. **check** - `nvidia-smi --query-gpu=name,memory.total,driver_version`; free space via `statfs`, compared against `requiredDiskGb()` (7 GB runtime + artifact size + 2 GB, or just the artifact when the engine is already installed).
2. **uv** — pinned `uv 0.13.6` zip from GitHub, `.sha256` verified, extracted to `runtime/uv`.
3. **python** — `uv python install 3.12` into `runtime/python`, then `uv venv runtime/venv`.
4. **deps** — `backend/requirements.txt` only (numpy/scipy/soundfile/noisereduce/huggingface_hub). No torch, no CUDA wheels.
5. **probe** — worker `probe`; hardware facts come from `nvidia-smi` + llama.cpp, so a missing CUDA package can no longer appear here. Missing worker packages are repaired once.
6. **jais** — `snapshot_download` of the collection artifact chosen for this device (see below) into `models/jais-asr`, three attempts, progress polled from directory size.
7. **diarizer** — warm-up `nemo-speech` run on a synthetic WAV; binary and weights land in the app-owned nemo-speech folders.

`setup.json` stores `completed` plus the probe result, while `status()` recomputes everything from disk, so a deleted model re-opens the wizard.

## Model locations

Each model can be downloaded on its own or borrowed from disk (`models.json` holds `diarizerModel`; Jais keeps its folder in `setup.json` as `jaisDir`):

| Model | Default | Borrowed form |
|-------|---------|---------------|
| Jais-ASR | `models/jais-asr` | a complete GGUF pair (model + `mmproj`) |
| Diarizer | `models/nemo-diarization` (passed to nemo-speech as `NEMO_SPEECH_MODEL_DIR`) | a `.gguf` passed to nemo-speech as `--model` |

Downloads clear the borrowed path for that model first, so "download" explicitly means "use the app's copy". The nemo-speech *runtime* is unpacked into `bin/nemo-speech/<version>`; older builds kept it in `~/.cache/arabic-transcribe` and the diarizer in `%LOCALAPPDATA%\NeMoSpeech\models`, and both are moved into the app folder on first use (the legacy paths stay in the status scan so an upgrade still sees them).

### Jais-ASR artifacts

`JAIS_VARIANTS` (mirrored in `pipeline.py` and `services/engine.ts`) lists the GGUF entries of the [Jais Speech collection](https://huggingface.co/collections/IFM/jais-speech) our runtime can execute:

| id | repo | download | WER | chosen when |
|----|------|----------|-----|-------------|
| `gguf` | `IFM/Jais-ASR-GGUF` (Q4_K_M + `mmproj` Q6_K) | 3.7 GB | 22.99 | GPU llama runtime and VRAM < 9 GB (stays 4-bit in memory) |
| `gguf-q8` | `IFM/Jais-ASR-GGUF` (Q8_0 + `mmproj` F16) | 6.7 GB | 22.83 | GPU llama runtime and 9–12.5 GB VRAM (BF16-level accuracy, ~7.6 GB resident) |

Only these two artifacts are shipped or accepted: no safetensors, FP8, W4A16 or BF16 path exists in the app. One managed slot (`models/jais-asr`) is kept: switching artifacts deletes the previous weight files after the new one verifies, and `detect_jais_variant` reads the GGUF pair to name what is installed.

The GGUF path is served by `resources/llama/llama-server.exe`. Upstream llama.cpp cannot read Jais-ASR's `jais-asr` audio projector (`load_hparams: unknown projector type: jais-asr`, verified on b12061), so the runtime is built from the MBZUAI-IFM fork (`model/K2Horizon`, commit `35999d1`) with `llama.cpp-jais-asr.patch`; the fork also predates the K2-Horizon pre-tokenizer, so `patches/llama-k2-splitter.patch` ports it (MSVC's `std::regex` rejects `\p{..}`/`\u200C`). `scripts/build-llama.ps1 -Backend vulkan|cuda|cpu` reproduces the build.

`services/engine.llamaServerPath()` resolves the runtime (packaged `resources/llama`, dev `app.getAppPath()/resources/llama`, or `TAFREEGH_LLAMA_SERVER`) and `worker.ts` exports it. `jais_gguf.py` starts one server per job on a free loopback port (`-ngl 999`, `-c 2048`, `--device` pinned to the discrete GPU), waits on `/health`, posts each 16 kHz window to `/v1/audio/transcriptions`, and stops the process afterwards.

Those requests also carry `prompt=[Code-switch]` (`jais_gguf.CODE_SWITCH_PROMPT`). In the Jais-ASR chat template an explicit system message *is* the mode switch, so `[Code-switch]` reproduces the model card's `code_switch=True`: Arabic stays in Arabic script while English/French/Spanish/Italian spans stay verbatim, i.e. Latin script, instead of being transliterated into Arabic letters. Without it the model writes `presentation` as `البريزنتيشن`. `transcribe(..., prompt="")` opts out. `backend.txt` records the backend: GGUF is only picked automatically with `vulkan`/`cuda`, because a CPU build transcribes a 30 s window in ~110 s (measured) while the bundled Vulkan build needs ~16 s (measured, Q4_K_M, RTX 4050 6 GB) and a full 75 s job finishes in 118 s.

The bundled runtime is the Vulkan build (73.5 MB) so NVIDIA and AMD GPUs work through their normal driver, with no CUDA toolkit on the user's machine. `scripts/build-llama.ps1 -Backend vulkan` needs the LunarG SDK (`VULKAN_SDK`, `CMAKE_PREFIX_PATH`, `SPIRV-Headers_DIR`); `cuda` and `cpu` are also supported for locally built runtimes.

## Security boundaries

- **CSP**: packaged builds add `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` (plus inline styles/fonts and `frame-src tafreegh:`) to every non-`tafreegh:` response. Rendered transcripts get a stricter policy — `default-src 'none'` with inline style/script and `data:` media only, because the audio is a data URI.
- **`tafreegh://`**: hostname must be `job`; the first segment is a job id validated by `jobDir()` (`^[a-z0-9-]{8,64}$`); the decoded path is normalized and must stay inside that job directory, else 403. Unknown extensions are `application/octet-stream`; responses are `no-store`.
- **Navigation**: `will-navigate` is cancelled unless it targets the current URL; `setWindowOpenHandler` denies windows and only forwards `http(s)` links to the OS browser.
- **Permissions**: all permission requests and checks are denied.
- **Filesystem**: `revealPath` is confined to the data root; output is opened with `shell.openPath` on a known job file.
- **Secrets**: `safeStorage.encryptString` → base64 in `secrets.json`; when OS encryption is unavailable the value is stored as `plain:`-prefixed base64 and `secure: false` is recorded.

## Storage layout

Everything lives under `%LOCALAPPDATA%\Tafreegh`: `settings.json`, `secrets.json`, `history.json`, `setup.json`, `runtime\` (uv, uv-cache, python, venv), `models\` (`jais-asr\`, `nemo-diarization\`), `bin\nemo-speech\<version>\`, `jobs\<id>\` (`meta.json`, `job.log`, `transcript.{html,txt,json}`, `summary.md`, `enhanced.m4a`, `moments.json`) and `logs\`. Nothing a download produces lives outside this folder, so both installers can remove it on uninstall: NSIS via `build/installer.nsh` (`customUnInstall`, skipped when `${isUpdated}`), MSI via the `msiProjectCreated` hook in `scripts/msi-cleanup.cjs`, which appends a deferred `rmdir /s /q "[LocalAppDataFolder]Tafreegh"` guarded by `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE AND NOT REINSTALL AND NOT WIX_UPGRADE_DETECTED`. The `REINSTALL` clause matters: a Windows "Repair" sets `REINSTALL=ALL` together with `REMOVE=ALL`, and without it a repair would delete every downloaded model.

Upgrades from 0.9.x run a one-time `cleanupLegacyTorch()` on startup: it deletes `models\resemble-enhance`, the legacy HF cache copy, and uninstalls `torch`/`torchaudio`/`resemble-enhance` from the interpreter the app uses. Each delete retries five times because Windows holds handles on freshly downloaded weights (Defender/indexer), and a step that still fails is logged to `logs\cleanup.log` instead of aborting the rest. `runtime\torch-free.json` is only written once the app-owned folders are actually gone, so a transient lock is retried on the next launch.

Job ids are `<base36 timestamp>-<8 hex>`; job directories are reconciled into `history.json` at startup and any job left active is marked interrupted.
