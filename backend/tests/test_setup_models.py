"""tafreegh.setup_models helpers on temp directories (no downloads)."""

from __future__ import annotations

from pathlib import Path

import pytest

from tafreegh import pipeline, setup_models


# ---------------------------------------------------------------- _dir_size
def test_dir_size_missing_path(tmp_path):
    assert setup_models._dir_size(str(tmp_path / "missing")) == 0


def test_dir_size_empty_dir(tmp_path):
    assert setup_models._dir_size(str(tmp_path)) == 0


def test_dir_size_sums_nested_files(tmp_path):
    (tmp_path / "a.bin").write_bytes(b"x" * 10)
    nested = tmp_path / "nested" / "deeper"
    nested.mkdir(parents=True)
    (nested / "b.bin").write_bytes(b"x" * 25)
    (nested / "empty.bin").write_bytes(b"")

    assert setup_models._dir_size(str(tmp_path)) == 35


def test_dir_size_ignores_directories(tmp_path):
    (tmp_path / "sub").mkdir()
    assert setup_models._dir_size(str(tmp_path)) == 0


# ------------------------------------------------------- download accounting
def _sparse(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as handle:
        handle.truncate(size)


def test_jais_downloaded_counts_finished_files_and_in_flight_blobs(tmp_path):
    """The counter follows the two files this download owns, nothing else."""
    target = tmp_path / "jais-asr"
    files = ["Jais-ASR-Q4_K_M.gguf", "mmproj-Jais-ASR-Q6_K.gguf"]
    _sparse(target / files[1], 1000)  # finished
    staging = target / ".cache" / "huggingface" / "download"
    staging.mkdir(parents=True)
    _sparse(staging / "abc.2ec6eb6f.incomplete", 5000)  # in flight
    # Not ours: a tree cache entry and an unrelated file in the model folder.
    (staging / "trees.json").write_bytes(b"x" * 70)
    _sparse(target / "notes.txt", 30)

    assert setup_models._jais_downloaded(str(target), files) == 6000


def test_poller_clamps_progress_to_the_total():
    """Regression: fragments pushed bytesDone past bytesTotal (`3.80 / 3.72`)."""
    poller = setup_models._Poller(lambda: 5_000_000, 1_000_000, "jais", "m")
    pct, done = poller._sample()

    assert done == 1_000_000
    assert pct == 99.0


def test_purge_legacy_staging_keeps_the_longest_fragment_and_spares_resumable_ones(tmp_path):
    target = tmp_path / "jais-asr"
    staging = target / ".cache" / "huggingface" / "download"
    staging.mkdir(parents=True)
    # Three 1.x attempts at the same blob: a uuid segment separates the name.
    _sparse(staging / "blob.2ec6eb6f54e0.f2468ed2.incomplete", 7000)
    _sparse(staging / "blob.2ec6eb6f54e0.5c690ade.incomplete", 3000)
    _sparse(staging / "blob.2ec6eb6f54e0.1856881b.incomplete", 2000)
    # 0.x shape for a different file: resumed by the pinned library, keep as is.
    resumable = staging / "blob.fd02661c25da.incomplete"
    _sparse(resumable, 1500)

    freed = setup_models._purge_legacy_staging(str(target))

    assert freed == 5000
    adopted = staging / "blob.2ec6eb6f54e0.incomplete"
    assert adopted.stat().st_size == 7000
    assert resumable.stat().st_size == 1500
    assert len([p for p in staging.iterdir() if p.name.endswith(".incomplete")]) == 2


def test_purge_legacy_staging_prefers_an_already_longer_resumable_file(tmp_path):
    target = tmp_path / "jais-asr"
    staging = target / ".cache" / "huggingface" / "download"
    staging.mkdir(parents=True)
    _sparse(staging / "blob.2ec6eb6f54e0.f2468ed2.incomplete", 2000)
    resumable = staging / "blob.2ec6eb6f54e0.incomplete"
    _sparse(resumable, 9000)

    freed = setup_models._purge_legacy_staging(str(target))

    assert freed == 2000
    assert resumable.stat().st_size == 9000


def test_download_jais_drops_legacy_fragments_before_it_starts(tmp_path, monkeypatch):
    target = tmp_path / "models" / "jais-asr"
    staging = target / ".cache" / "huggingface" / "download"
    staging.mkdir(parents=True)
    legacy = staging / "blob.2ec6eb6f54e0.1856881b.incomplete"
    _sparse(legacy, 4096)

    seen: dict[str, bool] = {}

    def fake_snapshot_download(repo_id, local_dir, allow_patterns, **kwargs):
        seen["legacy_present"] = legacy.exists()
        for name in allow_patterns:
            _sparse(Path(local_dir) / name, 4096)

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download)
    spec = pipeline.JAIS_VARIANTS["gguf"]

    setup_models._download_jais_files(spec, str(target), spec["files"])

    assert seen["legacy_present"] is False
    assert sorted(p.name for p in target.glob("*.gguf")) == sorted(spec["files"])


# ------------------------------------------------------------ models_status
@pytest.fixture
def offline_sizes(monkeypatch):
    """Keep the status check hermetic: no network, no scanning real caches."""
    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.delenv("TAFREEGH_MOCK", raising=False)
    monkeypatch.setattr(setup_models, "_nemo_cache_dirs", lambda: [])


def test_models_status_empty_dir(tmp_path, offline_sizes):
    models_dir = tmp_path / "models"
    models_dir.mkdir()

    status = setup_models.models_status(str(models_dir))

    assert set(status) == {"jais", "diarizer"}

    jais = status["jais"]
    assert jais["present"] is False
    assert jais["bytes"] == 0
    # The advertised size is the artifact the device profile would download.
    assert jais["variant"] == jais["suggested"]
    assert jais["totalBytes"] == pipeline.JAIS_VARIANTS[jais["variant"]]["bytes"]
    assert jais["collection"] == pipeline.JAIS_COLLECTION
    assert status["diarizer"]["present"] is False
    assert status["diarizer"]["bytes"] == 0


def test_models_status_nonexistent_dir(tmp_path, offline_sizes):
    status = setup_models.models_status(str(tmp_path / "never-created"))

    assert status["jais"]["present"] is False
    assert status["jais"]["bytes"] == 0


def test_custom_diarizer_env_is_used(tmp_path, monkeypatch):
    gguf = tmp_path / "Nemotron-3-Diarization.q8_0.gguf"
    gguf.write_bytes(b"0" * 2048)
    monkeypatch.setenv("NEMO_DIAR_MODEL", str(gguf))

    assert setup_models._custom_diarizer() == str(gguf)
    assert setup_models._diarizer_bytes() == 2048


def test_custom_diarizer_ignores_missing_file(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMO_DIAR_MODEL", str(tmp_path / "missing.gguf"))
    monkeypatch.setattr(setup_models, "_nemo_model_bytes", lambda: 123)

    assert setup_models._custom_diarizer() == ""
    assert setup_models._diarizer_bytes() == 123


def test_models_status_incomplete_jais_dir(tmp_path, offline_sizes):
    models_dir = tmp_path / "models"
    jais = models_dir / "jais-asr"
    jais.mkdir(parents=True)
    # Only the text model: the audio projector was never downloaded.
    (jais / "Jais-ASR-Q4_K_M.gguf").write_bytes(b"0" * 5000)

    status = setup_models.models_status(str(models_dir))

    assert status["jais"]["present"] is False
    assert status["jais"]["bytes"] == sum(p.stat().st_size for p in jais.iterdir())


# ------------------------------------------------- collection artifact swap
def test_download_jais_requests_the_variant_files(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    calls: list[tuple[str, list[str]]] = []

    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.delenv("TAFREEGH_MOCK", raising=False)
    monkeypatch.setattr(
        setup_models, "_download_jais_files", _fake_download(calls=calls)
    )

    result = setup_models.download_jais(str(models_dir), "gguf-q8")

    assert calls == [
        ("IFM/Jais-ASR-GGUF", pipeline.JAIS_VARIANTS["gguf-q8"]["files"]),
    ]
    assert result["variant"] == "gguf-q8"
    assert result["present"] is True


def test_download_jais_keeps_existing_artifact_of_same_variant(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    jais = models_dir / "jais-asr"
    _gguf_pair(jais)

    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.delenv("TAFREEGH_MOCK", raising=False)
    monkeypatch.setattr(
        setup_models,
        "_download_jais_files",
        lambda *args, **kwargs: pytest.fail("no download expected for a complete artifact"),
    )

    result = setup_models.download_jais(str(models_dir), "gguf")

    assert result["variant"] == "gguf"
    assert result["path"] == str(jais)


def test_download_jais_mock_mode_needs_no_network(tmp_path, monkeypatch):
    """UI tests run the setup screen offline: the CLI must still exit 0."""
    models_dir = tmp_path / "models"

    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.setenv("TAFREEGH_MOCK", "1")
    monkeypatch.setattr(
        setup_models,
        "_download_jais_files",
        lambda *args, **kwargs: pytest.fail("mock mode must not touch the network"),
    )

    result = setup_models.download_jais(str(models_dir), "gguf")

    jais = models_dir / "jais-asr"
    assert result["present"] is True
    assert result["variant"] == "gguf"
    assert result.get("mock") is True
    assert pipeline.detect_jais_variant(str(jais)) == "gguf"


def test_prune_keeps_only_the_chosen_gguf_quant(tmp_path):
    _sparse(tmp_path / "Jais-ASR-Q4_K_M.gguf", 2048)
    _sparse(tmp_path / "mmproj-Jais-ASR-Q6_K.gguf", 1024)
    _sparse(tmp_path / "Jais-ASR-Q8_0.gguf", 4096)
    _sparse(tmp_path / "mmproj-Jais-ASR-F16.gguf", 1024)

    setup_models._prune_stale_weights(str(tmp_path), "gguf-q8")

    assert (tmp_path / "Jais-ASR-Q8_0.gguf").exists()
    assert (tmp_path / "mmproj-Jais-ASR-F16.gguf").exists()
    assert not (tmp_path / "Jais-ASR-Q4_K_M.gguf").exists()
    assert not (tmp_path / "mmproj-Jais-ASR-Q6_K.gguf").exists()


def test_prune_gguf_drops_legacy_safetensors(tmp_path):
    """Upgrading from an old install must free the dead safetensors weights."""
    _sparse(tmp_path / "Jais-ASR-Q4_K_M.gguf", 2048)
    _sparse(tmp_path / "mmproj-Jais-ASR-Q6_K.gguf", 1024)
    (tmp_path / "model.safetensors").write_bytes(b"0" * 64)
    (tmp_path / "model.safetensors.index.json").write_text("{}", encoding="utf-8")

    setup_models._prune_stale_weights(str(tmp_path), "gguf")

    assert not (tmp_path / "model.safetensors").exists()
    assert not (tmp_path / "model.safetensors.index.json").exists()
    assert (tmp_path / "Jais-ASR-Q4_K_M.gguf").exists()
    assert (tmp_path / "mmproj-Jais-ASR-Q6_K.gguf").exists()


# ------------------------------------------------------ in-place variant swap
def _fake_download(files: list[str] | None = None, calls: list | None = None):
    """Stand-in for `_download_jais_files`: writes the sparse pair, no network."""

    def fake(spec, target, names):
        if calls is not None:
            calls.append((spec["repo"], list(names)))
        Path(target).mkdir(parents=True, exist_ok=True)
        for name in files or names:
            _sparse(Path(target) / name, 4096)

    return fake


def _gguf_pair(folder, quant: str = "Q4_K_M", mmproj: str = "mmproj-Jais-ASR-Q6_K.gguf"):
    folder.mkdir(parents=True, exist_ok=True)
    _sparse(folder / f"Jais-ASR-{quant}.gguf", 4096)
    _sparse(folder / mmproj, 1024)
    return folder


def test_download_jais_reuses_a_complete_borrowed_folder(tmp_path, monkeypatch):
    borrowed = _gguf_pair(tmp_path / "borrowed")
    monkeypatch.setenv("JAIS_LOCAL_DIR", str(borrowed))
    monkeypatch.setattr(
        setup_models,
        "_download_jais_files",
        lambda *args, **kwargs: pytest.fail(
            "a complete borrowed folder must not be downloaded again"
        ),
    )

    result = setup_models.download_jais(str(tmp_path / "models"), "gguf")

    assert result["borrowed"] is True
    assert result["path"] == str(borrowed)
    assert result["variant"] == "gguf"
    assert not (tmp_path / "models" / "jais-asr").exists()


def test_download_jais_never_writes_into_a_borrowed_folder(tmp_path, monkeypatch):
    """A borrowed Q4_K_M on a card that wants Q8_0: download into the app slot."""
    borrowed = _gguf_pair(tmp_path / "borrowed")
    managed = tmp_path / "models" / "jais-asr"
    monkeypatch.setenv("JAIS_LOCAL_DIR", str(borrowed))
    monkeypatch.setattr(
        setup_models,
        "_download_jais_files",
        _fake_download(pipeline.JAIS_VARIANTS["gguf-q8"]["files"]),
    )

    result = setup_models.download_jais(str(tmp_path / "models"), "gguf-q8")

    assert result["path"] == str(managed)
    assert result["variant"] == "gguf-q8"
    assert (borrowed / "Jais-ASR-Q4_K_M.gguf").exists(), "the borrowed folder was modified"
    assert not (borrowed / "Jais-ASR-Q8_0.gguf").exists()
    assert sorted(p.name for p in managed.glob("*.gguf")) == sorted(
        pipeline.JAIS_VARIANTS["gguf-q8"]["files"]
    )


def test_download_jais_swaps_gguf_quantization_in_place(tmp_path, monkeypatch):
    """A slot that holds Q4_K_M must be upgradeable to Q8_0 without a wipe.

    Regression: detection ran before the stale weights were pruned, so the old
    Q4_K_M pair was still reported and every attempt raised
    "downloaded gguf weights while gguf-q8 was requested".
    """
    models_dir = tmp_path / "models"
    jais = models_dir / "jais-asr"
    jais.mkdir(parents=True)
    for name in pipeline.JAIS_VARIANTS["gguf"]["files"]:
        _sparse(jais / name, 4096)

    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.setattr(
        setup_models,
        "_download_jais_files",
        _fake_download(pipeline.JAIS_VARIANTS["gguf-q8"]["files"]),
    )

    result = setup_models.download_jais(str(models_dir), "gguf-q8")

    assert result["variant"] == "gguf-q8"
    assert result["present"] is True
    assert sorted(p.name for p in jais.glob("*.gguf")) == sorted(
        pipeline.JAIS_VARIANTS["gguf-q8"]["files"]
    )
    assert pipeline.detect_jais_variant(str(jais)) == "gguf-q8"


def test_download_jais_swaps_gguf_for_gguf_is_rejected_as_unknown(tmp_path, monkeypatch):
    """Only catalog variants exist now: an unknown name is never downloaded."""
    models_dir = tmp_path / "models"
    jais = models_dir / "jais-asr"
    _gguf_pair(jais)

    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.delenv("TAFREEGH_MOCK", raising=False)
    monkeypatch.setattr(pipeline, "select_jais_variant", lambda *a, **k: "gguf")
    monkeypatch.setattr(
        setup_models,
        "_download_jais_files",
        lambda *args, **kwargs: pytest.fail("an unknown variant must never download"),
    )

    result = setup_models.download_jais(str(models_dir), "bf16")

    # The safetensors-era name is not in the catalog, so the device default wins.
    assert result["variant"] == "gguf"
    assert result["present"] is True


def test_download_jais_rejects_a_snapshot_without_the_weights(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    monkeypatch.delenv("JAIS_LOCAL_DIR", raising=False)
    monkeypatch.delenv("TAFREEGH_MOCK", raising=False)
    monkeypatch.setattr(setup_models.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(setup_models, "_download_jais_files", lambda *args, **kwargs: None)

    with pytest.raises(RuntimeError) as excinfo:
        setup_models.download_jais(str(models_dir), "gguf-q8")

    assert "gguf-q8" in str(excinfo.value)


# ------------------------------------------------------------ progress events
def test_setup_progress_clamps_and_defaults(monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(setup_models, "_emit", events.append)

    setup_models.setup_progress("jais", None, "ØºÙŠØ± Ù…Ø­Ø¯Ø¯", True, bytesDone=1, bytesTotal=2)
    setup_models.setup_progress("jais", 150, "ÙÙˆÙ‚ Ø§Ù„Ø­Ø¯")
    setup_models.setup_progress("jais", -5, "ØªØ­Øª Ø§Ù„Ø­Ø¯")

    assert events[0] == {
        "type": "setup",
        "phase": "jais",
        "pct": 0.0,
        "indeterminate": True,
        "message": "ØºÙŠØ± Ù…Ø­Ø¯Ø¯",
        "bytesDone": 1,
        "bytesTotal": 2,
    }
    assert events[1]["pct"] == 100.0
    assert events[2]["pct"] == 0.0
    assert events[1]["indeterminate"] is False


# ------------------------------------------------------------------ setup_all
def test_setup_all_emits_each_phase_in_order(tmp_path, monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(setup_models, "_emit", events.append)
    calls: list[tuple] = []

    def fake_jais(models_dir, variant=None):
        calls.append(("jais", models_dir, variant))
        setup_models.setup_progress("jais", 100, "done")
        return {"present": True, "variant": variant, "path": models_dir}

    def fake_diarizer():
        calls.append(("diarizer",))
        setup_models.setup_progress("diarizer", 100, "done")
        return {"present": True}

    monkeypatch.setattr(setup_models, "download_jais", fake_jais)
    monkeypatch.setattr(setup_models, "warm_diarizer", fake_diarizer)
    monkeypatch.setattr(
        setup_models,
        "models_status",
        lambda models_dir: {"jais": {}, "diarizer": {}},
    )

    models_dir = tmp_path / "models"
    result = setup_models.setup_all(str(models_dir), variant="gguf")

    assert models_dir.is_dir(), "setup_all must create the models folder"
    assert [c[0] for c in calls] == ["jais", "diarizer"]
    assert calls[0] == ("jais", str(models_dir), "gguf")
    assert [e["phase"] for e in events] == ["jais", "diarizer"]
    assert set(result) == {"models", "jais", "diarizer"}
    assert result["jais"]["variant"] == "gguf"


# ------------------------------------------- app-owned NeMo-Speech locations
def test_nemo_runtime_and_cache_live_under_the_app_data_dir(tmp_path, monkeypatch):
    """Nothing may land in a shared user cache any more: uninstall must own it."""
    monkeypatch.setenv("TAFREEGH_DATA_DIR", str(tmp_path))

    assert pipeline.nemo_speech_root() == str(
        tmp_path / "bin" / "nemo-speech" / pipeline.NEMO_SPEECH_VERSION
    )
    assert pipeline.nemo_model_dir() == str(tmp_path / "models" / "nemo-diarization")
    assert pipeline.nemo_env()["NEMO_SPEECH_MODEL_DIR"] == str(
        tmp_path / "models" / "nemo-diarization"
    )


def test_legacy_nemo_cache_is_moved_into_the_app(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy"
    weights = legacy / "nvidia" / "Nemotron-3-Diarization" / "rev" / "model.q8_0.gguf"
    weights.parent.mkdir(parents=True)
    weights.write_bytes(b"x" * 64)

    monkeypatch.setenv("TAFREEGH_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        setup_models, "_nemo_cache_dirs", lambda: [pipeline.nemo_model_dir(), str(legacy)]
    )

    setup_models._adopt_legacy_nemo_cache()

    moved = (
        tmp_path
        / "data"
        / "models"
        / "nemo-diarization"
        / "nvidia"
        / "Nemotron-3-Diarization"
        / "rev"
        / "model.q8_0.gguf"
    )
    assert moved.is_file()
    assert not legacy.exists()

