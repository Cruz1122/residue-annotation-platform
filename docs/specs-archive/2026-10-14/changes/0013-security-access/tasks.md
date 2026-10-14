# 0013 — Identidad, autorización y cuotas HPC

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL. **Fase:** F6 Seguridad. **Dependencias:** `0004`, `0005`, `0011`.

## Checklist de implementación

- [ ] T-0013-01 — Definir permisos/roles, clasificación y SSO en ADR (`REQ-SEC-001`)
- [x] T-0013-02 — Implementar authn/authz server-side (`REQ-SEC-001`) — Bearer auth, fallback dev/test, ownership, project scopes y roles admin están implementados.
- [x] T-0013-03 — Añadir límites y cuotas de cómputo (`REQ-SEC-003`) — límites de upload/secuencia/variantes, presupuestos CPU/GPU, rate limits y un slot activo por usuario están implementados; cuotas reales de HPC siguen pendientes.
- [x] T-0013-04 — Auditar IDOR/path traversal/secrets/cancel (`REQ-SEC-001`, `REQ-SEC-002`, `REQ-SEC-004`) — tests de ownership, traversal, symlinks, cancelación, auditoría y secret scan pasan localmente; falta threat model/IDOR independiente con dos principals en entorno aprobado.

- [x] T-0013-005 — Gobierno de inspección GPFS de solo lectura; trazar a `REQ-SEC-005` y contrato de inspección MN5 — contrato y perímetro técnico implementados; falta aprobación de ACL/cuenta de servicio BSC.

## Gate

Ejecutar aceptación de `SEC-001, SEC-002, SEC-003, SEC-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
