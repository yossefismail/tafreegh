llama.cpp runtime for Tafreegh
=============================

Backend: vulkan  (see backend.txt)

Built from the MBZUAI-IFM fork (commit 35999d1, branch model/K2Horizon) with
the llama.cpp-jais-asr.patch published alongside IFM/Jais-ASR-GGUF, plus the
K2-Horizon pre-tokenizer backport in patches/llama-k2-splitter.patch.

Upstream llama.cpp cannot read Jais-ASR's `jais-asr` audio projector
("load_hparams: unknown projector type: jais-asr"), so the fork is required.

Vulkan was chosen for the shipped build because it runs on NVIDIA and AMD GPUs
through the normal graphics driver — users do not need the CUDA toolkit.

Measured on an RTX 4050 Laptop (6 GB), Q4_K_M: server ready in ~80 s, a 30 s
window transcribed in ~16 s (CPU build: ~108 s). That is why Tafreegh only
selects the GGUF artifact automatically when backend.txt says vulkan or cuda.

Rebuild:
  .\scripts\build-llama.ps1 -Backend vulkan -VulkanSdk <SDK path>

MIT licence: see LICENSE-llama.cpp.txt
