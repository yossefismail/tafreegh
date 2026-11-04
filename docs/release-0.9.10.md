# Tafreegh 0.9.10

Tafreegh turns Arabic audio into a readable, speaker-labelled transcript on the desktop, fully offline once the
models are downloaded. Version 0.9.10 is the first public build.

## Highlights

- Speaker strip with click-to-rename. Names are stored inside the exported HTML file itself, so a transcript
  keeps its labels when you move it to another machine or reopen it weeks later, with no sidecar files.
- Eight high-contrast speaker colours (A to H) so long multi-speaker transcripts stay readable at a glance.
- The GPU row names the real backend (Vulkan) instead of reporting a CUDA flag that did not describe what the
  bundled llama.cpp engine was doing.
- 40px grid alignment across the shell, so sidebar, top bar, panes and controls share one baseline.
- Bidi fixes in the progress header: mixed Arabic and Latin text, numbers and percentages now render in the
  correct order.
- Licensed under AGPL-3.0. The licence, the copyright notice and the third-party notices ship inside the
  installed app: `resources\LICENSE.txt`, `resources\NOTICE.txt`, `resources\THIRD-PARTY-NOTICES.txt` and
  `resources\licenses\`.

## Install

- `Tafreegh-0.9.10-setup-x64.exe`
- `Tafreegh-0.9.10-setup-x64.msi`

The installers are unsigned. Windows SmartScreen will warn on first launch: choose **More info**, then
**Run anyway**.

## Verify

```
76450BC68DB34B7B33322E0CA90A988E8FE16DAF3C7FF105BE382A44C03BE209  Tafreegh-0.9.10-setup-x64.exe
A268648FA05F36D5F56A7D7BC46A00FE0E192664277593C8E3DC4C5342429E75  Tafreegh-0.9.10-setup-x64.msi
```

Check a download with `Get-FileHash .\Tafreegh-0.9.10-setup-x64.exe -Algorithm SHA256` in PowerShell.

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

GNU AGPL-3.0, copyright (C) 2026 Yossef Ismail. Free to use, modify and redistribute, including commercially. If you distribute a modified build, or host one for other people to use, you must publish the corresponding source under the same licence.

## Accuracy

Transcripts and speaker labels are generated automatically and can contain errors. Tafreegh is an assistance tool, not a legally binding or certified record: check anything that matters against the original audio.
