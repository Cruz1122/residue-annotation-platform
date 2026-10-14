# 0009 — Integración MareNostrum 5 / Slurm / GPFS

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL. **Fase:** F4 HPC. **Dependencias:** `0006`, `0008`.

## Checklist de implementación

- [x] T-0009-01 — Resolver arquitectura de transporte y permisos (`REQ-HPC-001`) — se separaron `HPCClient` e inspector read-only y se confinó el perímetro; la aprobación BSC/ADR sigue pendiente.
- [x] T-0009-02 — Implementar HPCClient y GPFS storage (`REQ-HPC-002`) — perfiles disabled/offline/SSH/native, almacenamiento local de artefactos, recursos Slurm y transferencia SCP acotada están implementados y probados localmente.
- [ ] T-0009-03 — Smoke submit/status/cancel de job mínimo (`REQ-HPC-003`)
- [x] T-0009-04 — Validar fallo de manifest y shell segura (`REQ-HPC-004`) — manifest inválido, shell quoting, jobs IDs, accounting y fronteras de path tienen tests; el smoke remoto negativo queda pendiente.

- [x] T-0009-005 — Backend HPC adaptado a Linux/Windows y BSC; trazar a `REQ-HPC-005` y contrato de inspección MN5 — perfiles y documentación están preparados; falta smoke de Slurm/stage autorizado y validación Windows/WSL2.
- [x] T-0009-006 — Inspector separado estrictamente solo lectura; trazar a `REQ-HPC-006` y contrato de inspección MN5 — contrato, límites, rechazo de symlinks/traversal y smoke SFTP read-only implementados; falta la matriz completa y aprobación independiente.
- [x] T-0009-007 — VPN externa y secretos SSH password-only protegidos; trazar a `REQ-HPC-007` y contrato de inspección MN5 — VPN externa, known_hosts y mode checks están documentados/probados; falta gobierno institucional de automatización.

## Gate

Ejecutar aceptación de `HPC-001, HPC-002, HPC-003, HPC-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
