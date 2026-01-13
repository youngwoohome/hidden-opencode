#!/usr/bin/env python3
"""
Modal sandbox helper for opencode (REAL Modal SDK implementation).

This script is executed by the local opencode CLI and prints a single JSON object to stdout.

Contract:
- create <json>  -> prints SandboxHandle JSON (includes public url)
- stop <json>    -> prints {"ok": true}

Requirements:
- Python package: modal  (pip install modal)
- Modal auth configured locally (modal setup / modal token new)
- OPENCODE_MODAL_IMAGE must be set (or passed via payload["modal"]["image"])

Notes:
- We deploy a unique Modal App per sandbox so it can live independently of this script process.
- Modal SDK does not currently expose a stable "stop deployed app" API, so stop uses Modal CLI:
  `modal app stop <app_name>`.
"""

import json
import sys
import time
from typing import Any, Dict
import random
import string
import os
import subprocess
import contextlib
import io


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def parse_arg_json() -> Dict[str, Any]:
    if len(sys.argv) < 3:
        die("missing json argument")
    raw = sys.argv[2]
    try:
        return json.loads(raw)
    except Exception as e:
        die(f"invalid json: {e}")


# Modal requires functions to be defined at module (global) scope unless `serialized=True`.
# We intentionally avoid `serialized=True` because it introduces a strict coupling between
# the local Python version (used to define/serialize the function) and the remote Image
# Python version. That coupling broke for you (local 3.13 vs image 3.11).
#
# IMPORTANT:
# Do NOT decorate this function with `@modal.web_server` at import time. That produces a
# PartialFunction object, and wrapping it again with `app.function()` can fail at runtime.
# Instead, keep this as a plain Python function and apply `modal.web_server(...)` inside cmd_create().
try:
    import modal  # type: ignore
except Exception:
    modal = None


def _require_modal():
    if modal is None:
        die("Modal SDK is not installed. Install with: python -m pip install -U modal")
    return modal


def opencode_server() -> None:
    """
    Runs inside the Modal container. All configuration is passed via env vars.
    """
    repo_url = os.environ.get("OPENCODE_REPO_URL")
    repo_ref = os.environ.get("OPENCODE_REPO_REF")
    if not repo_url or not repo_ref:
        raise RuntimeError("Missing OPENCODE_REPO_URL / OPENCODE_REPO_REF")

    workdir = os.environ.get("OPENCODE_SANDBOX_WORKDIR", "/work")
    os.makedirs(workdir, exist_ok=True)
    os.chdir(workdir)

    # sync gating: block writes while syncing repository
    os.makedirs(".opencode", exist_ok=True)
    with open(".opencode/sync.pending", "w", encoding="utf-8") as f:
        f.write("pending\n")

    # bootstrap repo
    if not os.path.isdir("repo/.git"):
        subprocess.run(["git", "clone", repo_url, "repo"], check=True)
    os.chdir(os.path.join(workdir, "repo"))
    subprocess.run(["git", "fetch", "--all", "--tags"], check=True)
    subprocess.run(["git", "checkout", repo_ref], check=True)

    # release sync lock
    os.chdir(workdir)
    try:
        os.remove(".opencode/sync.pending")
    except Exception:
        pass

    repo_dir = os.path.join(workdir, "repo")

    # Make server boot deterministic and fast in sandboxes:
    # - avoid writing to /root XDG dirs
    # - avoid Config.installDependencies side-effects by ensuring node_modules exists in config dir
    xdg_base = os.path.join(workdir, ".xdg")
    xdg_config = os.path.join(xdg_base, "config")
    xdg_data = os.path.join(xdg_base, "data")
    xdg_state = os.path.join(xdg_base, "state")
    xdg_cache = os.path.join(xdg_base, "cache")
    os.makedirs(xdg_config, exist_ok=True)
    os.makedirs(xdg_data, exist_ok=True)
    os.makedirs(xdg_state, exist_ok=True)
    os.makedirs(xdg_cache, exist_ok=True)
    os.makedirs(os.path.join(xdg_config, "opencode", "node_modules"), exist_ok=True)

    # Disable LSP in sandbox to avoid cold-start downloads/spawns and reduce request latency.
    # (Project config is highest precedence and will be discovered from repo root.)
    try:
        with open(os.path.join(repo_dir, "opencode.json"), "w", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "$schema": "https://opencode.ai/config.json",
                        "lsp": False,
                        "plugin": [],
                    }
                )
            )
    except Exception:
        pass

    # start opencode server (child process)
    #
    # IMPORTANT (Modal web_server contract):
    # The web_server wrapper expects this function to *start* a server listening on the given port
    # and then return. Modal will wait up to startup_timeout for the port to become reachable and
    # will proxy HTTP traffic to it. If we block here, requests can appear "pending" forever.
    port = os.environ.get("OPENCODE_PORT", "4096")

    # Run opencode server FROM THE CLONED REPO so local patches are reflected in the sandbox.
    # This requires Bun (installed in the image build below).
    try:
        subprocess.run(["bun", "install"], cwd=repo_dir, check=False)
    except Exception:
        pass

    args = [
        "bun",
        "run",
        "--cwd",
        os.path.join(repo_dir, "packages", "opencode"),
        "--conditions=browser",
        "src/index.ts",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        str(port),
    ]
    env = {
        **os.environ,
        "XDG_CONFIG_HOME": xdg_config,
        "XDG_DATA_HOME": xdg_data,
        "XDG_STATE_HOME": xdg_state,
        "XDG_CACHE_HOME": xdg_cache,
        # Force server instance directory to sandbox-local repo root even if client
        # mistakenly sends a host-local directory header.
        "OPENCODE_SERVER_DIRECTORY": repo_dir,
        # Speed/operability defaults for sandboxes:
        # - avoid downloading/installing default plugins (can block first request for a long time)
        # - avoid LSP downloads/spawns
        "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
        "OPENCODE_DISABLE_LSP_DOWNLOAD": "true",
        "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true",
        "OPENCODE_SSE_HEARTBEAT_MS": "10000",
    }
    subprocess.Popen(args, cwd=repo_dir, env=env)
    return


def cmd_create(payload: Dict[str, Any]) -> None:
    modal = _require_modal()

    repo = payload.get("repo") or {}
    resources = payload.get("resources") or {}
    ttl = payload.get("ttl") or {}
    env = payload.get("env") or {}
    name = payload.get("name")
    modal_cfg = (payload.get("modal") or {})
    image = modal_cfg.get("image")
    app = modal_cfg.get("app")

    repo_url = repo.get("url")
    repo_ref = repo.get("ref")
    if not repo_url or not repo_ref:
        die("payload.repo.url and payload.repo.ref are required")

    def pick_suffix(n: int = 8) -> str:
        alphabet = string.ascii_lowercase + string.digits
        return "".join(random.choice(alphabet) for _ in range(n))

    created = int(time.time() * 1000)
    # Use provided app name if given (advanced usage), otherwise make a unique one.
    app_name = str(app).strip() if app else f"opencode-sandbox-{created}-{pick_suffix()}"

    # Resource mapping (best-effort)
    cpu = resources.get("cpu")
    mem_mb = resources.get("memoryMB")

    # TTL mapping:
    # For deployed web endpoints, "timeout" doesn't represent lifetime. We still return expiresAt for UX.
    ttl_seconds = ttl.get("ttlSeconds")
    expires = created + int(ttl_seconds) * 1000 if isinstance(ttl_seconds, int) else None

    # Build Modal image reference.
    #
    # IMPORTANT:
    # Modal Functions *run Python* (this file), so the container must have a working Python runtime
    # that Modal can introspect. The `ghcr.io/anomalyco/opencode` image is optimized for the opencode
    # binary and can be incompatible with Modal's Python runtime detection (even if we try add_python),
    # causing ConflictError about Python version.
    #
    # For reliability, we default to a Modal-native Debian base image with Python, then install:
    # - git (repo bootstrap)
    # - opencode (via official install script -> GitHub releases)
    #
    # If you *really* want to try using the registry image directly, set:
    #   OPENCODE_MODAL_USE_REGISTRY_IMAGE=1
    python_version = os.environ.get("OPENCODE_MODAL_PYTHON_VERSION", "3.11")
    use_registry = os.environ.get("OPENCODE_MODAL_USE_REGISTRY_IMAGE", "").strip() in ("1", "true", "yes")
    debug_output = os.environ.get("OPENCODE_MODAL_ENABLE_OUTPUT", "").strip() in ("1", "true", "yes")

    if use_registry and not image:
        die("OPENCODE_MODAL_IMAGE is required when OPENCODE_MODAL_USE_REGISTRY_IMAGE=1")

    if use_registry:
        # Best-effort: may still fail depending on base image.
        modal_image = modal.Image.from_registry(str(image), add_python=python_version)
    else:
        # Dev-friendly image: includes Python (for Modal), git/curl, and Bun so we can run
        # the cloned repo's opencode server code (including local patches) directly.
        modal_image = (
            modal.Image.debian_slim(python_version=python_version)
            # Bun installer expects unzip; we also keep tar/gzip around for convenience.
            .apt_install("git", "curl", "ca-certificates", "unzip", "tar", "gzip")
            .run_commands(
                "curl -fsSL https://bun.sh/install | bash",
                "ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
                "bun --version",
                "git --version",
            )
        )

    # Web server port (inside container). Keep fixed to match web_server decorator.
    port = 4096

    app_obj = modal.App(app_name)

    # IMPORTANT: bind to 0.0.0.0 so Modal can route requests.
    merged_env: Dict[str, str] = {k: str(v) for k, v in env.items()}
    merged_env["OPENCODE_REPO_URL"] = str(repo_url)
    merged_env["OPENCODE_REPO_REF"] = str(repo_ref)
    merged_env["OPENCODE_PORT"] = str(port)

    allow_concurrent_inputs: Any = os.environ.get("OPENCODE_MODAL_CONCURRENCY")
    if allow_concurrent_inputs is None:
        allow_concurrent_inputs = 8
    else:
        try:
            allow_concurrent_inputs = int(allow_concurrent_inputs)
        except Exception:
            allow_concurrent_inputs = None

    fn_kwargs: Dict[str, Any] = {
        "image": modal_image,
        "env": merged_env,
    }
    if allow_concurrent_inputs is not None:
        fn_kwargs["allow_concurrent_inputs"] = allow_concurrent_inputs
    if cpu is not None:
        fn_kwargs["cpu"] = float(cpu)
    if mem_mb is not None:
        fn_kwargs["memory"] = int(mem_mb)

    # Register global function with this app and expose it as a web server.
    # Apply `web_server` HERE (not at module import time) to avoid PartialFunction issues.
    # Also set a generous startup_timeout for cold starts (git clone + server boot).
    #
    # CRITICAL (statefulness):
    # opencode stores session state on local disk. Modal web endpoints can route requests to different
    # containers unless constrained. To avoid "session file not found" races, force a single container.
    web = modal.web_server(port=port, startup_timeout=120.0)(opencode_server)
    def bind_function(use_minmax: bool, use_concurrency: bool):
        kwargs = dict(fn_kwargs)
        if not use_concurrency:
            kwargs.pop("allow_concurrent_inputs", None)
        if use_minmax:
            return app_obj.function(**kwargs, min_containers=1, max_containers=1)(web)
        return app_obj.function(**kwargs)(web)

    opencode_fn = None
    last_err = None
    for use_concurrency in (True, False):
        for use_minmax in (True, False):
            try:
                opencode_fn = bind_function(use_minmax, use_concurrency)
                break
            except TypeError as e:
                last_err = e
        if opencode_fn is not None:
            break
    if opencode_fn is None:
        # Re-raise the last failure to preserve the error context.
        raise last_err

    # Deploy app so URL persists beyond this script process.
    #
    # CRITICAL:
    # Our TS caller expects stdout to be *pure JSON*. Modal deploy can emit progress logs and,
    # depending on Modal SDK internals, may also wrap/replace sys.stdout/sys.stderr. To prevent
    # any leakage and avoid "invalid JSON" parsing errors, we swallow all deploy output, then
    # explicitly write JSON to sys.__stdout__.
    # NOTE: image build failures are otherwise opaque (Modal suggests modal.enable_output()).
    # We keep stdout/stderr suppressed by default for JSON hygiene, but allow opt-in logs.
    try:
        if debug_output:
            try:
                modal.enable_output()  # type: ignore[attr-defined]
            except Exception:
                pass
            app_obj.deploy()
        else:
            deploy_out = io.StringIO()
            deploy_err = io.StringIO()
            with contextlib.redirect_stdout(deploy_out), contextlib.redirect_stderr(deploy_err):
                app_obj.deploy()
    except Exception as e:
        extra = ""
        if not debug_output:
            extra = "\n\n".join(
                s for s in [deploy_out.getvalue().strip(), deploy_err.getvalue().strip()] if s
            )
        hint = "Set OPENCODE_MODAL_ENABLE_OUTPUT=1 and re-run to see Modal image build logs."
        die(f"Modal deploy failed: {e}\n{hint}\n{extra}".strip())

    try:
        web_url = opencode_fn.get_web_url()  # type: ignore
    except Exception as e:
        die(f"Failed to get web URL from Modal deployment: {e}")

    handle = {
        "id": app_name,
        "provider": "modal",
        "url": web_url,
        "repo": {"url": repo_url, "ref": repo_ref},
        "resources": resources if resources else None,
        "ttl": ttl if ttl else None,
        "time": {"created": created, "expires": expires},
        "metadata": {
            "name": name,
            "image": image or "debian_slim+bun",
            "app": app_name,
            "function": "opencode_server",
        },
    }

    # Prune nulls for cleaner JSON (Modal/Zod schemas expect "optional", not explicit nulls).
    def prune_none(x: Any) -> Any:
        if isinstance(x, dict):
            out: Dict[str, Any] = {}
            for k, v in x.items():
                if v is None:
                    continue
                pv = prune_none(v)
                if pv is None:
                    continue
                out[k] = pv
            return out
        if isinstance(x, list):
            out_list = []
            for v in x:
                if v is None:
                    continue
                pv = prune_none(v)
                if pv is None:
                    continue
                out_list.append(pv)
            return out_list
        return x

    handle = prune_none(handle)
    output_file = os.environ.get("OPENCODE_MODAL_OUTPUT_FILE")
    if output_file:
        try:
            with open(output_file, "w", encoding="utf-8") as f:
                f.write(json.dumps(handle))
        except Exception as e:
            die(f"failed to write output file {output_file}: {e}")
    # Keep stdout output for manual debugging, but callers should prefer OPENCODE_MODAL_OUTPUT_FILE.
    sys.__stdout__.write(json.dumps(handle) + "\n")
    sys.__stdout__.flush()


def cmd_stop(payload: Dict[str, Any]) -> None:
    sandbox_id = payload.get("id")
    if not sandbox_id:
        die("missing id")
    # Modal SDK does not currently provide a public "stop deployed app" API.
    # Use Modal CLI as the official lifecycle operation.
    try:
        res = subprocess.run(
            ["modal", "app", "stop", str(sandbox_id)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        die("Modal CLI not found. Install Modal and ensure `modal` is in PATH.")

    if res.returncode != 0:
        die(f"modal app stop failed:\n{res.stderr.strip() or res.stdout.strip()}")

    print(json.dumps({"ok": True}))


def main() -> None:
    if len(sys.argv) < 2:
        die("usage: opencode_modal_sandbox.py <create|stop> <json>")
    cmd = sys.argv[1]
    payload = parse_arg_json()
    if cmd == "create":
        cmd_create(payload)
    elif cmd == "stop":
        cmd_stop(payload)
    else:
        die(f"unknown command: {cmd}")


if __name__ == "__main__":
    main()
