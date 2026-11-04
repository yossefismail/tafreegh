# Tafreegh 0.9.9

Tafreegh turns Arabic audio into a readable, speaker-labelled transcript on the desktop, fully offline once the
models are downloaded. Version 0.9.9 is a polish release: the exported transcript HTML now carries an editable
speaker strip that keeps the names you type, speakers get eight distinct high-contrast colours, the GPU row
reports the acceleration backend that is actually in use, and the interface is snapped to a consistent 40px
grid with bidi fixes in the progress header.

## Highlights

- Speaker strip with click-to-rename. Names are stored inside the exported HTML file itself, so a transcript
  keeps its labels when you move it to another machine or reopen it weeks later, with no sidecar files.
- Eight high-contrast speaker colours (A to H) so long multi-speaker transcripts stay readable at a glance.
- The GPU row now names the real backend (Vulkan) instead of reporting a CUDA flag that did not describe what
  the bundled llama.cpp engine was doing.
- 40px grid alignment across the shell, so sidebar, top bar, panes and controls share one baseline.
- Bidi fixes in the progress header: mixed Arabic and Latin text, numbers and percentages now render in the
  correct order.

## Install

- `Tafreegh-0.9.9-setup-x64.exe`
- `Tafreegh-0.9.9-setup-x64.msi`

The installers are unsigned. Windows SmartScreen will warn on first launch: choose **More info**, then
**Run anyway**.

## Verify

```
4E5E4460B5394D3E82D079C35308A816CB93686187F8190C09426A16205F0D10  Tafreegh-0.9.9-setup-x64.exe
D3C39F6D682524AE34C664CFFFB0A6A762FB539D9E00028AE903ACDACB769B55  Tafreegh-0.9.9-setup-x64.msi
```

Check a download with `Get-FileHash .\Tafreegh-0.9.9-setup-x64.exe -Algorithm SHA256` in PowerShell.

## Requirements

- Windows 10 or Windows 11, x64.
- A Vulkan capable GPU with 6 GB or more of VRAM (NVIDIA or AMD). CPU-only runs work but are slow.
- About 13 GB of free disk space for the Q4 model set.
- Internet access on first run only, to fetch the models. Transcription afterwards is local.

## Known limits

- Installers are unsigned, so SmartScreen warns on first run.
- Highlight timing in the transcript is proportional within a 30 second window, not word-accurate.
- One transcription job at a time.

## Licence

MIT, copyright 2026 Yossef Ismail. Commercial use, modification and redistribution are allowed under the usual MIT terms, with no warranty.

The licence and the third-party notices ship inside the app: `resources\LICENSE.txt`, `resources\THIRD-PARTY-NOTICES.txt`, and `resources\licenses\`.

## Accuracy

Transcripts and speaker labels are generated automatically and can contain errors. Tafreegh is an assistance tool, not a legally binding or certified record: check anything that matters against the original audio.
