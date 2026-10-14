# 0011 — REST/SSE y anotaciones parciales

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F5 Producto. **Dependencias:** `0005`, `0006`, `0008`.

## Checklist de implementación

- [x] T-0011-01 — Especificar OpenAPI y semántica de estados (`REQ-API-001`) — routers, schemas y estados persistidos exponen el contrato tipado del backend.
- [x] T-0011-02 — Implementar annotations por stage_result (`REQ-API-002`) — tablas por stage, validación canónica y paginación con `truncated` implementadas.
- [x] T-0011-03 — Implementar SSE y reconexión/fallback (`REQ-API-003`) — SSE basado en snapshots persistidos y fallback frontend a polling están implementados; falta E2E de corte/reconexión en runtime completo.
- [x] T-0011-04 — Implementar artifact streaming seguro y tests (`REQ-API-004`) — descarga autorizada, hash/tamaño y storage keys seguras están cubiertos por tests.

## Gate

Ejecutar aceptación de `API-001, API-002, API-003, API-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
