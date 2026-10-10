# 0014 — Operaciones, recovery y despliegue

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F6 Operaciones. **Dependencias:** `0010`, `0011`, `0013`.

## Checklist de implementación

- [ ] T-0014-01 — Cerrar topología y secretos del despliegue (`REQ-OPS-001`)
- [ ] T-0014-02 — Implementar reconciliación, métricas y alertas (`REQ-OPS-002`)
- [ ] T-0014-03 — Probar restore de DB y artefactos (`REQ-OPS-003`)
- [ ] T-0014-04 — Completar runbooks, rollback y seguridad operacional (`REQ-OPS-004`)

- [ ] T-0014-005 — Operación multiplataforma VPN/SSH y modo nativo aprobado; trazar a `REQ-OPS-005` y contrato de inspección MN5

## Gate

Ejecutar aceptación de `OPS-001, OPS-002, OPS-003, OPS-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
