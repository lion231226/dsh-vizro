#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "vizro==1.0.0",
#   "dash-mantine-components<3",
# ]
# ///
"""Serve one Vizro app file on a given port.

Read by dsh-vizro's `vizro_run`: the file is imported as a module (never run as
`__main__`), then the built app is served on the requested port. A ready marker
goes to stderr so the host can wait for the server without parsing Dash output.

`dash-mantine-components<3` is pinned on purpose: dmc 3 needs React 19 while
dash 4.5 serves React 18.3.1 by default, and that combination renders a blank
page while every server-side check still passes. If the environment ends up
mismatched anyway, the compatibility check below fails before the ready marker
instead of reporting a broken server as running.
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


def check_frontend_stack() -> dict:
    """Refuse to serve a stack that is known to render blank.

    The dependency resolver cannot see the React-version constraint: dmc 3's
    metadata only asks for `dash>=4.5.0`, while at runtime it requires React 19
    and dash defaults to 18.3.1. Server-side checks cannot catch the result, so
    the mismatch is caught here, before the ready marker.
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from worker import _effective_react_version, _react_compat  # noqa: PLC0415

    try:
        import dash
    except Exception as exc:  # noqa: BLE001
        fail(f"dash is not importable: {type(exc).__name__}: {exc}")
    dmc_version = None
    try:
        import dash_mantine_components as dmc

        dmc_version = getattr(dmc, "__version__", None)
    except Exception:  # noqa: BLE001
        pass
    react, source = _effective_react_version()
    compatible, detail = _react_compat(getattr(dash, "__version__", None), dmc_version, react)
    info = {
        "dash": getattr(dash, "__version__", None),
        "dash_mantine_components": dmc_version,
        "react": react,
        "react_source": source,
        "react_compatible": compatible,
        "detail": detail,
    }
    if compatible is False:
        fail(
            f"front-end stack is incompatible: {detail}",
            "Install dash-mantine-components<3 (the plugin pins it), or start the server with "
            "REACT_VERSION=19.2.4. Without that, the page renders blank even though the server answers.",
        )
    return info


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
    env_info = check_frontend_stack()

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
    payload = {"url": url, "port": port, "entry": entry, "frontend": env_info}
    sys.stderr.write(f"[dsh-vizro] ready {json.dumps(payload)}\n")
    sys.stderr.flush()

    run = getattr(app, "run", None)
    if not callable(run):
        fail("app has no run() method")
    run(host="127.0.0.1", port=port, debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
