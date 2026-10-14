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
) -> str:
    payload = {
        "code_sha256": code_sha256,
        "parameters": parameters,
        "protein_sha256": protein_sha256,
        "resources": resources,
        "stage_id": stage_id,
        "stage_version": stage_version,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
