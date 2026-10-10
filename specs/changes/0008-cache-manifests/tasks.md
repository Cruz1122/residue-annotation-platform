# 0008 — Manifiestos, publicación y cache

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Persistencia científica. **Dependencias:** `0005`, `0006`, `0007`.

## Checklist de implementación

- [ ] T-0008-01 — Definir manifest schema/version y checks (`REQ-CACHE-001`)
- [ ] T-0008-02 — Implementar canonical cache_key (`REQ-CACHE-002`)
- [ ] T-0008-03 — Implementar commit atómico/DB idempotente (`REQ-CACHE-003`)
- [ ] T-0008-04 — Ejecutar tests de crash, corrupt artifact y reuse (`REQ-CACHE-004`)

## Gate

Ejecutar aceptación de `CACHE-001, CACHE-002, CACHE-003, CACHE-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
