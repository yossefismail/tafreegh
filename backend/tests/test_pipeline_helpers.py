"""Pure helpers in tafreegh.pipeline (no torch, no network)."""

from __future__ import annotations

import json

import pytest

from tafreegh import pipeline


# ------------------------------------------------------------------ fmt
@pytest.mark.parametrize(
    ("seconds", "expected"),
    [
        (0, "00:00"),
        (5.9, "00:05"),
        (59.99, "00:59"),
        (60, "01:00"),
        (65, "01:05"),
        (3599, "59:59"),
        (3600, "60:00"),
        (-12, "00:00"),
    ],
)
def test_fmt(seconds, expected):
    assert pipeline.fmt(seconds) == expected


# ----------------------------------------------------------- speech_blocks
def turn(start, end, speaker="spk0"):
    return {"start": start, "end": end, "speaker": speaker}


def test_speech_blocks_empty_input():
    assert pipeline.speech_blocks([]) == []


def test_speech_blocks_ignores_very_short_turns():
    turns = [turn(1.0, 1.1), turn(2.0, 2.15)]
    assert pipeline.speech_blocks(turns) == []


def test_speech_blocks_pads_by_one_second():
    blocks = pipeline.speech_blocks([turn(10.0, 20.0)])
    assert blocks == [(9.0, 21.0)]


def test_speech_blocks_clamps_start_at_zero():
    blocks = pipeline.speech_blocks([turn(0.0, 10.0)])
    assert blocks == [(0, 11.0)]


def test_speech_blocks_merges_close_turns_and_counts_overlap_once():
    # Gap is 5s <= merge_gap 15s, so one block; talk = 10 + 5 = 15s.
    turns = [turn(0.0, 10.0, "spk0"), turn(15.0, 20.0, "spk1")]
    blocks = pipeline.speech_blocks(turns)
    assert blocks == [(0, 21.0)]


def test_speech_blocks_keeps_far_turns_separate():
    turns = [turn(0.0, 10.0), turn(40.0, 50.0)]
    blocks = pipeline.speech_blocks(turns)
    assert len(blocks) == 2
    assert blocks[0] == (0, 11.0)
    assert blocks[1] == (39.0, 51.0)


def test_speech_blocks_drops_blocks_below_min_speech():
    # Two 3s turns 10s apart merge into one block but only carry 6s of talk.
    turns = [turn(0.0, 3.0), turn(8.0, 11.0)]
    assert pipeline.speech_blocks(turns, min_speech=7.0) == []
    assert pipeline.speech_blocks(turns, min_speech=3.0) == [(0, 12.0)]


def test_speech_blocks_respects_merge_gap_argument():
    turns = [turn(0.0, 10.0), turn(20.0, 30.0)]
    assert len(pipeline.speech_blocks(turns, merge_gap=5.0)) == 2
    assert len(pipeline.speech_blocks(turns, merge_gap=15.0)) == 1


def test_speech_blocks_counts_talk_inside_a_block_not_padding():
    # 2s of speech + default padding would be 4s; min_speech must use talk time.
    assert pipeline.speech_blocks([turn(5.0, 7.0)], min_speech=2.5) == []


# ------------------------------------------------------ windows_from_blocks
def test_windows_from_blocks_splits_on_window_size():
    assert pipeline.windows_from_blocks([(0.0, 65.0)], win=30.0) == [
        (0.0, 30.0),
        (30.0, 60.0),
        (60.0, 65.0),
    ]


def test_windows_from_blocks_short_block_is_one_window():
    assert pipeline.windows_from_blocks([(12.0, 15.0)], win=30.0) == [(12.0, 15.0)]


def test_windows_from_blocks_skips_sliver_below_half_second():
    # loop guard is `s < b - 0.5`, so a 0.5s tail is not emitted.
    assert pipeline.windows_from_blocks([(0.0, 30.5)], win=30.0) == [(0.0, 30.0)]


def test_windows_from_blocks_empty():
    assert pipeline.windows_from_blocks([]) == []


def test_windows_from_blocks_multiple_blocks_stay_separate():
    windows = pipeline.windows_from_blocks([(0.0, 20.0), (40.0, 45.0)], win=30.0)
    assert windows == [(0.0, 20.0), (40.0, 45.0)]


# --------------------------------------------------------- speech_segments
def _turn(start, end, speaker="spk0"):
    return {"start": start, "end": end, "speaker": speaker}


def test_speech_segments_does_not_emit_a_window_past_the_end_of_the_audio():
    # A 30s clip whose speech ends at 30s used to get blocks (0, 31) and a second,
    # zero-sample window (30, 31); llama.cpp answers 400 for that empty WAV.
    blocks, segs = pipeline.speech_segments([_turn(0.0, 30.0)], 16000, 30.0)
    assert blocks == [(0.0, 30.0)]
    assert segs == [(0.0, 30.0)]


def test_speech_segments_clamps_padding_to_the_audio_end():
    blocks, segs = pipeline.speech_segments([_turn(0.0, 29.2)], 16000, 30.0)
    assert blocks == [(0.0, 30.0)]
    assert segs == [(0.0, 30.0)]


def test_speech_segments_keeps_the_tail_when_the_audio_continues():
    blocks, segs = pipeline.speech_segments([_turn(0.0, 40.0)], 16000, 60.0)
    assert blocks == [(0.0, 41.0)]
    assert segs == [(0.0, 30.0), (30.0, 41.0)]


def test_speech_segments_drops_windows_with_no_useful_audio():
    blocks, segs = pipeline.speech_segments([_turn(0.0, 3.0)], 16000, 0.4)
    assert blocks == []
    assert segs == []


# ------------------------------------------------------ _jais_dir_complete
def _gguf_pair(folder, quant="Q4_K_M", mmproj="mmproj-Jais-ASR-Q6_K.gguf"):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"Jais-ASR-{quant}.gguf").write_bytes(b"GGUF" + b"0" * 64)
    (folder / mmproj).write_bytes(b"GGUF" + b"0" * 64)
    return folder


def test_jais_dir_complete_missing_dir(tmp_path):
    assert pipeline._jais_dir_complete(str(tmp_path / "nope")) is False


def test_jais_dir_complete_empty_dir(tmp_path):
    assert pipeline._jais_dir_complete(str(tmp_path)) is False


def test_jais_dir_complete_requires_both_gguf_halves(tmp_path):
    (tmp_path / "Jais-ASR-Q4_K_M.gguf").write_bytes(b"GGUF" + b"0" * 64)
    assert pipeline._jais_dir_complete(str(tmp_path)) is False

    (tmp_path / "mmproj-Jais-ASR-Q6_K.gguf").write_bytes(b"GGUF" + b"0" * 64)
    assert pipeline._jais_dir_complete(str(tmp_path)) is True


def test_jais_dir_complete_ignores_a_safetensors_era_folder(tmp_path):
    """A transformers-style folder can no longer be served at all."""
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "model.safetensors.index.json").write_text(
        json.dumps({"weight_map": {"w": "model-00001.safetensors"}}), encoding="utf-8"
    )
    (tmp_path / "model-00001.safetensors").write_bytes(b"0" * 4096)

    assert pipeline._jais_dir_complete(str(tmp_path)) is False
    assert pipeline.detect_jais_variant(str(tmp_path)) is None


# --------------------------------------------------- GGUF folder detection
def test_gguf_folder_is_detected(tmp_path):
    _gguf_pair(tmp_path)
    assert pipeline.detect_jais_variant(str(tmp_path)) == "gguf"
    assert pipeline._jais_dir_complete(str(tmp_path)) is True


def test_gguf_q8_folder_is_detected(tmp_path):
    _gguf_pair(tmp_path, "Q8_0", "mmproj-Jais-ASR-F16.gguf")
    assert pipeline.detect_jais_variant(str(tmp_path)) == "gguf-q8"
    assert pipeline._jais_dir_complete(str(tmp_path)) is True


def test_gguf_needs_the_audio_projector(tmp_path):
    (tmp_path / "Jais-ASR-Q4_K_M.gguf").write_bytes(b"GGUF" + b"0" * 64)
    assert pipeline.detect_jais_variant(str(tmp_path)) is None


def test_detect_jais_variant_ignores_quantization_config(tmp_path):
    """`quantization_config` used to name a safetensors artifact; it means
    nothing to llama.cpp and must not classify a folder any more."""
    (tmp_path / "config.json").write_text(
        json.dumps(
            {
                "model_type": "jais_asr",
                "quantization_config": {
                    "format": "pack-quantized",
                    "config_groups": {"group_0": {"weights": {"type": "float", "num_bits": 8}}},
                },
            }
        ),
        encoding="utf-8",
    )
    assert pipeline.detect_jais_variant(str(tmp_path)) is None


# ------------------------------------------------------- model resolution
def test_resolve_jais_model_prefers_the_recommended_quantization(tmp_path, monkeypatch):
    q4 = _gguf_pair(tmp_path / "borrowed")
    q8 = _gguf_pair(tmp_path / "managed", "Q8_0", "mmproj-Jais-ASR-F16.gguf")
    monkeypatch.setenv("JAIS_LOCAL_DIR", str(q4))
    monkeypatch.setattr(pipeline, "select_jais_variant", lambda *a, **k: "gguf-q8")

    assert pipeline.resolve_jais_model(str(q8)) == str(q8)


def test_resolve_jais_model_finds_the_app_slot_without_a_model_dir(tmp_path, monkeypatch):
    """`run_job(model_dir=None)` must see <data>/models/jais-asr instead of
    reporting the model as missing."""
    slot = _gguf_pair(tmp_path / "models" / "jais-asr")
    monkeypatch.setenv("TAFREEGH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.setattr(pipeline, "select_jais_variant", lambda *a, **k: "gguf")

    assert pipeline.resolve_jais_model(None) == str(slot)


def test_resolve_jais_model_rejects_an_incomplete_slot(tmp_path, monkeypatch):
    slot = tmp_path / "models" / "jais-asr"
    slot.mkdir(parents=True)
    (slot / "config.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("TAFREEGH_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    # Do not let a leftover skill checkout on this machine satisfy the lookup.
    monkeypatch.setattr(pipeline, "_jais_fallback_dirs", lambda: [])

    with pytest.raises(RuntimeError) as excinfo:
        pipeline.resolve_jais_model(None)

    assert "GGUF" in str(excinfo.value)


# ------------------------------------------------------- speaker attribution
def test_dominant_speaker_picks_largest_overlap():
    turns = [turn(0, 10, "a"), turn(10, 12, "b")]
    assert pipeline.dominant_speaker(turns, 0, 11) == "a"


def test_dominant_speaker_falls_back_to_nearest_on_gap():
    turns = [turn(0, 5, "a"), turn(30, 40, "b")]
    assert pipeline.dominant_speaker(turns, 5.5, 9) == "a"
    assert pipeline.dominant_speaker(turns, 28, 29.5) == "b"


def test_dominant_speaker_without_turns_is_none():
    assert pipeline.dominant_speaker([], 0, 4) is None
