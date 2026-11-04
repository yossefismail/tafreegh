"""Tafreegh Python worker.

Every command speaks JSON Lines on stdout (the original stdout is duplicated
before any library can print to it; regular prints are redirected to stderr).
The Electron main process reads these events and never parses free text.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# JSONL channel: keep the real stdout, then point fd 1 at stderr so library
# prints (huggingface_hub, nemo-speech wrappers, ffmpeg helpers) cannot corrupt
# it.
_EVENT_FD = os.dup(1)
os.dup2(2, 1)
_EVENT_STREAM = os.fdopen(_EVENT_FD, "w", encoding="utf-8", buffering=1)


def send(event: dict) -> None:
    try:
        _EVENT_STREAM.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        _EVENT_STREAM.flush()
    except Exception:  # noqa: BLE001
        pass


from tafreegh import pipeline  # noqa: E402

pipeline.set_emitter(send)


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).lower() in ("1", "true", "yes", "on")


def _seconds(value: str) -> float:
    """argparse type for --max-seconds: a non-negative duration (0 = no limit)."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError(f"not a number: {value!r}") from None
    if seconds < 0:
        raise argparse.ArgumentTypeError("must be zero or a positive number of seconds")
    return seconds


def cmd_probe(args) -> dict:
    from tafreegh import setup_models

    return setup_models.probe()


def cmd_models_status(args) -> dict:
    from tafreegh import setup_models

    return setup_models.models_status(args.models_dir)


def cmd_setup_models(args) -> dict:
    from tafreegh import setup_models

    return setup_models.setup_all(
        args.models_dir,
        variant=args.variant or None,
    )


def cmd_setup_jais(args) -> dict:
    from tafreegh import setup_models

    return setup_models.download_jais(args.models_dir, args.variant or None)


def cmd_setup_diarizer(args) -> dict:
    from tafreegh import setup_models

    return setup_models.warm_diarizer()


def cmd_run(args) -> dict:
    os.makedirs(args.job_dir, exist_ok=True)
    return pipeline.run_job(
        input_path=args.input,
        job_dir=args.job_dir,
        display_name=args.display_name or os.path.basename(args.input),
        language=args.language,
        enhance_enabled=_bool(args.enhance, True),
        model_dir=args.model_dir,
        max_seconds=float(args.max_seconds or 0),
    )


def cmd_render(args) -> dict:
    from tafreegh import render

    moments = None
    if args.moments_file and os.path.exists(args.moments_file):
        with open(args.moments_file, encoding="utf-8") as f:
            moments = json.load(f)
    names = None
    if args.speaker_names and os.path.exists(args.speaker_names):
        with open(args.speaker_names, encoding="utf-8") as f:
            names = json.load(f)
    return render.render(
        job_dir=args.job_dir,
        summary_path=args.summary,
        title=args.title,
        kicker=args.kicker,
        note=args.note,
        project=args.project,
        date=args.date,
        model=args.model,
        heading=args.heading,
        end=args.end,
        moments=moments,
        no_fonts=_bool(args.no_fonts, False),
        speaker_names=names,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tafreegh-worker")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("probe")
    p.add_argument("--models-dir", default="")
    p.set_defaults(func=cmd_probe)

    p = sub.add_parser("models-status")
    p.add_argument("--models-dir", required=True)
    p.set_defaults(func=cmd_models_status)

    p = sub.add_parser("setup-models")
    p.add_argument("--models-dir", required=True)
    # Single source of truth: pipeline owns the catalog, so a new quantization
    # can never be rejected here again.
    p.add_argument("--variant", default=None, choices=list(pipeline.JAIS_VARIANTS))
    p.set_defaults(func=cmd_setup_models)

    p = sub.add_parser("setup-jais")
    p.add_argument("--models-dir", required=True)
    p.add_argument("--variant", default=None, choices=list(pipeline.JAIS_VARIANTS))
    p.set_defaults(func=cmd_setup_jais)

    p = sub.add_parser("setup-diarizer")
    p.add_argument("--models-dir", default="")
    p.set_defaults(func=cmd_setup_diarizer)

    p = sub.add_parser("run")
    p.add_argument("--input", required=True)
    p.add_argument("--job-dir", required=True)
    p.add_argument("--display-name", default="")
    p.add_argument("--language", default="EG")
    p.add_argument("--enhance", default="1")
    p.add_argument("--model-dir", default=None)
    p.add_argument("--max-seconds", type=_seconds, default=0)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("render")
    p.add_argument("--job-dir", required=True)
    p.add_argument("--summary", default=None)
    p.add_argument("--title", default="التفريغ")
    p.add_argument("--kicker", default="RECORDING — TRANSCRIPT INDEX")
    p.add_argument("--note", default="")
    p.add_argument("--project", default="TAFREEGH")
    p.add_argument("--date", default="")
    p.add_argument("--model", default="Jais-ASR GGUF · Nemotron-3-Diarization")
    p.add_argument("--heading", default="التفريغ.")
    p.add_argument("--end", default=None)
    p.add_argument("--moments-file", default=None)
    p.add_argument("--speaker-names", default=None)
    p.add_argument("--no-fonts", default="0")
    p.set_defaults(func=cmd_render)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.time()
    try:
        result = args.func(args)
        send({"type": "done", "result": result, "elapsed": round(time.time() - started, 2)})
        return 0
    except KeyboardInterrupt:
        send({"type": "cancelled"})
        return 130
    except SystemExit as exc:  # noqa: BLE001 - vendored scripts call sys.exit()
        # Without this the process would die with the exit code but no event,
        # and the app could only report "the assistant failed (1)".
        tb = traceback.format_exc()
        print(tb, file=sys.stderr, flush=True)
        detail = exc.code if isinstance(exc.code, str) else ""
        send(
            {
                "type": "error",
                "message": detail or f"worker command exited (code {exc.code})",
                "errorType": "SystemExit",
                "traceback": tb[-8000:],
            }
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        print(tb, file=sys.stderr, flush=True)
        send(
            {
                "type": "error",
                "message": str(exc) or exc.__class__.__name__,
                "errorType": exc.__class__.__name__,
                "traceback": tb[-8000:],
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
