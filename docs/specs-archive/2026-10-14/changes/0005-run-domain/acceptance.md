# 0005 — Runs, stages, resultados y artefactos

**Estado:** PARTIAL local; el modelo/API y la migración están implementados, el reuso de StageResult por cache_key y la inmutabilidad de estados terminales ya tienen cobertura, pero el gate humano y el IDOR independiente siguen pendientes.

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| RUN-001 | POST run con proteína válida retorna 201 y no espera ciencia | PASS (local) | Test crea run pending con ID y 18 RunStage persistidos |
| RUN-002 | StageResult independiente de Run y Artifact | PASS local | `_find_reusable_result` reutiliza un StageResult existente por `(protein, stage, cache_key)` y la etapa pasa a `reused`; `test_ingest_result_reuses_existing_cache_entry` cubre dos runs compartiendo resultado |
| RUN-003 | Transición terminal a running se rechaza | PASS local (PostgreSQL) | Test de state machine comprueba ValueError y `transition_stage` relee el estado persistido con lock; `test_cancelled_run_cannot_be_revived_by_stale_worker` impide que un run cancelado reviva |
| RUN-004 | GET run inexistente devuelve 404 sin progreso inventado | PASS (local) | Test HTTP dedicado confirma 404 y `Run not found`; no se fabrica progreso |

## Registro de ejecución

Fecha UTC: 2026-10-14
Comando: uv run pytest -q
Resultado: 209 tests PASS localmente y los 11 escenarios PostgreSQL pasan en una base PostgreSQL 16 limpia dentro de una ejecución de 220 tests: slot único, claim SKIP LOCKED con LIMIT 1, rotación de refresh, bucket de rate limit, refresh-vs-logout, cancel-vs-finalize, ownership service-level y ownership HTTP/Bearer; migraciones Alembic también pasan. La aprobación independiente del gate IDOR aún requiere cierre humano.
