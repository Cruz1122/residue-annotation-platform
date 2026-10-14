# 0014 — Operaciones, recovery y despliegue

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL. **Fase:** F6 Operaciones. **Dependencias:** `0010`, `0011`, `0013`.

## Checklist de implementación

- [x] T-0014-01 — Cerrar topología y secretos del despliegue (`REQ-OPS-004`) — Compose, migrator, health, volúmenes y referencias externas a secretos están definidos; staging/producción aprobados quedan pendientes.
- [ ] T-0014-02 — Implementar reconciliación, métricas y alertas (`REQ-OPS-001`, `REQ-OPS-003`) — reconciliación, recuperación de leases, métricas proceso+PostgreSQL y reglas Prometheus portables existen; falta desplegar un receptor aprobado y ejecutar chaos/drill.
- [x] T-0014-03 — Probar restore de DB y artefactos (`REQ-OPS-002`) — bundle, hashes, verificación y restore aislado tienen evidencia local; falta ejercicio en entorno de staging aprobado.
- [x] T-0014-04 — Completar runbooks, rollback y seguridad operacional (`REQ-OPS-004`) — runbook, rollback conservador y políticas de secretos están documentados; faltan staging/producción y prueba de rollback real.

- [ ] T-0014-005 — Operación multiplataforma VPN/SSH y modo nativo aprobado; trazar a `REQ-OPS-005` y contrato de inspección MN5 — perfil Linux/VPN verificado; faltan Windows/WSL2 y aprobación de host nativo BSC.

## Gate

Ejecutar aceptación de `OPS-001, OPS-002, OPS-003, OPS-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
