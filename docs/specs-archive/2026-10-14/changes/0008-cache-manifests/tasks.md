# 0008 — Manifiestos, publicación y cache

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F4 Persistencia científica. **Dependencias:** `0005`, `0006`, `0007`.

## Checklist de implementación

- [x] T-0008-01 — Definir manifest schema/version y checks (`REQ-CACHE-001`) — esquema, `DONE`, provenance, tamaños, hashes y paths confinados tienen validación estricta.
- [x] T-0008-02 — Implementar canonical cache_key (`REQ-CACHE-002`) — la clave canónica incluye identidad de proteína, versión, recursos y parámetros científicos.
- [x] T-0008-03 — Implementar commit atómico/DB idempotente (`REQ-CACHE-003`) — publicación atómica, `fsync`, namespace por ingestión y reuso por resultado verificado implementados.
- [x] T-0008-04 — Ejecutar tests de crash, corrupt artifact y reuse (`REQ-CACHE-004`) — límites, corrupción, temporales huérfanos, artefactos ausentes y cache miss pasan localmente; falta un stage científico real.

## Gate

Ejecutar aceptación de `CACHE-001, CACHE-002, CACHE-003, CACHE-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
