from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_cache_key(
    *,
    protein_sha256: str,
    stage_id: str,
    stage_version: str,
    parameters: dict[str, Any],
    resources: dict[str, Any],
    code_sha256: str,
    dependency_cache_keys: dict[str, str] | None = None,
    query_sequence_sha256: str | None = None,
    reference_sequence_sha256: str | None = None,
    contract_version: str | None = None,
    stage_code_sha256: str | None = None,
    resource_identity: dict[str, Any] | None = None,
    scientific_parameters: dict[str, Any] | None = None,
) -> str:
    """Build the versioned scientific cache identity.

    The first six arguments are the original local API. The optional fields
    project it onto the remote ``stage-cache-v2`` contract without forcing
    callers that only have one canonical sequence hash to invent query or
    dependency data. Logging-only knobs are deliberately excluded because
    they do not change scientific outputs.
    """

    ignored_parameters = {"log_level", "log_format", "verbosity"}
    scientific = scientific_parameters or {
        key: value for key, value in parameters.items() if key not in ignored_parameters
    }
    payload = {
        "schema": "stage-cache-v2",
        "contract_version": contract_version or stage_version,
        "stage_code_sha256": stage_code_sha256 or code_sha256,
        "sequence_sha256": protein_sha256,
        "query_sequence_sha256": query_sequence_sha256,
        "reference_sequence_sha256": reference_sequence_sha256,
        "dependency_cache_keys": dependency_cache_keys or {},
        "resource_identity": resource_identity or resources,
        "scientific_parameters": scientific,
        "protein_sha256": protein_sha256,
        "stage_id": stage_id,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
