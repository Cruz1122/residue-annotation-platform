# 0013 — Identidad, autorización y cuotas HPC

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Checklist de implementación

- [ ] T-0013-01 — Definir permisos/roles, clasificación y SSO en ADR (`REQ-SEC-001`)
- [ ] T-0013-02 — Implementar authn/authz server-side (`REQ-SEC-002`)
- [ ] T-0013-03 — Añadir límites y cuotas de cómputo (`REQ-SEC-003`)
- [ ] T-0013-04 — Auditar IDOR/path traversal/secrets/cancel (`REQ-SEC-004`)

- [ ] T-0013-005 — Gobierno de inspección GPFS de solo lectura; trazar a `REQ-SEC-005` y contrato de inspección MN5

## Gate

Ejecutar aceptación de `SEC-001, SEC-002, SEC-003, SEC-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
