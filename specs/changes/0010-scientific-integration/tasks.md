# 0010 — Migración e integración de los 18 stages

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 Ciencia. **Dependencias:** `0007`, `0008`, `0009`.

## Checklist de implementación

- [ ] T-0010-01 — Migrar identidad y anotaciones externas (`REQ-STAGE-001`)
- [ ] T-0010-02 — Migrar tronco estructural AF3/topología/energía (`REQ-STAGE-002`)
- [ ] T-0010-03 — Migrar ramas variantes/ensemble/frustración/contactos (`REQ-STAGE-003`)
- [x] T-0010-04 — Comparar y documentar gates para 18 stages (`REQ-STAGE-004`) — gates y entrypoints revisados en MN5; preflight negativo y smoke aún pendientes

## Gate

Ejecutar aceptación de `STAGE-001, STAGE-002, STAGE-003, STAGE-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
