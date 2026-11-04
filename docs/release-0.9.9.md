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
87C5F8A1CB30AB0D2A4150F10D02172DE5C0EE97591B18DD308AAB97DAC547BC  Tafreegh-0.9.9-setup-x64.exe
4383779F60E93FE6877310895A6EF383318A6D84A5ABE4D1072A754FDE5FC005  Tafreegh-0.9.9-setup-x64.msi
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

Source-available under the **PolyForm Noncommercial License 1.0.0**, copyright 2026 Yossef Ismail. Personal, research, educational and other noncommercial use is free, and you may modify and share it under the same terms. Commercial use needs a separate licence.

The licence and the third-party notices now ship inside the app: `resources\LICENSE.txt`, `resources\THIRD-PARTY-NOTICES.txt`, and `resources\licenses\`.
