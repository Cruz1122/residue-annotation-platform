# Acceptance 0001 — Scaffold

**Estado:** PASS local para el contrato de puertos, integración health y arranque Docker; incluye smoke browser-side con backend detenido y recuperación.
**Fecha de verificación local:** 2026-10-14.

La decisión solicitada de conservar los puertos existentes forma parte ahora del contrato: frontend 4742, backend 8742, API browser-side http://localhost:8742/api/v1 y CORS http://localhost:4742.

| REQ | Comprobación | Resultado | Estado |
| --- | --- | --- | --- |
| REQ-SCF-001 | Inspección del árbol y servicios | README, env de ejemplo, Compose, frontend, backend y fronteras por feature presentes; las fuentes de datos simuladas del producto fueron eliminadas | PASS (local) |
| REQ-SCF-002 | GET health y ruta desconocida | Health devuelve 200 application/json status=ok; una ruta desconocida devuelve 404 | PASS (local) |
| REQ-SCF-003 | Health browser-side | HealthStatus llama getHealth(), valida status=ok y sólo entonces muestra Connected | PASS (código + check frontend) |
| REQ-SCF-004 | Indisponibilidad/JSON inválido | HealthStatus muestra `No se pudo conectar con el backend` y botón `Reintentar` en el árbol accesible cuando `backend` está detenido; después de levantarlo y esperar health 200, la misma pestaña vuelve a mostrar el estado vacío normal (`Aún no tienes proteínas registradas`). Los tests de código también cubren HTTP no exitoso y JSON distinto de `status=ok`. | PASS (código + smoke browser) |
| REQ-SCF-005 | Compose services y puertos | El perfil local declara `db`, `migrate`, `backend`, `frontend`, `vpn` y `worker-vpn`; el perfil `mn5` sustituye VPN/SSH por `worker-mn5`. Los puertos publicados son 8742:8742 / 4742:4742 y el runtime dejó backend, frontend, worker-vpn, VPN saludable y PostgreSQL saludable arriba | PASS (local; perfil VPN) |
| REQ-SCF-006 | Configuración CORS/API | PUBLIC_API_BASE_URL, APP_ENV, APP_NAME y CORS_ORIGINS están documentados; no hay wildcard ni secretos reales | PASS (revisión local) |
| REQ-SCF-007 | README reproducible | README documenta arranque, URLs, health, flujo real, checks, errores de alcance y perfil runtime explícito | PASS (revisión local) |

## Comandos reproducidos

    docker compose --profile vpn config --services   PASS: db, migrate, vpn, worker-vpn, backend, frontend
    COMPOSE_PROFILES=mn5 docker compose config --services  PASS: db, migrate, worker-mn5, backend, frontend
    docker compose ps --all                 PASS: backend/frontend/worker-vpn arriba; db y vpn saludables
    docker compose stop backend; browser smoke; docker compose up -d backend  PASS: Unavailable → recuperación con health 200
    uv run ruff check app alembic tests   PASS
    uv run pytest -q                      PASS: 209 tests, 11 skips (220 con PostgreSQL 16)
    corepack pnpm check                   PASS: 0 errors/warnings/hints
    corepack pnpm build                   PASS: Astro SSR build
    python scripts/validate_specs.py     PASS

La prueba manual con backend detenido mostró el mensaje accesible de indisponibilidad y la recuperación posterior en la misma pestaña; la selección de puertos 4742/8742 es intencional y está reflejada en spec, design, proposal, Compose, env de ejemplo y README.
