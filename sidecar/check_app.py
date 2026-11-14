#!/usr/bin/env python3
"""Child harness: import a Vizro app file as a module and report whether it builds.

Run by `worker.py` (check_code). It must never serve: `dash.Dash.run` is patched
to raise, so an unguarded `app.run()` at import time fails loudly instead of
hanging the sidecar. The verdict is one JSON line on stdout.
"""

from __future__ import annotations

import io
import json
import os
import sys
import traceback


def _emit(payload: dict) -> None:
    sys.__stdout__.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


def main() -> int:
    code_path = os.environ.get("VIZRO_CODE_PATH")
    workdir = os.environ.get("Vizro_Check_Workdir") or os.path.dirname(code_path or ".")
    if not code_path or not os.path.exists(code_path):
        _emit({"valid": False, "errors": [{"loc": "", "type": "file_not_found", "msg": code_path, "input": None}]})
        return 2

    sys.path.insert(0, workdir)
    sys.path.insert(0, os.path.dirname(os.path.abspath(code_path)))

    # Serving from an import must fail instead of hanging this process.
    try:
        import dash

        def _run_guard(*_args, **_kwargs):
            raise RuntimeError(
                "app.run() was called while importing the file. Guard it with "
                "`if __name__ == \"__main__\":` so the app can be validated without starting a server."
            )

        dash.Dash.run = _run_guard  # type: ignore[method-assign]
    except Exception:  # noqa: BLE001
        pass

    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    module_name = "vizro_candidate_app"
    try:
        import importlib.util

        spec = importlib.util.spec_from_file_location(module_name, code_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {code_path} as a Python module")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    except SyntaxError as exc:
        sys.stdout = real_stdout
        _emit(
            {
                "valid": False,
                "errors": [
                    {
                        "loc": f"line {exc.lineno}",
                        "type": "syntax_error",
                        "msg": f"{exc.msg} (line {exc.text.strip() if exc.text else ''})",
                        "input": None,
                    }
                ],
                "stdout_tail": captured.getvalue()[-800:],
            }
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        sys.stdout = real_stdout
        tb = traceback.format_exc(limit=8)
        _emit(
            {
                "valid": False,
                "errors": [
                    {"loc": "import", "type": type(exc).__name__, "msg": str(exc), "input": None},
                ],
                "traceback": tb[-3000:],
                "stdout_tail": captured.getvalue()[-800:],
            }
        )
        return 1
    finally:
        sys.stdout = real_stdout

    lines = captured.getvalue().splitlines()
    warnings = [line for line in lines if "Warning" in line or "warning" in line][:10]

    app = getattr(module, "app", None)
    dashboard = getattr(module, "dashboard", None)

    if app is not None:
        # Vizro 1.0 is not a Dash subclass: `Vizro()` wraps the app in `.dash`
        # and exposes `.run`. Accept either shape, reject everything else so a
        # plain variable named `app` is not mistaken for a built dashboard.
        try:
            import dash

            is_app = isinstance(app, dash.Dash)
        except Exception:  # noqa: BLE001
            is_app = False
        if not is_app:
            is_app = hasattr(app, "dash") and callable(getattr(app, "run", None))
        if not is_app:
            _emit(
                {
                    "valid": False,
                    "errors": [
                        {
                            "loc": "app",
                            "type": "not_a_dash_app",
                            "msg": "module-level `app` exists but is not a Dash instance built by Vizro().build(...)",
                            "input": None,
                        }
                    ],
                    "stdout_tail": "\n".join(lines[-20:]),
                }
            )
            return 1
        _emit(
            {
                "valid": True,
                "found": "app",
                "warnings": warnings,
                "stdout_tail": "\n".join(lines[-20:]),
            }
        )
        return 0

    if dashboard is not None:
        try:
            from vizro import Vizro

            Vizro().build(dashboard)
        except Exception as exc:  # noqa: BLE001
            _emit(
                {
                    "valid": False,
                    "errors": [{"loc": "dashboard", "type": type(exc).__name__, "msg": str(exc), "input": None}],
                    "traceback": traceback.format_exc(limit=8)[-2500:],
                    "stdout_tail": "\n".join(lines[-20:]),
                }
            )
            return 1
        _emit({"valid": True, "found": "dashboard", "warnings": warnings, "stdout_tail": "\n".join(lines[-20:])})
        return 0

    _emit(
        {
            "valid": False,
            "errors": [
                {
                    "loc": "",
                    "type": "missing_entrypoint",
                    "msg": (
                        "The file defines neither `app` nor `dashboard`. End with "
                        "`app = Vizro().build(dashboard)` (or assign `dashboard`)."
                    ),
                    "input": None,
                }
            ],
            "stdout_tail": "\n".join(lines[-20:]),
        }
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
