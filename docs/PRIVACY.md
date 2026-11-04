# Privacy

Tafreegh is built around one rule: the recording stays on the machine. Audio decoding, enhancement, diarization and transcription never use the network. The only outbound traffic is the one-time provisioning download and, if you configure one, the summarizer you choose.

## Local processing

| Step | Where it runs | Network |
|------|---------------|---------|
| Import, decode, enhance, diarize, transcribe, render | local (GPU/CPU) | none |
| Summary | your chosen provider | local endpoint or the provider's API |

There is no microphone capture: the app only reads files you drop or pick. All renderer permissions (camera, microphone, notifications, geolocation, etc.) are denied at the session level.

The finished HTML embeds the processed audio as a base64 data URI, so sharing that single file also shares the audio. The `.txt` and `.m4a` exports are separate, explicit choices.

## Network calls

| When | Destination | What is sent / received |
|------|-------------|-------------------------|
| First run, runtime | `github.com/astral-sh/uv` releases | download `uv 0.13.6` zip + `.sha256` (checksum verified) |
| First run, Python | managed by `uv` (Python builds) | download Python 3.12 |
| First run, libraries | `pypi.org` | download packages from `backend/requirements.txt` |
| First run, ASR model | Hugging Face | download the GGUF pair for the chosen quant (3.7 GB or 6.7 GB) |
| First run, diarizer | `github.com/NVIDIA/NeMo-Speech.cpp` releases, then Hugging Face | download the `nemo-speech` binary (SHA-256 checked) and `nvidia/Nemotron-3-Diarization` weights |
| Settings, "fetch models" | the selected provider's `/models` (Ollama: `/api/tags`) | API key header only; no transcript |
| Settings, "test connection" | the selected provider | a two-word prompt (`اكتب: جاهز`) |
| Job, summary step | the selected provider's chat endpoint | the transcript text, see below |

No other hosts are contacted. Specifically: no telemetry, no analytics, no crash reporting, no update check, no license server, no account. `publish` is `null` in `electron-builder.yml`, and the main process contains no auto-updater.

### What the summarizer receives

`summarize.ts` builds a plain-text transcript:

```
عنوان التسجيل: <recording title> | المدة: mm:ss | المتحدثون: Speaker A، Speaker B

[00:00] Speaker A: ...
[00:12] Speaker B: ...
```

The recording title is the file name without its extension. Speaker labels are anonymous (`Speaker A`, `Speaker B`, …) and timestamps are relative to the trimmed audio. Long transcripts are split into ~42,000-character chunks; each chunk is sent separately for note-taking, then the collected notes are sent once more for the final summary. The system prompt forbids inventing information and asks for Arabic output.

Audio, the source file itself, its full path, and the enhanced `.m4a` are never part of any request.

Which endpoint receives that text is entirely your choice:

- **Local** — Ollama (`127.0.0.1:11434`), LM Studio (`127.0.0.1:1234`), llama.cpp (`127.0.0.1:8080`), vLLM (`127.0.0.1:8000`), or any OpenAI-compatible server. Nothing leaves the machine.
- **Cloud** — OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, OpenRouter, xAI, Together, Fireworks. Those requests are governed by that provider's terms and retention policy.
- **None** — with no provider configured, the transcript is still produced and no summary request is made.

## Key storage

- Keys are stored in `%LOCALAPPDATA%\Tafreegh\secrets.json`, encrypted with Electron `safeStorage` (Windows DPAPI, bound to the current user account) and kept as base64.
- If OS encryption is unavailable, the store falls back to base64 with a `plain:` prefix and records `secure: false`; the UI still shows the key as stored, and `ARCHITECTURE.md` documents this fallback.
- Keys are only read when a request is made, and are sent only to the provider they belong to, in the `Authorization: Bearer` header (or `x-api-key` for Anthropic, or a query parameter for Gemini).
- Error messages returned to the UI are redacted: the key itself and anything matching `sk-…` is replaced before display, and messages are truncated to 700 characters.
- Keys are never written to `job.log`, `settings.json`, or the rendered HTML. Clearing a key in Settings deletes it from `secrets.json`.

## Deleting data

| What | How |
|------|-----|
| One recording | Sidebar → trash icon; removes `jobs\<id>\` (audio, HTML, TXT, JSON, summary, log) and its history entry |
| All models | Settings → Engine → "delete models"; removes `models\jais-asr`, `models\nemo-diarization`, `bin\nemo-speech`, the legacy shared caches, `models.json`, and `setup.json` |
| Everything | Quit the app, then delete `%LOCALAPPDATA%\Tafreegh` |
| Diarizer caches | The in-app action removes the app-owned `models\nemo-diarization`, plus the legacy `%LOCALAPPDATA%\NeMoSpeech\models` / `%USERPROFILE%\.cache\NeMoSpeech\models` folders |
| Old denoiser (upgrades) | The first launch after an upgrade deletes `models\resemble-enhance` and uninstalls `torch`/`torchaudio`/`resemble-enhance` from the interpreter the app uses |

Uninstalling the app deletes `%LOCALAPPDATA%\Tafreegh` — both installers do it (NSIS `customUnInstall`, MSI cleanup action), except when the uninstall is the first step of an upgrade, where the new version keeps the models it already has. Uninstall is therefore a full clean removal; copy anything you want to keep first.

Every download the app performs lands inside `%LOCALAPPDATA%\Tafreegh`: the GGUF pair in `models\jais-asr\`, the diarizer in `models\nemo-diarization\`, and the nemo-speech runtime in `bin\nemo-speech\<version>\`.

## Summary for the impatient

- Audio: local only, never uploaded.
- Network: first-run downloads plus the summarizer you explicitly configure.
- Cloud summarizer sees transcript text (including speaker labels, timestamps and the file-derived title), not audio.
- API keys: OS-encrypted, never logged, deletable from Settings.
- Telemetry: none.
