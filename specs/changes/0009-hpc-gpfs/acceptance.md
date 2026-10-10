# 0009 — Integración MareNostrum 5 / Slurm / GPFS

**Estado:** DRAFT — NO APROBADO — PARTIAL / NOT RUN. **Fase:** F4 HPC. **Dependencias:** `0006`, `0008`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `HPC-001` | API/security check. Given GET artifact/status, when inspeccionar payload, then sin paths absolutos. | **NOT RUN** | PENDIENTE |
| `HPC-002` | MN5 smoke job. Given GPU requerida sin GPU, when submit, then bloquea o informa según política. | **NOT RUN** | PENDIENTE |
| `HPC-003` | HPC negative smoke. Given manifest truncado, when ingesta, then failed y evidencia de error. | **NOT RUN** | PENDIENTE |
| `HPC-004` | Revisión script y smoke seguro. Given error en subshell, when termina, then SLURM_JOB_ID sigue presente. | **NOT RUN** | PENDIENTE |

| `HPC-005` | Matrix de perfiles, smoke remoto aprobado y documentación por SO.; Given desarrollo sin red BSC, when tests, then mock opera sin secretos. Given VPN activa y autorización, when smoke SSH, then autentica con contraseña y host key válida. | **PARTIAL** | El 2026-10-10 se verificó manualmente VPN + SFTP con `bsc001997@glogin4.bsc.es`, host key válida y raíz autorizada; el perfil mock sigue offline. No existe todavía el cliente de aplicación ni un smoke científico aprobado. |
| `HPC-006` | INS-01..INS-18; mocks/adversarios + smoke MN5 exclusivamente de lectura.; Given traversal, symlink o solicitud de operación mutadora, when se llama al inspector, then se deniega sin ejecutar remote shell ni write SFTP. | **PARTIAL** | La sesión manual usó SFTP sin shell, sin `put`, `mkdir`, `remove`, `rename` ni jobs, y solo leyó la raíz autorizada. `ReadOnlyMN5Inspector` aún no existe; traversal/symlink/adversarial tests no están ejecutados. |
| `HPC-007` | Security config review, fault injection y smoke autorizado.; Given VPN caída o host key inválida, when se intenta inspección, then fail-closed y error no sensible. Given ejecución app, then no intenta sudo/PPP desde FastAPI. | **PARTIAL** | Se mantuvo validación de host key y la VPN quedó fuera de FastAPI; no se ejecutaron fault injections, ni existe aún la integración que permita verificar fail-closed en la aplicación. |

## Registro de ejecución obligatorio

- Fecha UTC: `2026-10-10`
- Commit/release: `e3c69c8`
- Comando/entorno/exit code: preflight local y sesión SFTP read-only; no se ejecutaron stages ni jobs
- Logs/artefactos/capturas: inventario documental local; no se conservaron secretos ni resultados científicos masivos
- Evaluación científica/operacional: inspección de código parcial; jobs y resultados NOT RUN
- Aprobador y excepciones: PENDIENTE

## Registro de preflight e inspección

- `openfortivpn`, `ssh` y `sftp` están instalados; `openfortivpn` está activo y creó `ppp0`.
- `gw.bsc.es` resolvió a `84.88.52.240`; el alias inicial `glogin.bsc.es` no resolvió. El perfil corregido `glogin4.bsc.es` resolvió a `212.128.225.11` y aceptó TCP/22 por la VPN.
- La host key ED25519 observada en `glogin4` coincidió con `~/.ssh/known_hosts`; no se usó `StrictHostKeyChecking=no` ni se añadió una clave sin verificación.
- SFTP con `bsc001997@glogin4.bsc.es` y autenticación password fue exitoso. `pwd` y los listados confirmaron `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`.
- La raíz contiene 19 paquetes bajo `stages/`; `orchestration/registry.py` registra 18 y `variant_structure_relaxation` es standalone. Se leyeron contratos, adapters, código, documentación y tests seleccionados.
- `/run/secrets/hpc_vpn_password` y `/run/secrets/hpc_ssh_password` no existen en el host. El fichero local ignorado `run/secrets/hpc_ssh_password` se dejó en modo `0600`; no se leyó su contenido ni se registró.
- No se ejecutó shell remoto, ningún stage, Slurm, GPFS mutador, `salloc`, `sbatch` ni `scancel`.
- El perfil mock de [`.env.example`](../../../.env.example) queda como camino seguro offline; el perfil real está en `.env`, ignorado por Git.

**No usar `PASS` hasta implementar el cliente/inspector, ejecutar los escenarios definidos y guardar evidencia concreta.**
