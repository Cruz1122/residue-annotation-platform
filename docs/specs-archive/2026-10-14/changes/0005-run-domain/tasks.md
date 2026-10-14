# 0005 — Runs, stages, resultados y artefactos

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F2 Dominio. **Dependencias:** `0004`.

## Checklist de implementación

- [x] T-0005-01 — Definir estados y transiciones (`REQ-RUN-001`) — estados terminales, cancelación y transiciones inválidas están implementados y cubiertos.
- [x] T-0005-02 — Crear migraciones con FK y constraints (`REQ-RUN-002`) — migraciones Alembic 0001–0006 y constraints verificadas en PostgreSQL 16 aislado.
- [x] T-0005-03 — Implementar servicios/API de runs (`REQ-RUN-003`) — creación, lectura, stages, cancelación, annotations y SSE persistido están implementados.
- [x] T-0005-04 — Ejecutar tests de integridad y concurrencia (`REQ-RUN-004`) — suite local y escenarios de concurrencia PostgreSQL pasan; IDOR independiente y gate humano quedan pendientes.

## Gate

Ejecutar aceptación de `RUN-001, RUN-002, RUN-003, RUN-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
