#!/usr/bin/env python3
"""Validate the repository's executable/specification boundary without network access."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ACTIVE_SPEC_NAMES = (
    "01-entrada-configuracion.md",
    "02-ejecucion-cientifica.md",
    "03-seguimiento-resultados.md",
)
REQUIRED_SPEC_SECTIONS = (
    "Objetivo",
    "Experiencia del usuario",
    "Comportamiento esperado",
    "Contratos esenciales",
    "Estado actual",
    "Requisitos funcionales",
    "Casos límite",
    "Criterios de aceptación",
    "Trabajo pendiente",
    "Fuera de alcance",
)


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def require_paths() -> None:
    required = [
        ROOT / "README.md",
        ROOT / ".gitignore",
        ROOT / ".env.example",
        ROOT / "compose.yml",
        ROOT / "frontend/package.json",
        ROOT / "frontend/src/shared/api/client.ts",
        ROOT / "backend/pyproject.toml",
        ROOT / "backend/app/main.py",
        ROOT / "backend/alembic/versions/0001_initial.py",
        ROOT / ".github/workflows/ci.yml",
    ]
    for path in required:
        if not path.exists():
            fail(f"missing required path: {path.relative_to(ROOT)}")


def validate_specs_tree() -> None:
    specs_dir = ROOT / "specs"
    if not specs_dir.is_dir():
        fail("specs directory is missing")

    entries = sorted(path.name for path in specs_dir.iterdir())
    expected = sorted(ACTIVE_SPEC_NAMES)
    if entries != expected:
        fail(f"active specs must be exactly {expected}; found {entries}")

    for name in ACTIVE_SPEC_NAMES:
        path = specs_dir / name
        content = path.read_text(encoding="utf-8")
        missing = [
            section for section in REQUIRED_SPEC_SECTIONS if f"## {section}" not in content
        ]
        if missing:
            fail(f"{path.relative_to(ROOT)} is missing sections: {', '.join(missing)}")


def validate_ports_and_config() -> None:
    compose = (ROOT / "compose.yml").read_text(encoding="utf-8")
    if '"8742:8742"' not in compose or '"4742:4742"' not in compose:
        fail("compose.yml no longer exposes the declared 8742/4742 ports")
    if "4321" in compose or "8000" in compose:
        fail("obsolete scaffold ports found in compose.yml")

    env = (ROOT / ".env.example").read_text(encoding="utf-8")
    for required in ("PUBLIC_API_BASE_URL=http://localhost:8742/api/v1", "CORS_ORIGINS=http://localhost:4742"):
        if required not in env:
            fail(f"missing declared environment value: {required}")


def validate_no_product_fixtures() -> None:
    forbidden = [ROOT / "frontend/public/mock", ROOT / "frontend/public/mock-artifacts"]
    for path in forbidden:
        if path.exists():
            fail(f"product fixture directory must be absent: {path.relative_to(ROOT)}")

    source_files = list((ROOT / "frontend/src").rglob("*"))
    source_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in source_files
        if path.is_file() and path.suffix in {".astro", ".js", ".jsx", ".ts", ".tsx"}
    )
    for marker in ("mockAnnotations", "MOCK_PROTEINS", "mock-artifacts", "protein-pipeline-demo-session"):
        if marker in source_text:
            fail(f"product source still references removed fixture marker: {marker}")


def validate_registry() -> None:
    registry = (ROOT / "backend/app/features/stages/registry.py").read_text(encoding="utf-8")
    definitions = re.findall(r"StageDefinition\(\s*\"([a-z0-9_]+)\"", registry)
    if len(definitions) != 18:
        fail(f"expected 18 stage definitions, found {len(definitions)}")
    if len(set(definitions)) != len(definitions):
        fail("stage registry contains duplicate IDs")


def main() -> int:
    require_paths()
    validate_specs_tree()
    validate_ports_and_config()
    validate_no_product_fixtures()
    validate_registry()
    print("spec validation: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
