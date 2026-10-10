# 0009 — Integración MareNostrum 5 / Slurm / GPFS

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 HPC. **Dependencias:** `0006`, `0008`.

## Checklist de implementación

- [ ] T-0009-01 — Resolver arquitectura de transporte y permisos (`REQ-HPC-001`)
- [ ] T-0009-02 — Implementar HPCClient y GPFS storage (`REQ-HPC-002`)
- [ ] T-0009-03 — Smoke submit/status/cancel de job mínimo (`REQ-HPC-003`)
- [ ] T-0009-04 — Validar fallo de manifest y shell segura (`REQ-HPC-004`)

- [ ] T-0009-005 — Backend HPC adaptado a Linux/Windows y BSC; trazar a `REQ-HPC-005` y contrato de inspección MN5
- [ ] T-0009-006 — Inspector separado estrictamente solo lectura; trazar a `REQ-HPC-006` y contrato de inspección MN5
- [ ] T-0009-007 — VPN externa y secretos SSH password-only protegidos; trazar a `REQ-HPC-007` y contrato de inspección MN5

## Gate

Ejecutar aceptación de `HPC-001, HPC-002, HPC-003, HPC-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
