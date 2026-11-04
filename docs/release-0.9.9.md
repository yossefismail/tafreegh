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
D2C287280E00CFA54E29A0572C9B5D675ADB272B9F0FFE49FCC44251ADA8D3CC  Tafreegh-0.9.9-setup-x64.exe
95ADC578C64180CFAD141DEB5685A48F7A7025338F28A58FDAA39450B842191F  Tafreegh-0.9.9-setup-x64.msi
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
