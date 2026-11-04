"""Placement flags: auto-fit partial offload instead of all-or-nothing VRAM use."""

from __future__ import annotations

from tafreegh import jais_gguf


def test_cpu_only_pins_every_layer_to_the_cpu():
    assert jais_gguf.offload_args(None) == ["-ngl", "0"]


def test_gpu_hands_placement_back_to_llama_cpp():
    args = jais_gguf.offload_args("Vulkan1")

    assert args == ["-ngl", "auto", "--fit", "on"]
    # The old hardcoded value must never come back: it forced every layer into
    # VRAM and broke cards that cannot hold the whole model.
    assert "999" not in args


def test_fit_target_is_only_sent_when_known():
    assert jais_gguf.offload_args("Vulkan1", 640) == [
        "-ngl",
        "auto",
        "--fit",
        "on",
        "--fit-target",
        "640",
    ]
    assert jais_gguf.offload_args("Vulkan1", 0) == ["-ngl", "auto", "--fit", "on"]


def test_fit_target_scales_with_vram():
    assert jais_gguf.fit_target_for(None) is None
    assert jais_gguf.fit_target_for(0) is None
    assert jais_gguf.fit_target_for(2048) == 448
    assert jais_gguf.fit_target_for(6141) == 640
    assert jais_gguf.fit_target_for(8192) == 1024
    assert jais_gguf.fit_target_for(24576) == 1024


def test_server_keeps_the_requested_margin():
    server = jais_gguf.LlamaServer("model.gguf", "mmproj.gguf", fit_target_mb=640)

    assert server.fit_target_mb == 640
