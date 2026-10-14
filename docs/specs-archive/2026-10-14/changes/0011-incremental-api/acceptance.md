# 0011 — REST/SSE y anotaciones parciales

**Estado:** PARTIAL local; los endpoints y el cliente frontend están conectados a estado persistido, con SSE y fallback de polling; faltan E2E de reconnect real, artifacts publicados y latencia en un runtime completo.

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| API-001 | GET annotations incluye sólo success/reused y distingue pending/failed | PARTIAL | annotations_for_run filtra por estado, valida aa_position/aa_ref sin asignar un set por secuencia (O(1) de memoria) y pagina con `limit`/`offset` + flag `truncated`; el offset es estable dentro de una página pero puede desplazarse si una etapa publica entre páginas; falta integration test con StageResult científico real |
| API-002 | Corte SSE y reconexión convergen con DB | PARTIAL | SSE emite snapshot persistido + heartbeat desde sesiones cortas; los tests `test_run_events_emits_the_persisted_terminal_snapshot` y `test_run_events_refreshes_from_the_current_persisted_snapshot` validan terminalidad y relectura tras un cambio persistido en SQLite. En el Compose real, dos conexiones curl autenticadas al run terminal `6bcb011c-b891-484f-bf8c-e99956221915` (la segunda después de cortar la primera) devolvieron `id: 1`, el mismo estado persistido `failed`, 18 stages y errores sanitizados; el frontend abre el stream con Bearer y vuelve a consultar GET run si cae. Falta E2E de fallback browser con una run científica publicada y resultado real |
| API-003 | Artifact ID autorizado sin traversal ni storage path público | PARTIAL | artifact router resuelve por joins ownership, verifica la existencia/tamaño del fichero (404/409) y ArtifactStore rechaza absolute/traversal/dotfiles/symlink; el runtime reconstruido verificó que el hash de un upload descargado por su ID coincide con el hash persistido; falta E2E con artefacto científico |
| API-004 | GET run no espera ciencia | PASS (diseño local) | Lecturas consultan estado persistido; executor científico está fuera del router; falta latency integration con AF3 running |

## Registro de ejecución

Fecha UTC: 2026-10-14
Comando: uv run pytest -q; corepack pnpm check; corepack pnpm build
Resultado: `209 passed, 11 skipped` localmente; la ejecución completa PostgreSQL 16 dio `220 passed`; Astro check/build PASS. El cliente abre `/events` con Bearer y vuelve a polling si el stream cae; el endpoint tiene tests de snapshot terminal y refresh desde estado persistido; la integración remota simulada también verifica que una publicación expone run, annotations y artifact por sus endpoints; E2E de corte/reconexión, artifact y latencia con StageResult científico real: NOT RUN.
