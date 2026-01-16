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
import base64
import re


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


def _github_extra_header(token: str) -> str:
    credentials = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("utf-8")
    return f"AUTHORIZATION: basic {credentials}"


def _is_github_repo(url: str) -> bool:
    return bool(re.search(r"github\.com[:/]", url, re.IGNORECASE))


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

    extraheader = None
    github_token = os.environ.get("OPENCODE_GITHUB_APP_TOKEN", "").strip()
    if github_token and _is_github_repo(repo_url):
        extraheader = _github_extra_header(github_token)

    # bootstrap repo
    if not os.path.isdir("repo/.git"):
        if extraheader:
            subprocess.run(
                ["git", "-c", f"http.https://github.com/.extraheader={extraheader}", "clone", repo_url, "repo"],
                check=True,
            )
        else:
            subprocess.run(["git", "clone", repo_url, "repo"], check=True)
    os.chdir(os.path.join(workdir, "repo"))
    if extraheader:
        subprocess.run(["git", "config", "--local", "http.https://github.com/.extraheader", extraheader], check=True)
    subprocess.run(["git", "fetch", "--all", "--tags"], check=True)
    subprocess.run(["git", "checkout", repo_ref], check=True)
    auto_branch = os.environ.get("OPENCODE_AUTO_BRANCH", "1").strip().lower() not in ("0", "false", "no")
    if auto_branch:
        current_branch = subprocess.check_output(["git", "rev-parse", "--abbrev-ref", "HEAD"], text=True).strip()
        if current_branch in ("main", "master", "HEAD"):
            suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
            branch_name = f"opencode/auto-{int(time.time())}-{suffix}"
            subprocess.run(["git", "checkout", "-b", branch_name], check=True)

    # release sync lock
    os.chdir(workdir)
    try:
        os.remove(".opencode/sync.pending")
    except Exception:
        pass

    repo_dir = os.path.join(workdir, "repo")
    server_source = os.environ.get("OPENCODE_SERVER_SOURCE", "").strip().lower()
    server_repo_url = os.environ.get("OPENCODE_SERVER_REPO_URL", "").strip()
    server_repo_ref = os.environ.get("OPENCODE_SERVER_REPO_REF", "").strip()
    use_repo_server = server_source in ("1", "true", "yes", "repo", "source", "dev") or bool(server_repo_url)
    server_repo_dir = repo_dir

    if use_repo_server and server_repo_url:
        server_repo_dir = os.path.join(workdir, "opencode-server")
        if not os.path.isdir(os.path.join(server_repo_dir, ".git")):
            if extraheader and _is_github_repo(server_repo_url):
                try:
                    subprocess.run(
                        [
                            "git",
                            "-c",
                            f"http.https://github.com/.extraheader={extraheader}",
                            "clone",
                            server_repo_url,
                            server_repo_dir,
                        ],
                        check=True,
                    )
                except subprocess.CalledProcessError:
                    subprocess.run(["git", "clone", server_repo_url, server_repo_dir], check=True)
            else:
                subprocess.run(["git", "clone", server_repo_url, server_repo_dir], check=True)
        os.chdir(server_repo_dir)
        subprocess.run(["git", "fetch", "--all", "--tags"], check=True)
        if server_repo_ref:
            subprocess.run(["git", "checkout", server_repo_ref], check=True)

    if use_repo_server and not server_repo_url:
        if not os.path.exists(os.path.join(repo_dir, "packages", "opencode", "src", "index.ts")):
            use_repo_server = False
        else:
            server_repo_dir = repo_dir

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

    server_cwd = repo_dir
    if use_repo_server:
        bun_bin = os.environ.get("OPENCODE_BUN_BIN", "/root/.bun/bin/bun")
        if not os.path.isdir(os.path.join(server_repo_dir, "node_modules")):
            subprocess.run([bun_bin, "install"], cwd=server_repo_dir, check=True)
        opencode_dir = os.path.join(server_repo_dir, "packages", "opencode")
        server_cwd = opencode_dir
        args = [
            bun_bin,
            "--conditions=browser",
            os.path.join(opencode_dir, "src", "index.ts"),
            "serve",
            "--hostname",
            "0.0.0.0",
            "--port",
            str(port),
        ]
    else:
        # Run opencode server from the installed binary, not from the repo.
        args = [
            "opencode",
            "serve",
            "--hostname",
            "0.0.0.0",
            "--port",
            str(port),
        ]
    cors_raw = os.environ.get("OPENCODE_SERVER_CORS", "")
    if cors_raw.strip():
        for entry in cors_raw.split(","):
            value = entry.strip()
            if value:
                args.extend(["--cors", value])
    env = {
        **os.environ,
        "XDG_CONFIG_HOME": xdg_config,
        "XDG_DATA_HOME": xdg_data,
        "XDG_STATE_HOME": xdg_state,
        "XDG_CACHE_HOME": xdg_cache,
        "PATH": f"/root/.bun/bin:/root/.opencode/bin:/root/.local/bin:/usr/local/bin:{os.environ.get('PATH', '')}",
        # Force server instance directory to sandbox-local repo root even if client
        # mistakenly sends a host-local directory header.
        "OPENCODE_SERVER_DIRECTORY": repo_dir,
        # Speed/operability defaults for sandboxes:
        # - avoid downloading/installing default plugins (can block first request for a long time)
        # - avoid LSP downloads/spawns
        "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
        "OPENCODE_DISABLE_LSP_DOWNLOAD": "true",
        "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true",
    }
    env.setdefault("OPENCODE_SSE_HEARTBEAT_MS", "10000")
    subprocess.Popen(args, cwd=server_cwd, env=env)
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
        # Dev-friendly image: includes Python (for Modal), git/curl, and the opencode binary.
        modal_image = (
            modal.Image.debian_slim(python_version=python_version)
            .apt_install("git", "curl", "ca-certificates", "bash")
            .run_commands(
                "curl -fsSL https://bun.sh/install | bash",
                "if [ -x /root/.bun/bin/bun ]; then ln -sf /root/.bun/bin/bun /usr/local/bin/bun; fi",
                "OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash",
                "if [ -x /root/.opencode/bin/opencode ]; then ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode; fi",
                "if [ -x /root/.local/bin/opencode ]; then ln -sf /root/.local/bin/opencode /usr/local/bin/opencode; fi",
                "/usr/local/bin/bun --version",
                "/usr/local/bin/opencode --version",
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
