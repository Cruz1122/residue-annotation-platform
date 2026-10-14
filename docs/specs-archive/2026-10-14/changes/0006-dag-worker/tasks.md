# 0006 — Worker y pipeline persistente

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F3 Ejecución. **Dependencias:** `0005`.

## Checklist de implementación

- [x] T-0006-01 — Crear entrypoint worker y shutdown limpio (`REQ-EXEC-001`) — entrypoint separado, ciclo de polling y liberación de sesión por tick implementados.
- [x] T-0006-02 — Implementar el pipeline y transitions (`REQ-EXEC-002`) — DAG persistente, dependencias, reintentos acotados y fallo auditable sin éxito científico falso implementados.
- [x] T-0006-03 — Definir claim/lease Postgres y tests (`REQ-EXEC-003`) — claim con `SKIP LOCKED`, límite 1, lease/heartbeat y recuperación verificados en PostgreSQL.
- [x] T-0006-04 — Probar reinicios y cancelación (`REQ-EXEC-004`) — `test_worker_entrypoint_restart_reconciles_abandoned_stage` cubre la caída del proceso y la recuperación con el entrypoint real; cancelación y recuperación de lease están cubiertas. El smoke Slurm autorizado permanece pendiente.

## Gate

Ejecutar aceptación de `EXEC-001, EXEC-002, EXEC-003, EXEC-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
