# 0009 — Integración MareNostrum 5 / Slurm / GPFS

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F4 HPC. **Dependencias:** `0006`, `0008`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Conectar jobs científicos al worker usando adaptadores internos y seguridad de recursos BSC.

**No objetivos:** No ejecutar AF3 ni BioEmu como smoke inicial; no prometer Docker Compose dentro de nodos de cómputo.

### REQ-HPC-001 — Aislamiento

MUST: frontend nunca ejecuta Slurm ni ve rutas GPFS absolutas.

- **Escenario verificable:** Given GET artifact/status, when inspeccionar payload, then sin paths absolutos.
- **Prueba prevista:** API/security check.

### REQ-HPC-002 — Adaptador Slurm

MUST: submit/status/cancel reflejan estado real, asignación CPU/GPU y errores sin fallback silencioso.

- **Escenario verificable:** Given GPU requerida sin GPU, when submit, then bloquea o informa según política.
- **Prueba prevista:** MN5 smoke job.

### REQ-HPC-003 — Manifiesto final

MUST: stage publica manifest al final y backend comprueba outputs antes de success.

- **Escenario verificable:** Given manifest truncado, when ingesta, then failed y evidencia de error.
- **Prueba prevista:** HPC negative smoke.

### REQ-HPC-004 — Seguridad salloc

MUST: shell principal de salloc se conserva tras fallar smoke o validación.

- **Escenario verificable:** Given error en subshell, when termina, then SLURM_JOB_ID sigue presente.
- **Prueba prevista:** Revisión script y smoke seguro.

### REQ-HPC-005 — Backend HPC adaptado a Linux/Windows y BSC

MUST: La plataforma MUST prever `HPCClient` ejecutor en modos `mock`, `ssh` mediante VPN de host y SSH password y `native` cuando BSC permita Slurm local; el código de dominio no depende del transporte.

- **Escenario verificable:** Given desarrollo sin red BSC, when tests, then mock opera sin secretos. Given VPN activa y autorización, when smoke SSH, then autentica con contraseña y host key válida.
- **Prueba prevista:** Matrix de perfiles, smoke remoto aprobado y documentación por SO.

### REQ-HPC-006 — Inspector separado estrictamente solo lectura

MUST: Para inspección científica remota el sistema MUST disponer de un contrato `ReadOnlyMN5Inspector` distinto del ejecutor Slurm, acotado a `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`, sin escrituras, shell ni acceso fuera de raíz.

- **Escenario verificable:** Given traversal, symlink o solicitud de operación mutadora, when se llama al inspector, then se deniega sin ejecutar remote shell ni write SFTP.
- **Prueba prevista:** INS-01..INS-18; mocks/adversarios + smoke MN5 exclusivamente de lectura.

### REQ-HPC-007 — VPN externa y secretos SSH password-only protegidos

MUST: La conexión MUST reconocer `openfortivpn gw.bsc.es:443` solo como VPN del host, y `bsc001997@glogin4.bsc.es` como perfil SSH/SFTP password verificado manualmente; nunca contraseña en repo/logs/flags CLI, verificación de TLS/known_hosts sin bypass.

- **Escenario verificable:** Given VPN caída o host key inválida, when se intenta inspección, then fail-closed y error no sensible. Given ejecución app, then no intenta sudo/PPP desde FastAPI.
- **Prueba prevista:** Security config review, fault injection y smoke autorizado.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0006`, `0008`.
- Resolver ADR relevante antes de decisiones irreversibles.
