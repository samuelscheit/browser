from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Mapping
import httpx

@dataclass(slots=True)
class FabricError(Exception):
    code: str
    detail: str
    status: int

class BrowserFabricClient:
    def __init__(self, base_url: str, client: httpx.Client | None = None, headers: Mapping[str, str] | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.Client()
        self._headers = dict(headers or {})

    def _request(self, method: str, path: str, payload: Mapping[str, Any] | None = None, idempotency_key: str | None = None) -> dict[str, Any] | list[dict[str, Any]]:
        headers = {"accept": "application/json", **self._headers}
        if idempotency_key: headers["idempotency-key"] = idempotency_key
        response = self._client.request(method, f"{self._base_url}{path}", json=payload, headers=headers)
        if response.is_error:
            body = response.json() if "json" in response.headers.get("content-type", "") else {}
            raise FabricError(str(body.get("code", "internal_error")), str(body.get("detail", response.text)), int(body.get("status", response.status_code)))
        return response.json()

    def create_browser_session(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/browser-sessions", request, str(request["idempotencyKey"]))  # type: ignore[return-value]

    def get_browser_session(self, session_id: str) -> dict[str, Any]:
        return self._request("GET", f"/browser-sessions/{session_id}")  # type: ignore[return-value]

    def release_browser_session(self, session_id: str) -> dict[str, Any]:
        return self._request("POST", f"/browser-sessions/{session_id}/release")  # type: ignore[return-value]

    def create_job(self, request: Mapping[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/jobs", request, str(request["idempotencyKey"]))  # type: ignore[return-value]

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._request("GET", f"/jobs/{job_id}")  # type: ignore[return-value]

    def provide_encrypted_input(self, request_id: str, envelope: Mapping[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/input-requests/{request_id}/envelope", envelope)  # type: ignore[return-value]

    def list_profiles(self, project: str) -> list[dict[str, Any]]:
        return self._request("GET", f"/profiles?project={project}")  # type: ignore[return-value]

    def get_profile(self, profile_ref: str) -> dict[str, Any]:
        return self._request("GET", f"/profiles/{profile_ref}")  # type: ignore[return-value]
