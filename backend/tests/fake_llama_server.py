"""Stand-in llama-server used by the lifecycle tests.

It answers the three endpoints tafreegh.jais_gguf talks to:

* ``--list-devices``  prints a Vulkan device table and exits,
* ``GET /health``     is 503 while ``FAKE_READY_DELAY`` seconds elapse, then 200,
* ``POST /v1/audio/transcriptions`` echoes the multipart language and prompt fields.

The tests launch it through a generated ``.bat`` so ``server_executable()`` can
treat it like the bundled ``llama-server.exe`` on Windows. Killing that ``.bat``
only kills ``cmd.exe``, so the server also watches its launcher and exits when it
is gone -- exactly the tree behaviour ``LlamaServer.stop`` relies on.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _launcher_gone(ppid: int) -> bool:
    if sys.platform != "win32":
        return os.getppid() != ppid
    import ctypes

    synchronize = 0x00100000
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(synchronize, False, ppid)
    if not handle:
        return True
    try:
        # Signaled means the launcher terminated.
        return kernel32.WaitForSingleObject(handle, 0) == 0
    finally:
        kernel32.CloseHandle(handle)


def _watch_launcher() -> None:
    ppid = os.getppid()
    while True:
        if _launcher_gone(ppid):
            os._exit(0)
        time.sleep(0.2)


def main(argv: list[str]) -> int:
    if "--list-devices" in argv:
        print("Vulkan0: NVIDIA GeForce RTX 4060 (8188 MiB)")
        print("Vulkan1: Intel(R) UHD Graphics (1024 MiB)")
        return 0

    threading.Thread(target=_watch_launcher, daemon=True).start()

    port = int(argv[argv.index("--port") + 1])
    ready_at = time.time() + float(os.environ.get("FAKE_READY_DELAY", "0"))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if self.path != "/health":
                self._send(404, b"{}")
                return
            ready = time.time() >= ready_at
            self._send(200 if ready else 503, b'{"status":"ok"}' if ready else b"{}")

        def do_POST(self) -> None:  # noqa: N802 - http.server API
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length)
            if b'name="language"' in body:
                text = "مرحبا بالعالم"
            elif b'name="prompt"' in body:
                text = "code-switch"
            else:
                text = "no-language"
            self._send(200, json.dumps({"text": f" {text} "}).encode("utf-8"))

        def log_message(self, *args) -> None:
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
