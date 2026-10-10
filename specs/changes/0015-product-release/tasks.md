# 0015 — Aceptación end-to-end y entrega final

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F7 Release. **Dependencias:** `0012`, `0013`, `0014`.

## Checklist de implementación

- [ ] T-0015-01 — Congelar release candidate, datasets y baseline (`REQ-REL-001`)
- [ ] T-0015-02 — Ejecutar end-to-end y casos negativos con MN5 (`REQ-REL-002`)
- [ ] T-0015-03 — Revisar performance/seguridad/restore/regresión (`REQ-REL-003`)
- [ ] T-0015-04 — Firmar release, docs y riesgos residuales (`REQ-REL-004`)

- [ ] T-0015-005 — Aceptación de permisos remotos y ausencia de escrituras; trazar a `REQ-REL-005` y contrato de inspección MN5

## Gate

Ejecutar aceptación de `REL-001, REL-002, REL-003, REL-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
