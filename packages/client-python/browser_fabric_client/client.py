from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import os
from pathlib import Path
import re
import time
from typing import Any, Callable, Mapping
from urllib.parse import quote

import httpx


@dataclass(slots=True)
class FabricError(Exception):
    code: str
    detail: str
    status: int
    details: Mapping[str, Any] | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.detail}"


_TERMINAL_SESSION_STATES = frozenset({"released", "cancelled", "failed", "timed_out"})
_TERMINAL_JOB_STATES = frozenset({"succeeded", "failed", "blocked_challenge", "auth_required", "timed_out", "cancelled"})
_ACTIONABLE_JOB_STATES = frozenset({"awaiting_input", "awaiting_manual"})
_KNOWN_CODES = frozenset(
    {
        "authentication_required",
        "authorization_denied",
        "not_found",
        "conflict",
        "validation_failed",
        "idempotency_conflict",
        "invalid_state",
        "capacity_exhausted",
        "capability_invalid",
        "capability_expired",
        "secret_rejected",
        "worker_unavailable",
        "deadline_exceeded",
        "internal_error",
    }
)
_ARTIFACT_KINDS = frozenset({"screenshot", "mhtml", "trace", "har", "download", "video", "log", "media_manifest"})


def _path_id(value: str) -> str:
    return quote(str(value), safe="")


def _validate_wait(timeout: float, poll_interval: float, max_poll_interval: float) -> None:
    if timeout <= 0 or timeout > 24 * 60 * 60:
        raise ValueError("timeout must be between 0 and 24 hours")
    if poll_interval <= 0 or max_poll_interval < poll_interval:
        raise ValueError("poll intervals are invalid")


def encrypt_input_for_worker(*, request: Mapping[str, Any], value: str, now: float | None = None) -> dict[str, Any]:
    """Encrypt one transient value for the exact worker public key in a request."""
    import base64
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from secrets import token_bytes
    from datetime import datetime

    worker_id = request.get("workerId")
    public_key_pem = request.get("workerInputEncryptionPublicKeyPem")
    request_id = request.get("id")
    expires_at = request.get("expiresAt")
    if not isinstance(worker_id, str) or not isinstance(public_key_pem, str) or not isinstance(request_id, str) or not isinstance(expires_at, str):
        raise FabricError("worker_unavailable", "input request does not contain a worker encryption key", 503)
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 16_384:
        raise FabricError("validation_failed", "ephemeral input must be non-empty and at most 16KiB", 400)
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp()
    except ValueError as error:
        raise FabricError("validation_failed", "input request expiry is invalid", 400) from error
    if expiry <= (time.time() if now is None else now):
        raise FabricError("invalid_state", "input request has expired", 409)
    encode = lambda data: base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")
    key = bytearray(token_bytes(32))
    iv = token_bytes(12)
    encrypted = AESGCM(bytes(key)).encrypt(iv, value.encode("utf-8"), None)
    try:
        public_key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
        wrapped = public_key.encrypt(bytes(key), padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
        return {"version": 1, "algorithm": "rsa-oaep-sha256+a256gcm", "requestId": request_id, "workerId": worker_id, "expiresAt": expires_at, "wrappedKey": encode(wrapped), "iv": encode(iv), "tag": encode(encrypted[-16:]), "ciphertext": encode(encrypted[:-16])}
    finally:
        key[:] = b"\x00" * len(key)


def _raise_response(response: httpx.Response) -> None:
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("code", "internal_error"))
    if code not in _KNOWN_CODES:
        code = "internal_error"
    detail = str(body.get("detail") or f"Fabric request failed ({response.status_code})")
    status = int(body.get("status") or response.status_code)
    details = body.get("details") if isinstance(body.get("details"), dict) else None
    raise FabricError(code, detail, status, details)


def _environment_configuration() -> tuple[str, dict[str, str]]:
    base_url = os.environ.get("FABRIC_API_URL", "").strip()
    if not base_url:
        raise RuntimeError("FABRIC_API_URL is required")
    username = os.environ.get("FABRIC_API_USERNAME", "").strip()
    password_file = os.environ.get("FABRIC_API_PASSWORD_FILE", "").strip()
    try:
        password = Path(password_file).read_text(encoding="utf-8").strip() if password_file else os.environ.get("FABRIC_API_PASSWORD", "").strip()
    except OSError as error:
        raise RuntimeError("FABRIC_API_PASSWORD could not be read") from error
    if not re.fullmatch(r"principal_[A-Za-z0-9][A-Za-z0-9_-]{0,127}", username):
        raise RuntimeError("FABRIC_API_USERNAME must be an opaque Fabric principal ID")
    if len(password) < 24 or len(password) > 4096 or any(character in password for character in "\0\r\n"):
        raise RuntimeError("FABRIC_API_PASSWORD must be a secret of 24 to 4096 characters")
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    headers = {"authorization": f"Basic {token}"}
    return base_url, headers


class BrowserFabricClient:
    """Synchronous Fabric client for workers and CLI adapters.

    The caller owns transport configuration by passing an httpx.Client when
    needed. The client uses a password-backed Basic credential from the
    environment; credentials are never read from or placed in job payloads.
    """

    def __init__(self, base_url: str, client: httpx.Client | None = None, headers: Mapping[str, str] | None = None, timeout: float = 30.0) -> None:
        if not base_url or not base_url.lower().startswith(("http://", "https://")):
            raise ValueError("base_url must be an HTTP(S) URL")
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=timeout)
        self._headers = dict(headers or {})

    @classmethod
    def from_environment(cls, *, client: httpx.Client | None = None) -> "BrowserFabricClient":
        base_url, headers = _environment_configuration()
        return cls(base_url, client=client, headers=headers)

    def close(self) -> None:
        self._client.close()

    def _request(self, method: str, path: str, payload: Mapping[str, Any] | None = None, idempotency_key: str | None = None) -> Any:
        headers = {"accept": "application/json", **self._headers}
        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key
        try:
            response = self._client.request(method, f"{self._base_url}{path}", json=payload, headers=headers)
        except httpx.HTTPError as error:
            raise FabricError("internal_error", "Fabric transport request failed", 502) from error
        if response.is_error:
            _raise_response(response)
        try:
            return response.json()
        except ValueError as error:
            raise FabricError("internal_error", "Fabric returned a non-JSON response", 502) from error

    def _upload_artifact(self, path: str, *, kind: str, content_type: str, data: bytes, label: str | None = None, extra_headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        if kind not in _ARTIFACT_KINDS:
            raise FabricError("validation_failed", "artifact kind is invalid", 400)
        if not content_type or len(content_type) > 255 or "\r" in content_type or "\n" in content_type:
            raise FabricError("validation_failed", "artifact content type is invalid", 400)
        if not isinstance(data, bytes) or len(data) > 32 * 1024 * 1024:
            raise FabricError("validation_failed", "artifact upload exceeds the configured limit", 413)
        headers = {"accept": "application/json", "content-type": content_type, "x-fabric-artifact-kind": kind, **(dict(extra_headers) if extra_headers else {}), **self._headers}
        if label is not None:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", label):
                raise FabricError("validation_failed", "artifact label is invalid", 400)
            headers["x-fabric-artifact-label"] = label
        try:
            response = self._client.request("POST", f"{self._base_url}{path}", content=data, headers=headers)
        except httpx.HTTPError as error:
            raise FabricError("internal_error", "Fabric transport request failed", 502) from error
        if response.is_error:
            _raise_response(response)
        try:
            return dict(response.json())
        except ValueError as error:
            raise FabricError("internal_error", "Fabric returned a non-JSON response", 502) from error

    def create_browser_session(self, request: Mapping[str, Any]) -> dict[str, Any]:
        key = request.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            raise ValueError("request.idempotencyKey is required")
        result = self._request("POST", "/browser-sessions", request, key)
        return dict(result)

    def get_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(self._request("GET", f"/browser-sessions/{_path_id(session_id)}"))

    def heartbeat_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/browser-sessions/{_path_id(session_id)}/heartbeat"))

    def release_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/browser-sessions/{_path_id(session_id)}/release"))

    def cancel_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/browser-sessions/{_path_id(session_id)}/cancel"))

    def browser_session_events(self, session_id: str, after: int | None = None) -> list[dict[str, Any]]:
        suffix = "" if after is None else f"?after={quote(str(after), safe='')}"
        return list(self._request("GET", f"/browser-sessions/{_path_id(session_id)}/events{suffix}"))

    def create_job(self, request: Mapping[str, Any]) -> dict[str, Any]:
        key = request.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            raise ValueError("request.idempotencyKey is required")
        result = self._request("POST", "/jobs", request, key)
        return dict(result)

    def get_job(self, job_id: str) -> dict[str, Any]:
        return dict(self._request("GET", f"/jobs/{_path_id(job_id)}"))

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/jobs/{_path_id(job_id)}/cancel"))

    def resume_job(self, job_id: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/jobs/{_path_id(job_id)}/resume"))

    def issue_media_playback(self, job_id: str) -> dict[str, Any]:
        """Issue opaque HLS/direct-media URLs for an active media-playback job."""
        return dict(self._request("POST", f"/jobs/{_path_id(job_id)}/media-playback"))

    def job_events(self, job_id: str, after: int | None = None) -> list[dict[str, Any]]:
        suffix = "" if after is None else f"?after={quote(str(after), safe='')}"
        return list(self._request("GET", f"/jobs/{_path_id(job_id)}/events{suffix}"))

    def upload_session_artifact(self, session_id: str, *, kind: str, content_type: str, data: bytes, label: str | None = None) -> dict[str, Any]:
        return self._upload_artifact(f"/browser-sessions/{_path_id(session_id)}/artifacts", kind=kind, content_type=content_type, data=data, label=label)

    def upload_job_artifact(self, job_id: str, *, kind: str, content_type: str, data: bytes, label: str | None = None) -> dict[str, Any]:
        return self._upload_artifact(f"/jobs/{_path_id(job_id)}/artifacts", kind=kind, content_type=content_type, data=data, label=label)

    def upload_media_manifest(self, project: str, manifest: Mapping[str, Any], *, artifact_policy_ref: str | None = None, label: str | None = None) -> dict[str, Any]:
        if not re.fullmatch(r"project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}", project):
            raise FabricError("validation_failed", "project identifier is invalid", 400)
        if artifact_policy_ref is not None and not re.fullmatch(r"artifact-policy_[A-Za-z0-9][A-Za-z0-9_.-]*@\d+", artifact_policy_ref):
            raise FabricError("validation_failed", "artifact policy reference is invalid", 400)
        import json
        data = json.dumps(dict(manifest), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return self._upload_artifact(
            f"/projects/{_path_id(project)}/media-manifests",
            kind="media_manifest",
            content_type="application/vnd.browser-fabric.media-manifest+json",
            data=data,
            label=label,
            extra_headers={} if artifact_policy_ref is None else {"x-fabric-artifact-policy-ref": artifact_policy_ref},
        )

    def list_session_artifacts(self, session_id: str) -> list[dict[str, Any]]:
        return list(self._request("GET", f"/browser-sessions/{_path_id(session_id)}/artifacts"))

    def list_job_artifacts(self, job_id: str) -> list[dict[str, Any]]:
        return list(self._request("GET", f"/jobs/{_path_id(job_id)}/artifacts"))

    def artifact_download(self, artifact_id: str, *, project: str, ttl_seconds: int = 60) -> dict[str, Any]:
        if not isinstance(ttl_seconds, int) or ttl_seconds < 1 or ttl_seconds > 900:
            raise ValueError("artifact download TTL must be from 1 to 900 seconds")
        return dict(self._request("GET", f"/artifacts/{_path_id(artifact_id)}?project={quote(project, safe='')}&ttlSeconds={ttl_seconds}"))

    def create_session_input_request(self, session_id: str, *, lease_id: str, field: str, field_type: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/browser-sessions/{_path_id(session_id)}/input-requests", {"leaseId": lease_id, "field": field, "fieldType": field_type}))

    def create_job_input_request(self, job_id: str, *, lease_id: str, field: str, field_type: str) -> dict[str, Any]:
        return dict(self._request("POST", f"/jobs/{_path_id(job_id)}/input-requests", {"leaseId": lease_id, "field": field, "fieldType": field_type}))

    def get_input_request(self, request_id: str) -> dict[str, Any]:
        return dict(self._request("GET", f"/input-requests/{_path_id(request_id)}"))

    def list_session_input_requests(self, session_id: str) -> list[dict[str, Any]]:
        return list(self._request("GET", f"/browser-sessions/{_path_id(session_id)}/input-requests"))

    def list_job_input_requests(self, job_id: str) -> list[dict[str, Any]]:
        return list(self._request("GET", f"/jobs/{_path_id(job_id)}/input-requests"))

    def provide_encrypted_input(self, request_id: str, envelope: Mapping[str, Any]) -> dict[str, Any]:
        return dict(self._request("POST", f"/input-requests/{_path_id(request_id)}/envelope", envelope))

    def list_profiles(self, project: str) -> list[dict[str, Any]]:
        return list(self._request("GET", f"/profiles?project={quote(project, safe='')}"))

    def get_profile(self, profile_ref: str) -> dict[str, Any]:
        return dict(self._request("GET", f"/profiles/{_path_id(profile_ref)}"))

    def wait_for_browser_session(
        self,
        session_id: str,
        *,
        timeout: float = 300.0,
        poll_interval: float = 0.25,
        max_poll_interval: float = 2.0,
        on_update: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        _validate_wait(timeout, poll_interval, max_poll_interval)
        started = time.monotonic()
        delay = poll_interval
        while True:
            current = self.get_browser_session(session_id)
            if on_update:
                on_update(current)
            if ((current.get("status") in {"ready", "active"} and isinstance(current.get("cdpEndpoint"), str) and current["cdpEndpoint"]) or current.get("status") in _TERMINAL_SESSION_STATES):
                return current
            if time.monotonic() - started >= timeout:
                raise FabricError("deadline_exceeded", f"browser session {session_id} did not become ready before the deadline", 408)
            time.sleep(min(delay, max(0.001, timeout - (time.monotonic() - started))))
            delay = min(max_poll_interval, delay * 1.5)

    def wait_for_job(
        self,
        job_id: str,
        *,
        timeout: float = 300.0,
        poll_interval: float = 0.25,
        max_poll_interval: float = 2.0,
        on_update: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        _validate_wait(timeout, poll_interval, max_poll_interval)
        started = time.monotonic()
        delay = poll_interval
        while True:
            current = self.get_job(job_id)
            if on_update:
                on_update(current)
            if current.get("status") in _TERMINAL_JOB_STATES or current.get("status") in _ACTIONABLE_JOB_STATES:
                return current
            if time.monotonic() - started >= timeout:
                raise FabricError("deadline_exceeded", f"job {job_id} did not reach a terminal state before the deadline", 408)
            time.sleep(min(delay, max(0.001, timeout - (time.monotonic() - started))))
            delay = min(max_poll_interval, delay * 1.5)

    def wait_for_job_state(self, job_id: str, *, timeout: float = 300.0, poll_interval: float = 0.25, max_poll_interval: float = 2.0) -> dict[str, Any]:
        _validate_wait(timeout, poll_interval, max_poll_interval)
        started = time.monotonic()
        delay = poll_interval
        while True:
            current = self.get_job(job_id)
            if current.get("status") != "queued":
                return current
            if time.monotonic() - started >= timeout:
                raise FabricError("deadline_exceeded", f"job {job_id} was not assigned before the deadline", 408)
            time.sleep(min(delay, max(0.001, timeout - (time.monotonic() - started))))
            delay = min(max_poll_interval, delay * 1.5)


class BrowserSessionLease:
    """Synchronous context manager that cannot leak a browser lease."""

    def __init__(self, client: BrowserFabricClient, request: Mapping[str, Any], *, wait_kwargs: Mapping[str, Any] | None = None) -> None:
        self.client = client
        self.request = dict(request)
        self.wait_kwargs = dict(wait_kwargs or {})
        self.session: dict[str, Any] | None = None

    def __enter__(self) -> dict[str, Any]:
        self.session = self.client.create_browser_session(self.request)
        try:
            self.session = self.client.wait_for_browser_session(str(self.session["id"]), **self.wait_kwargs)
            if self.session.get("status") not in {"ready", "active"} or not self.session.get("cdpEndpoint"):
                raise FabricError("worker_unavailable", f"browser session ended in {self.session.get('status')}", 503)
            return self.session
        except BaseException:
            if self.session:
                try:
                    self.client.cancel_browser_session(str(self.session["id"]))
                except Exception:
                    pass
            raise

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if not self.session:
            return
        try:
            if self.session.get("status") not in _TERMINAL_SESSION_STATES:
                self.client.release_browser_session(str(self.session["id"]))
        except Exception:
            # Preserve the original callback exception; release is retried by reconciliation.
            pass


class AsyncBrowserFabricClient:
    """Async counterpart used by FastAPI/Playwright application adapters."""

    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None, headers: Mapping[str, str] | None = None, timeout: float = 30.0) -> None:
        if not base_url or not base_url.lower().startswith(("http://", "https://")):
            raise ValueError("base_url must be an HTTP(S) URL")
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._headers = dict(headers or {})

    @classmethod
    def from_environment(cls, *, client: httpx.AsyncClient | None = None) -> "AsyncBrowserFabricClient":
        base_url, headers = _environment_configuration()
        return cls(base_url, client=client, headers=headers)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, payload: Mapping[str, Any] | None = None, idempotency_key: str | None = None) -> Any:
        headers = {"accept": "application/json", **self._headers}
        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key
        try:
            response = await self._client.request(method, f"{self._base_url}{path}", json=payload, headers=headers)
        except httpx.HTTPError as error:
            raise FabricError("internal_error", "Fabric transport request failed", 502) from error
        if response.is_error:
            _raise_response(response)
        try:
            return response.json()
        except ValueError as error:
            raise FabricError("internal_error", "Fabric returned a non-JSON response", 502) from error

    async def _upload_artifact(self, path: str, *, kind: str, content_type: str, data: bytes, label: str | None = None, extra_headers: Mapping[str, str] | None = None) -> dict[str, Any]:
        if kind not in _ARTIFACT_KINDS:
            raise FabricError("validation_failed", "artifact kind is invalid", 400)
        if not content_type or len(content_type) > 255 or "\r" in content_type or "\n" in content_type:
            raise FabricError("validation_failed", "artifact content type is invalid", 400)
        if not isinstance(data, bytes) or len(data) > 32 * 1024 * 1024:
            raise FabricError("validation_failed", "artifact upload exceeds the configured limit", 413)
        headers = {"accept": "application/json", "content-type": content_type, "x-fabric-artifact-kind": kind, **(dict(extra_headers) if extra_headers else {}), **self._headers}
        if label is not None:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", label):
                raise FabricError("validation_failed", "artifact label is invalid", 400)
            headers["x-fabric-artifact-label"] = label
        try:
            response = await self._client.request("POST", f"{self._base_url}{path}", content=data, headers=headers)
        except httpx.HTTPError as error:
            raise FabricError("internal_error", "Fabric transport request failed", 502) from error
        if response.is_error:
            _raise_response(response)
        try:
            return dict(response.json())
        except ValueError as error:
            raise FabricError("internal_error", "Fabric returned a non-JSON response", 502) from error

    async def create_browser_session(self, request: Mapping[str, Any]) -> dict[str, Any]:
        key = request.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            raise ValueError("request.idempotencyKey is required")
        return dict(await self._request("POST", "/browser-sessions", request, key))

    async def get_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(await self._request("GET", f"/browser-sessions/{_path_id(session_id)}"))

    async def heartbeat_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/browser-sessions/{_path_id(session_id)}/heartbeat"))

    async def release_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/browser-sessions/{_path_id(session_id)}/release"))

    async def cancel_browser_session(self, session_id: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/browser-sessions/{_path_id(session_id)}/cancel"))

    async def create_job(self, request: Mapping[str, Any]) -> dict[str, Any]:
        key = request.get("idempotencyKey")
        if not isinstance(key, str) or not key:
            raise ValueError("request.idempotencyKey is required")
        return dict(await self._request("POST", "/jobs", request, key))

    async def get_job(self, job_id: str) -> dict[str, Any]:
        return dict(await self._request("GET", f"/jobs/{_path_id(job_id)}"))

    async def cancel_job(self, job_id: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/jobs/{_path_id(job_id)}/cancel"))

    async def resume_job(self, job_id: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/jobs/{_path_id(job_id)}/resume"))

    async def issue_media_playback(self, job_id: str) -> dict[str, Any]:
        """Issue opaque HLS/direct-media URLs for an active media-playback job."""
        return dict(await self._request("POST", f"/jobs/{_path_id(job_id)}/media-playback"))

    async def job_events(self, job_id: str, after: int | None = None) -> list[dict[str, Any]]:
        suffix = "" if after is None else f"?after={quote(str(after), safe='')}"
        return list(await self._request("GET", f"/jobs/{_path_id(job_id)}/events{suffix}"))

    async def upload_session_artifact(self, session_id: str, *, kind: str, content_type: str, data: bytes, label: str | None = None) -> dict[str, Any]:
        return await self._upload_artifact(f"/browser-sessions/{_path_id(session_id)}/artifacts", kind=kind, content_type=content_type, data=data, label=label)

    async def upload_job_artifact(self, job_id: str, *, kind: str, content_type: str, data: bytes, label: str | None = None) -> dict[str, Any]:
        return await self._upload_artifact(f"/jobs/{_path_id(job_id)}/artifacts", kind=kind, content_type=content_type, data=data, label=label)

    async def upload_media_manifest(self, project: str, manifest: Mapping[str, Any], *, artifact_policy_ref: str | None = None, label: str | None = None) -> dict[str, Any]:
        if not re.fullmatch(r"project_[A-Za-z0-9][A-Za-z0-9_-]{0,127}", project):
            raise FabricError("validation_failed", "project identifier is invalid", 400)
        if artifact_policy_ref is not None and not re.fullmatch(r"artifact-policy_[A-Za-z0-9][A-Za-z0-9_.-]*@\d+", artifact_policy_ref):
            raise FabricError("validation_failed", "artifact policy reference is invalid", 400)
        import json
        data = json.dumps(dict(manifest), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return await self._upload_artifact(
            f"/projects/{_path_id(project)}/media-manifests",
            kind="media_manifest",
            content_type="application/vnd.browser-fabric.media-manifest+json",
            data=data,
            label=label,
            extra_headers={} if artifact_policy_ref is None else {"x-fabric-artifact-policy-ref": artifact_policy_ref},
        )

    async def list_session_artifacts(self, session_id: str) -> list[dict[str, Any]]:
        return list(await self._request("GET", f"/browser-sessions/{_path_id(session_id)}/artifacts"))

    async def list_job_artifacts(self, job_id: str) -> list[dict[str, Any]]:
        return list(await self._request("GET", f"/jobs/{_path_id(job_id)}/artifacts"))

    async def artifact_download(self, artifact_id: str, *, project: str, ttl_seconds: int = 60) -> dict[str, Any]:
        if not isinstance(ttl_seconds, int) or ttl_seconds < 1 or ttl_seconds > 900:
            raise ValueError("artifact download TTL must be from 1 to 900 seconds")
        return dict(await self._request("GET", f"/artifacts/{_path_id(artifact_id)}?project={quote(project, safe='')}&ttlSeconds={ttl_seconds}"))

    async def create_session_input_request(self, session_id: str, *, lease_id: str, field: str, field_type: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/browser-sessions/{_path_id(session_id)}/input-requests", {"leaseId": lease_id, "field": field, "fieldType": field_type}))

    async def create_job_input_request(self, job_id: str, *, lease_id: str, field: str, field_type: str) -> dict[str, Any]:
        return dict(await self._request("POST", f"/jobs/{_path_id(job_id)}/input-requests", {"leaseId": lease_id, "field": field, "fieldType": field_type}))

    async def get_input_request(self, request_id: str) -> dict[str, Any]:
        return dict(await self._request("GET", f"/input-requests/{_path_id(request_id)}"))

    async def list_session_input_requests(self, session_id: str) -> list[dict[str, Any]]:
        return list(await self._request("GET", f"/browser-sessions/{_path_id(session_id)}/input-requests"))

    async def list_job_input_requests(self, job_id: str) -> list[dict[str, Any]]:
        return list(await self._request("GET", f"/jobs/{_path_id(job_id)}/input-requests"))

    async def provide_encrypted_input(self, request_id: str, envelope: Mapping[str, Any]) -> dict[str, Any]:
        return dict(await self._request("POST", f"/input-requests/{_path_id(request_id)}/envelope", envelope))

    async def list_profiles(self, project: str) -> list[dict[str, Any]]:
        return list(await self._request("GET", f"/profiles?project={quote(project, safe='')}"))

    async def get_profile(self, profile_ref: str) -> dict[str, Any]:
        return dict(await self._request("GET", f"/profiles/{_path_id(profile_ref)}"))

    async def wait_for_browser_session(self, session_id: str, *, timeout: float = 300.0, poll_interval: float = 0.25, max_poll_interval: float = 2.0) -> dict[str, Any]:
        _validate_wait(timeout, poll_interval, max_poll_interval)
        started = time.monotonic()
        delay = poll_interval
        while True:
            current = await self.get_browser_session(session_id)
            if ((current.get("status") in {"ready", "active"} and current.get("cdpEndpoint")) or current.get("status") in _TERMINAL_SESSION_STATES):
                return current
            if time.monotonic() - started >= timeout:
                raise FabricError("deadline_exceeded", f"browser session {session_id} did not become ready before the deadline", 408)
            await asyncio.sleep(min(delay, max(0.001, timeout - (time.monotonic() - started))))
            delay = min(max_poll_interval, delay * 1.5)

    async def wait_for_job(self, job_id: str, *, timeout: float = 300.0, poll_interval: float = 0.25, max_poll_interval: float = 2.0) -> dict[str, Any]:
        _validate_wait(timeout, poll_interval, max_poll_interval)
        started = time.monotonic()
        delay = poll_interval
        while True:
            current = await self.get_job(job_id)
            if current.get("status") in _TERMINAL_JOB_STATES or current.get("status") in _ACTIONABLE_JOB_STATES:
                return current
            if time.monotonic() - started >= timeout:
                raise FabricError("deadline_exceeded", f"job {job_id} did not reach a terminal state before the deadline", 408)
            await asyncio.sleep(min(delay, max(0.001, timeout - (time.monotonic() - started))))
            delay = min(max_poll_interval, delay * 1.5)


class AsyncBrowserSessionLease:
    def __init__(self, client: AsyncBrowserFabricClient, request: Mapping[str, Any], *, wait_kwargs: Mapping[str, Any] | None = None) -> None:
        self.client = client
        self.request = dict(request)
        self.wait_kwargs = dict(wait_kwargs or {})
        self.session: dict[str, Any] | None = None

    async def __aenter__(self) -> dict[str, Any]:
        self.session = await self.client.create_browser_session(self.request)
        try:
            self.session = await self.client.wait_for_browser_session(str(self.session["id"]), **self.wait_kwargs)
            if self.session.get("status") not in {"ready", "active"} or not self.session.get("cdpEndpoint"):
                raise FabricError("worker_unavailable", f"browser session ended in {self.session.get('status')}", 503)
            return self.session
        except BaseException:
            if self.session:
                try:
                    await self.client.cancel_browser_session(str(self.session["id"]))
                except Exception:
                    pass
            raise

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.session and self.session.get("status") not in _TERMINAL_SESSION_STATES:
            try:
                await self.client.release_browser_session(str(self.session["id"]))
            except Exception:
                pass
