# 0016 — Autenticación, sesiones y límite de ejecución por usuario

**Estado:** DRAFT — PENDING ACCEPTANCE — NO APROBADO.

- [x] T-0016-01 — Añadir modelos y migración de usuarios, tokens, rate limits, auditoría, uploads y slots activos.
- [x] T-0016-02 — Implementar register/login/refresh/logout/me.
- [x] T-0016-03 — Implementar verify-email, reset-password, change-password y entrega Resend con plantillas HTML/text.
- [x] T-0016-04 — Integrar Bearer middleware/dependency y conservar fallback sólo en development/test.
- [x] T-0016-05 — Aplicar rate limits y auditoría sin persistir secretos raw.
- [x] T-0016-06 — Aplicar máximo una run no terminal por usuario con slot único transaccional.
- [x] T-0016-07 — Implementar uploads pequeños FASTA/PDB/mmCIF y frontera SCP para perfil SSH.
- [ ] T-0016-08 — Ejecutar aceptación PostgreSQL, IDOR, secret scan, entrega Resend real/SSO, threat model y SCP MN5 autorizado.

## Gate

La implementación local existe y tiene pruebas unitarias/integración rápidas, pero el change permanece **PENDING** hasta completar los escenarios de aceptación externa y obtener aprobación humana.
