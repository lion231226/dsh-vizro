#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "vizro==1.0.0",
#   "pyyaml>=6",
#   "openpyxl>=3.1",
#   "pyarrow>=14",
# ]
# ///
"""dsh-vizro sidecar: a long-lived JSON-lines worker that owns every Vizro/Python call.

Protocol: one JSON object per line.

  request   {"id": <number|string>, "method": "<name>", "params": {...}}
  response  {"id": ..., "ok": true,  "result": {...}}
            {"id": ..., "ok": false, "error": {"type": "...", "message": "...", "detail": ...}}

Methods
  ping      -> runtime identity (versions)
  models    -> public Vizro model index
  schema    -> JSON Schema for one model (top-level $ref inlined, $defs dropped)
  validate  -> validate a dashboard config through the production Pydantic path,
               return structured errors or the rendered Python code
  profile   -> deterministic dataframe profile (head sample, cardinality, nulls, time span)
  shutdown  -> exit cleanly

The real stdout is reserved for protocol lines; every library write to stdout is
redirected to stderr so a stray print can never corrupt the stream.
"""

from __future__ import annotations

import io
import json
import os
import sys
import traceback
from typing import Any

# --- protocol hygiene -------------------------------------------------------
_REAL_OUT = sys.stdout


def _emit(payload: dict[str, Any]) -> None:
    _REAL_OUT.write(json.dumps(payload, ensure_ascii=False, default=_json_default) + "\n")
    _REAL_OUT.flush()


sys.stdout = sys.stderr  # library prints must not corrupt the protocol


def _json_default(obj: Any) -> Any:
    try:
        import numpy as np

        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
    except Exception:  # noqa: BLE001
        pass
    try:
        import pandas as pd

        if isinstance(obj, pd.Timestamp):
            return obj.isoformat()
        if obj is pd.NA:
            return None
    except Exception:  # noqa: BLE001
        pass
    return str(obj)


def _truncate(value: Any, limit: int = 400) -> Any:
    """Keep validation errors model-sized: pydantic echoes the whole input."""
    try:
        text = json.dumps(value, ensure_ascii=False, default=_json_default)
    except Exception:  # noqa: BLE001
        text = str(value)
    if len(text) <= limit:
        return value
    return text[:limit] + "…"


class SidecarError(Exception):
    def __init__(self, type_: str, message: str, detail: Any = None):
        super().__init__(message)
        self.type = type_
        self.message = message
        self.detail = detail


class Worker:
    def __init__(self) -> None:
        self._vizro = None
        self._vm = None
        self._Vizro = None
        self._pandas = None

    # -- lazy imports --------------------------------------------------------
    def _load(self):
        if self._vizro is None:
            import vizro
            import vizro.models as vm
            from vizro import Vizro

            self._vizro, self._vm, self._Vizro = vizro, vm, Vizro
        return self._vizro, self._vm, self._Vizro

    def _pd(self):
        if self._pandas is None:
            import pandas as pd

            self._pandas = pd
        return self._pandas

    # -- methods -------------------------------------------------------------
    def ping(self, _params: dict) -> dict:
        vizro, _vm, _V = self._load()
        pd = self._pd()
        return {
            "vizro": vizro.__version__,
            "python": sys.version.split()[0],
            "pandas": pd.__version__,
            "platform": sys.platform,
            "cwd": os.getcwd(),
        }

    def models(self, _params: dict) -> dict:
        vizro, vm, _V = self._load()
        names = [n for n in getattr(vm, "__all__", []) if not n.startswith("_")]
        out = []
        for name in names:
            obj = getattr(vm, name, None)
            doc = (getattr(obj, "__doc__", "") or "").strip().splitlines()
            out.append({"name": name, "description": doc[0].strip() if doc else ""})
        return {"vizro": vizro.__version__, "count": len(out), "models": out}

    def schema(self, params: dict) -> dict:
        vizro, vm, _V = self._load()
        model_name = params.get("model")
        if not model_name:
            raise SidecarError("missing_param", "schema requires `model` (call models first)")
        names = [n for n in getattr(vm, "__all__", []) if not n.startswith("_")]
        if model_name not in names:
            raise SidecarError(
                "unknown_model",
                f"Unknown Vizro model {model_name!r}.",
                {"available": names},
            )
        model = getattr(vm, model_name)
        js = model.model_json_schema(schema_generator=_inline_schema_class())
        js = _enhance_schema(model_name, js)
        return {"vizro": vizro.__version__, "model": model_name, "json_schema": js}

    def check_code(self, params: dict) -> dict:
        """Import a user's app module in a child process; never call app.run().

        `python <file>` would execute the `if __name__ == "__main__": app.run()`
        block and block on a server, so the child imports the file as a module
        instead and inspects the resulting globals.
        """
        code_path = params.get("code_path")
        if not code_path:
            raise SidecarError("missing_param", "code validation requires `code_path`")
        if not os.path.exists(code_path):
            raise SidecarError("file_not_found", f"App file not found: {code_path}")
        workdir = params.get("workdir") or os.path.dirname(os.path.abspath(code_path))
        timeout = float(params.get("timeout_s") or 120)

        harness = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_app.py")
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["VIZRO_CODE_PATH"] = os.path.abspath(code_path)
        env["Vizro_Check_Workdir"] = workdir
        try:
            completed = _run([sys.executable, "-X", "utf8", harness], cwd=workdir, env=env, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            raise SidecarError("exec_error", f"Could not start the validation child: {exc}") from exc

        payload = None
        for line in reversed((completed.stdout or "").splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    payload = json.loads(line)
                    break
                except Exception:  # noqa: BLE001
                    continue
        if payload is None:
            payload = {
                "valid": False,
                "errors": [
                    {
                        "loc": "",
                        "type": "harness_output_missing",
                        "msg": (completed.stderr or completed.stdout or "")[-1500:],
                        "input": None,
                    }
                ],
            }
        payload["exit_code"] = completed.returncode
        if completed.returncode != 0 and payload.get("valid"):
            payload["valid"] = False
        payload["stderr_tail"] = (completed.stderr or "")[-2000:] if completed.returncode != 0 else ""
        return payload

    def validate(self, params: dict) -> dict:
        if params.get("code_path"):
            return self.check_code(params)
        vizro, vm, Vizro = self._load()
        config = params.get("config")
        fmt = params.get("format") or "python-dict"
        if config is None:
            raise SidecarError("missing_param", "validate requires `config` (JSON/YAML) or `code_path` (Python app)")
        if isinstance(config, str):
            if fmt == "yaml":
                import yaml

                try:
                    config = yaml.safe_load(config)
                except Exception as exc:  # noqa: BLE001
                    raise SidecarError("yaml_error", f"YAML parse failed: {exc}") from exc
            else:
                try:
                    config = json.loads(config)
                except Exception as exc:  # noqa: BLE001
                    raise SidecarError("json_error", f"JSON parse failed: {exc}") from exc
        if not isinstance(config, dict):
            raise SidecarError("invalid_config", "config must be an object/dict of Vizro models")

        data_error = self._register_data(params.get("data") or {})
        allow = params.get("allow_undefined") or []
        context = {"allow_undefined_captured_callable": list(allow)}

        Vizro._reset()
        try:
            dashboard = vm.Dashboard.model_validate(config, context=context)
        except Exception as exc:  # noqa: BLE001
            Vizro._reset()
            failure = self._validation_failure(exc)
            if data_error:
                failure["data_error"] = data_error
            return failure
        try:
            python_code = dashboard._to_python()
        except Exception as exc:  # noqa: BLE001
            Vizro._reset()
            return {
                "valid": True,
                "vizro": vizro.__version__,
                "python_code": None,
                "render_error": f"{type(exc).__name__}: {exc}",
                "stats": _dashboard_stats(dashboard),
            }
        stats = _dashboard_stats(dashboard)
        Vizro._reset()
        return {"valid": True, "vizro": vizro.__version__, "python_code": python_code, "stats": stats}

    def _register_data(self, entries: dict) -> str | None:
        """Make named data sources resolvable before validation, as YAML/JSON needs."""
        if not entries:
            return None
        try:
            from vizro.managers import data_manager
        except Exception as exc:  # noqa: BLE001
            return f"data_manager unavailable: {exc}"
        pd = self._pd()
        for name, spec in entries.items():
            try:
                if isinstance(spec, str):
                    spec = {"path": spec}
                if not isinstance(spec, dict):
                    raise SidecarError("invalid_data", f"data[{name}] must be a path or an object")
                if spec.get("builtin"):
                    import vizro.plotly.express as px

                    loader = getattr(px.data, str(spec["builtin"]), None)
                    if loader is None:
                        raise SidecarError(
                            "unknown_builtin",
                            f"Unknown builtin dataset {spec['builtin']!r}",
                            {"available": ["iris", "tips", "stocks", "gapminder", "wind", "election"]},
                        )
                    frame = loader()
                elif spec.get("records"):
                    frame = pd.DataFrame(spec["records"])
                elif spec.get("path"):
                    frame = _load_frame(pd, spec["path"])
                else:
                    raise SidecarError("invalid_data", f"data[{name}] needs builtin, path or records")
                data_manager[name] = frame
            except SidecarError:
                raise
            except Exception as exc:  # noqa: BLE001
                return f"data[{name}] failed: {type(exc).__name__}: {exc}"
        return None

    def _validation_failure(self, exc: Exception) -> dict:
        errors = []
        if hasattr(exc, "errors") and callable(exc.errors):
            try:
                for err in exc.errors():
                    loc = err.get("loc") or ()
                    errors.append(
                        {
                            "loc": ".".join(str(part) for part in loc),
                            "type": err.get("type"),
                            "msg": err.get("msg"),
                            "input": _truncate(err.get("input")),
                        }
                    )
            except Exception:  # noqa: BLE001
                pass
        if not errors:
            errors = [{"loc": "", "type": type(exc).__name__, "msg": str(exc), "input": None}]
        return {
            "valid": False,
            "error_type": type(exc).__name__,
            "message": f"{len(errors)} validation error(s)",
            "errors": errors,
            "hint": "Fix the reported fields and validate again; call schema for the exact field contract.",
        }

    def profile(self, params: dict) -> dict:
        pd = self._pd()
        path = params.get("path")
        if not path:
            raise SidecarError("missing_param", "profile requires `path`")
        if not os.path.exists(path):
            raise SidecarError("file_not_found", f"Data file not found: {path}")
        sample_rows = int(params.get("sample_rows") or 5)
        top_k = int(params.get("top_k") or 8)
        max_unique = int(params.get("max_unique") or 200)

        frame = _load_frame(pd, path)

        columns = []
        for name in list(frame.columns):
            series = frame[name]
            non_null = int(series.notna().sum())
            total = int(len(frame)) or 1
            nunique = int(series.nunique(dropna=True))
            entry: dict[str, Any] = {
                "name": str(name),
                "dtype": str(series.dtype),
                "non_null": non_null,
                "null_pct": round((total - non_null) * 100.0 / total, 2),
                "nunique": nunique if nunique <= max_unique else f">{max_unique}",
            }
            if pd.api.types.is_numeric_dtype(series):
                numeric = series.dropna()
                if len(numeric):
                    entry["min"] = float(numeric.min())
                    entry["max"] = float(numeric.max())
                    entry["mean"] = round(float(numeric.mean()), 6)
            elif pd.api.types.is_datetime64_any_dtype(series):
                valid = series.dropna()
                if len(valid):
                    entry["min"] = valid.min().isoformat()
                    entry["max"] = valid.max().isoformat()
            if not pd.api.types.is_numeric_dtype(series) or nunique <= top_k:
                counts = series.value_counts(dropna=True)
                items = sorted(counts.items(), key=lambda kv: (-int(kv[1]), str(kv[0])))[:top_k]
                entry["top"] = [{"value": _json_default(value), "count": int(count)} for value, count in items]
            columns.append(entry)

        sample = _records(frame.head(sample_rows))
        return {
            "path": os.path.abspath(path),
            "rows": int(len(frame)),
            "columns_count": int(len(frame.columns)),
            "columns": columns,
            "sample": sample,
            "sample_rows": min(sample_rows, len(frame)),
        }

    # -- dispatch ------------------------------------------------------------
    def dispatch(self, method: str, params: dict) -> Any:
        handlers = {
            "ping": self.ping,
            "models": self.models,
            "schema": self.schema,
            "validate": self.validate,
            "profile": self.profile,
        }
        handler = handlers.get(method)
        if handler is None:
            raise SidecarError("unknown_method", f"Unknown method {method!r}", {"available": sorted(handlers)})
        return handler(params or {})


def _records(frame) -> list[dict]:
    """JSON-safe records, deterministically ordered."""
    out = []
    for record in frame.to_dict("records"):
        clean = {}
        for key, value in record.items():
            if value is None:
                clean[str(key)] = None
            else:
                try:
                    import math

                    if isinstance(value, float) and math.isnan(value):
                        clean[str(key)] = None
                        continue
                except Exception:  # noqa: BLE001
                    pass
                clean[str(key)] = _json_default(value) if not isinstance(value, (str, int, float, bool, list, dict)) else value
        out.append(clean)
    return out


def _dashboard_stats(dashboard) -> dict:
    try:
        pages = getattr(dashboard, "pages", []) or []
        components = 0
        for page in pages:
            components += len(getattr(page, "components", []) or [])
        return {"pages": len(pages), "components": components}
    except Exception:  # noqa: BLE001
        return {}


_FIGURE_HINT = {
    "type": "object",
    "description": (
        "Plotly figure in captured-callable form: {_target_: <name>, data_frame: <registered data source>, "
        "...plotly kwargs}. For `type: graph` the name is a plotly.express function without module prefix, "
        "e.g. scatter, bar, line, area, histogram, box, violin, pie, treemap, heatmap, density_heatmap. "
        "For `type: figure` use kpi_card / kpi_card_reference; for `type: table` use dash_ag_grid. "
        "data_frame must be a name registered in data_manager. In Python write "
        "vm.Graph(figure=px.scatter(...)) instead."
    ),
    "properties": {
        "_target_": {
            "type": "string",
            "description": "Callable name: scatter, bar, line, histogram, kpi_card, dash_ag_grid, or a custom chart name.",
        },
        "data_frame": {"type": "string", "description": "Name of a data source registered in data_manager."},
    },
    "required": ["_target_", "data_frame"],
}

_ACTIONS_HINT = {
    "type": "array",
    "description": (
        "Interaction chain. Built-in actions: "
        '{"type": "export_data"}, {"type": "set_controls", "controls": ["filter-id"]}, '
        '{"type": "show_notification", "message": "..."}. '
        "Custom actions need the Python API."
    ),
    "items": {"type": "object"},
}

_SCHEMA_FIGURE_MODELS = ("Graph", "Table", "Figure")

_INLINE_SCHEMA_CLASS = None


def _enhance_schema(model_name: str, schema: dict) -> dict:
    """Re-attach the fields Vizro intentionally keeps out of the JSON Schema.

    `figure` and `function` hold callables, so Vizro's Pydantic schema omits them.
    An agent writing JSON needs their contract anyway; the description states the
    captured-callable form rather than inventing a different one.
    """
    properties = schema.setdefault("properties", {})
    if model_name in _SCHEMA_FIGURE_MODELS and "figure" not in properties:
        properties["figure"] = _FIGURE_HINT
    if model_name in ("Card", "Container", "Tabs", "Page", "ControlGroup") and "actions" in properties:
        properties["actions"] = _ACTIONS_HINT
    if model_name == "Button" and "actions" in properties:
        properties["actions"] = _ACTIONS_HINT
    return schema


def _inline_schema_class():
    """Build (once) a GenerateJsonSchema subclass that inlines the top-level $ref.

    Pydantic instantiates the schema generator, so this must be a class, not an
    instance; keeping the import lazy avoids importing pydantic for `ping`.
    """
    global _INLINE_SCHEMA_CLASS
    if _INLINE_SCHEMA_CLASS is not None:
        return _INLINE_SCHEMA_CLASS

    from pydantic.json_schema import GenerateJsonSchema

    class Inline(GenerateJsonSchema):
        def generate(self, schema, mode="validation"):
            result = super().generate(schema, mode=mode)
            if "$ref" in result and "properties" not in result:
                ref = result["$ref"]
                if isinstance(ref, str) and ref.startswith("#/$defs/"):
                    name = ref.split("/")[-1]
                    defs = result.get("$defs") or {}
                    if name in defs:
                        result.update(defs[name])
                        result.pop("$ref", None)
            result.pop("$defs", None)
            return result

    _INLINE_SCHEMA_CLASS = Inline
    return Inline


def _load_frame(pd, path: str):
    lower = path.lower()
    if lower.endswith((".csv", ".txt")):
        return pd.read_csv(path)
    if lower.endswith(".tsv"):
        return pd.read_csv(path, sep="\t")
    if lower.endswith(".jsonl"):
        return pd.read_json(path, lines=True)
    if lower.endswith(".json"):
        return pd.read_json(path)
    if lower.endswith((".xlsx", ".xls", ".xlsm")):
        return pd.read_excel(path)
    if lower.endswith(".parquet"):
        return pd.read_parquet(path)
    raise SidecarError("unsupported_format", f"Unsupported data file type: {os.path.splitext(path)[1] or '(none)'}")


def _run(argv: list[str], cwd: str, env: dict, timeout: float):
    import subprocess

    return subprocess.run(  # noqa: S603 - argv is fully controlled by this worker
        argv,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def main() -> int:
    worker = Worker()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method") or ""
            if method == "shutdown":
                _emit({"id": request_id, "ok": True, "result": {"bye": True}})
                return 0
            result = worker.dispatch(method, request.get("params") or {})
            _emit({"id": request_id, "ok": True, "result": result})
        except SidecarError as exc:
            _emit({"id": request_id, "ok": False, "error": {"type": exc.type, "message": exc.message, "detail": exc.detail}})
        except Exception as exc:  # noqa: BLE001
            _emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "type": type(exc).__name__,
                        "message": str(exc),
                        "detail": traceback.format_exc(limit=6),
                    },
                }
            )
    return 0


if __name__ == "__main__":
    try:
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    raise SystemExit(main())
