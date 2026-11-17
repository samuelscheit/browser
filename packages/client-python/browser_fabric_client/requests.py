"""Request builders that take explicit refs (discover them with ``GET /v1/me``)."""
from __future__ import annotations

import re
from typing import Any, Mapping

from .client import FabricError

DEFAULT_ARTIFACT_POLICY = "artifact-policy_standard-30-days@1"

_SECRET_KEY = re.compile(r"(password|passphrase|secret|token|cookie|credential|authorization|proxy(?:_?url)?|otp|api[_-]?key)", re.I)


def assert_no_durable_secrets(value: Any, path: str = "operation") -> None:
    """Typed operations are durable; a secret belongs in an ephemeral input request instead."""
    if isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_durable_secrets(child, f"{path}[{index}]")
    elif isinstance(value, dict):
        for key, child in value.items():
            if _SECRET_KEY.search(str(key)) and not str(key).endswith("Ref"):
                raise FabricError("secret_rejected", f"{path}.{key} must be supplied through an ephemeral input request", 400)
            assert_no_durable_secrets(child, f"{path}.{key}")


def build_job(
    *,
    project: str,
    idempotency_key: str,
    recipe_ref: str,
    operation: Mapping[str, Any],
    egress_policy_ref: str,
    profile_ref: str | None = None,
    lease_mode: str | None = None,
    artifact_policy_ref: str = DEFAULT_ARTIFACT_POLICY,
    ttl_seconds: int | None = None,
    metadata: Mapping[str, str | int | bool | None] | None = None,
    callback: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if not idempotency_key or len(idempotency_key) > 255:
        raise FabricError("validation_failed", "idempotency_key must be non-empty and at most 255 characters", 400)
    assert_no_durable_secrets(dict(operation))
    payload: dict[str, Any] = {
        "project": project,
        "idempotencyKey": idempotency_key,
        "recipeRef": recipe_ref,
        "operation": dict(operation),
        "egressPolicyRef": egress_policy_ref,
        "artifactPolicyRef": artifact_policy_ref,
    }
    if profile_ref is not None:
        payload["profileRef"] = profile_ref
    if lease_mode is not None:
        payload["leaseMode"] = lease_mode
    if ttl_seconds is not None:
        payload["ttlSeconds"] = ttl_seconds
    if metadata is not None:
        payload["metadata"] = dict(metadata)
    if callback is not None:
        payload["callback"] = dict(callback)
    return payload
