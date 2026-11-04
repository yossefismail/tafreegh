# Third-party notices

Tafreegh itself is licensed under the PolyForm Noncommercial License 1.0.0.
Copyright 2026 Yossef Ismail. See `LICENSE`.

This file lists the third-party components that ship inside the installers, and
the models and packages that the app downloads at first run. Each component stays
under its own license; nothing here changes those terms.

## Bundled in the installer

| Component | License | Where |
|---|---|---|
| Electron 45 (including Chromium and Node.js) | MIT, with Chromium's BSD-style and other licenses | `LICENSES.chromium.html` in the installed app |
| llama.cpp, Vulkan build (GGUF runtime for Jais-ASR) | MIT | `resources/llama/LICENSE-llama.cpp.txt` |
| Archivo | SIL Open Font License 1.1 | `resources/licenses/OFL-Archivo.txt` |
| Cairo | SIL Open Font License 1.1 | `resources/licenses/OFL-Cairo.txt` |
| JetBrains Mono | SIL Open Font License 1.1 | `resources/licenses/OFL-JetBrainsMono.txt` |

The font files are unmodified WOFF2 builds. They are redistributed with their
copyright notices and license texts, as the OFL requires.

## Downloaded at first run, not redistributed

These are fetched from their publishers when you run setup. Tafreegh does not
bundle them, and their licenses are between you and their publishers.

| Component | License | Source |
|---|---|---|
| Jais-ASR weights (Q4_K_M or Q8_0 GGUF + mmproj) | Apache License 2.0 | <https://huggingface.co/IFM/Jais-ASR-GGUF> |
| NVIDIA Nemotron-3-Diarization weights | OpenMDW License 1.1 | <https://huggingface.co/nvidia/Nemotron-3-Diarization> |
| nemo-speech runtime | See the upstream repository | <https://github.com/NVIDIA/NeMo-Speech.cpp> |
| Python packages (`numpy`, `scipy`, `soundfile`, `noisereduce`, `huggingface_hub`, `imageio-ffmpeg`) | Each package's own license, installed from PyPI | PyPI |

If you redistribute an installed copy of Tafreegh together with those downloaded
files, you are redistributing them too, and their licenses apply to that copy.

## Required notice

PolyForm Noncommercial 1.0.0 asks anyone who redistributes the software to pass
on this line:

> Required Notice: Copyright 2026 Yossef Ismail
