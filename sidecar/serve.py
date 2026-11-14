#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["vizro==1.0.0"]
# ///
"""Serve one Vizro app file on a given port.

Read by dsh-vizro's `vizro_run`: the file is imported as a module (never run as
`__main__`), then the built app is served on the requested port. A ready marker
goes to stderr so the host can wait for the server without parsing Dash output.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys


def fail(message: str, detail: str = "") -> "NoReturn":  # type: ignore[name-defined]  # noqa: F821
    sys.stderr.write(f"[dsh-vizro] error {json.dumps({'message': message, 'detail': detail})}\n")
    sys.stderr.flush()
    raise SystemExit(3)


def main() -> int:
    if len(sys.argv) < 3:
        fail("usage: serve.py <entry.py> <port>")
    entry = os.path.abspath(sys.argv[1])
    port = int(sys.argv[2])
    if not os.path.exists(entry):
        fail(f"entry not found: {entry}")
    workdir = os.path.dirname(entry) or os.getcwd()
    os.chdir(workdir)
    sys.path.insert(0, workdir)

    try:
        spec = importlib.util.spec_from_file_location("vizro_app_entry", entry)
        if spec is None or spec.loader is None:
            fail("could not load the entry as a module")
        module = importlib.util.module_from_spec(spec)
        sys.modules["vizro_app_entry"] = module
        spec.loader.exec_module(module)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback

        fail(f"import failed: {type(exc).__name__}: {exc}", traceback.format_exc(limit=10))

    app = getattr(module, "app", None)
    dashboard = getattr(module, "dashboard", None)
    if app is None and dashboard is not None:
        from vizro import Vizro

        app = Vizro().build(dashboard)
    if app is None:
        fail("the file defines neither `app` nor `dashboard`")

    url = f"http://127.0.0.1:{port}/"
    sys.stderr.write(f"[dsh-vizro] ready {json.dumps({'url': url, 'port': port, 'entry': entry})}\n")
    sys.stderr.flush()

    run = getattr(app, "run", None)
    if not callable(run):
        fail("app has no run() method")
    run(host="127.0.0.1", port=port, debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
