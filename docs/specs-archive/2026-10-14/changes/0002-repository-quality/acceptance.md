# Acceptance 0002 — Quality gates

**Estado:** PARTIAL local; CI está definida pero todavía no existe evidencia de ejecución en GitHub Actions. La suite local no usa HPC, GPU ni secretos.
**Fecha de verificación local:** 2026-10-14.

| REQ | Comprobación | Resultado | Estado |
| --- | --- | --- | --- |
| REQ-QLT-001 | pytest de health y dominio | 209 tests pasan localmente y la ejecución completa de 220 tests contra PostgreSQL 16 aislado incluye los 11 escenarios concurrentes; incluye health, normalización, auth, uploads, runs, recuperación de leases, restart del entrypoint real, reuso de cache, paginación, fronteras SFTP/HPC nativo, receipts de submission, integridad de inputs y ownership HTTP/Bearer | PASS (local) |
| REQ-QLT-002 | Ruff lint y formato | `uv run ruff check app tests` y `uv run ruff format --check app tests` pasan en el checkout actual | PASS (local) |
| REQ-QLT-003 | Astro check/build y workflow | pnpm check/build pasan; `.github/workflows/ci.yml` ejecuta backend (con servicio PostgreSQL), frontend, secret scan y validación de los perfiles Compose offline/`vpn`/`mn5` sin `continue-on-error`; el validador documental se ejecuta localmente porque `scripts/validate_specs.py` queda fuera del commit solicitado | PASS local / CI NOT RUN |
| REQ-QLT-004 | Independencia del cluster | Las pruebas, lint, check y build no invocan Slurm, GPU, VPN ni GPFS | PASS (revisión local) |

## Comandos reproducidos

    cd backend && uv run ruff check app alembic tests
    cd backend && uv run ruff format --check app alembic tests
    cd backend && uv run pytest -q
    cd frontend && corepack pnpm check
    cd frontend && corepack pnpm build
    docker compose --env-file .env.example config --quiet
    docker compose --env-file .env.example --profile vpn config --quiet
    docker compose --env-file .env.example --profile mn5 config --quiet

Todos los comandos terminan con código 0 en el checkout verificado. La suite local dio `209 passed, 11 skipped`; una ejecución completa contra PostgreSQL 16 aislado dio `220 passed`. `python scripts/secret_scan.py`, `python scripts/validate_specs.py`, `astro check`, `astro build` y las tres configuraciones Compose también terminaron con código 0. La ejecución efectiva del workflow en el proveedor sigue NOT RUN; por eso no se declara el gate 0002 completamente cerrado.
