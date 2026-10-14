# Matriz de trazabilidad SDD — Producto completo

Estado de corte: 2026-10-14. Esta matriz se sincroniza con la evidencia de cada `acceptance.md`; `PASS local` no equivale a cierre humano, CI remota, aceptación científica ni autorización MN5.

| REQ | Change dueño | Método de aceptación previsto | Estado |
| --- | --- | --- | --- |
| `REQ-SCF-001` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Estructura inicial por features — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-SCF-002` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Health backend inequívoco — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-SCF-003` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Señal frontend basada en respuesta real — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-SCF-004` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Manejo explícito de indisponibilidad — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-SCF-005` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Compose mínimo y funcional — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-SCF-006` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Configuración explícita y sin secretos — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-SCF-007` | [0001-repository-scaffold](changes/0001-repository-scaffold/acceptance.md) | Documentación de onboarding reproducible — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-QLT-001` | [0002-repository-quality](changes/0002-repository-quality/acceptance.md) | Test backend mínimo — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-QLT-002` | [0002-repository-quality](changes/0002-repository-quality/acceptance.md) | Formato y lint reproducibles — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-QLT-003` | [0002-repository-quality](changes/0002-repository-quality/acceptance.md) | Checks frontend y automatización CI — ver escenario y evidencia en spec/acceptance | **PARTIAL — CI NOT RUN** |
| `REQ-QLT-004` | [0002-repository-quality](changes/0002-repository-quality/acceptance.md) | Validación independiente del cluster — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-VIZ-001` | [0003-structure-viewer](changes/0003-structure-viewer/acceptance.md) | Visualización real de estructura — ver escenario y evidencia en spec/acceptance | **PARTIAL — upload API + browser Mol* PASS; StageResult NOT RUN** |
| `REQ-VIZ-002` | [0003-structure-viewer](changes/0003-structure-viewer/acceptance.md) | Selección trazable por residuo — ver escenario y evidencia en spec/acceptance | **PARTIAL — código + browser smoke; multi-chain/mapping NOT RUN** |
| `REQ-VIZ-003` | [0003-structure-viewer](changes/0003-structure-viewer/acceptance.md) | Mapping canónico honesto — ver escenario y evidencia en spec/acceptance | **PARTIAL — código** |
| `REQ-VIZ-004` | [0003-structure-viewer](changes/0003-structure-viewer/acceptance.md) | Fallos explícitos — ver escenario y evidencia en spec/acceptance | **PARTIAL — código** |
| `REQ-VIZ-005` | [0003-structure-viewer](changes/0003-structure-viewer/acceptance.md) | Biblioteca elegida con evaluación reproducible — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-PROT-001` | [0004-protein-identity](changes/0004-protein-identity/acceptance.md) | Secuencia canónica — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-PROT-002` | [0004-protein-identity](changes/0004-protein-identity/acceptance.md) | Rechazo fiable — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-PROT-003` | [0004-protein-identity](changes/0004-protein-identity/acceptance.md) | Aliases separados — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-PROT-004` | [0004-protein-identity](changes/0004-protein-identity/acceptance.md) | Consultas privadas — ver escenario y evidencia en spec/acceptance | **PASS local / gate externo pendiente** |
| `REQ-RUN-001` | [0005-run-domain](changes/0005-run-domain/acceptance.md) | Creación no bloqueante — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-RUN-002` | [0005-run-domain](changes/0005-run-domain/acceptance.md) | Ownership correcto — ver escenario y evidencia en spec/acceptance | **PASS local — reuso por cache_key** |
| `REQ-RUN-003` | [0005-run-domain](changes/0005-run-domain/acceptance.md) | Estados válidos — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-RUN-004` | [0005-run-domain](changes/0005-run-domain/acceptance.md) | Lectura verificable — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-EXEC-001` | [0006-dag-worker](changes/0006-dag-worker/acceptance.md) | Separación operativa — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-EXEC-002` | [0006-dag-worker](changes/0006-dag-worker/acceptance.md) | Dependencias del pipeline — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-EXEC-003` | [0006-dag-worker](changes/0006-dag-worker/acceptance.md) | Claim transaccional — ver escenario y evidencia en spec/acceptance | **PASS local — PostgreSQL, 2 sesiones** |
| `REQ-EXEC-004` | [0006-dag-worker](changes/0006-dag-worker/acceptance.md) | Cancelación durable — ver escenario y evidencia en spec/acceptance | **PASS local — PostgreSQL cancel/finalize** |
| `REQ-SCI-001` | [0007-science-baseline](changes/0007-science-baseline/acceptance.md) | Baseline reproducible — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-SCI-002` | [0007-science-baseline](changes/0007-science-baseline/acceptance.md) | Equivalencia comprobada — ver escenario y evidencia en spec/acceptance | **PARTIAL — comparador local / baseline NOT RUN** |
| `REQ-SCI-003` | [0007-science-baseline](changes/0007-science-baseline/acceptance.md) | Identidad de residuo — ver escenario y evidencia en spec/acceptance | **PASS local / integración científica parcial** |
| `REQ-SCI-004` | [0007-science-baseline](changes/0007-science-baseline/acceptance.md) | Separación topología/confianza — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-CACHE-001` | [0008-cache-manifests](changes/0008-cache-manifests/acceptance.md) | Key completa — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-CACHE-002` | [0008-cache-manifests](changes/0008-cache-manifests/acceptance.md) | Hits validables — ver escenario y evidencia en spec/acceptance | **PASS local — miss por artefacto ausente** |
| `REQ-CACHE-003` | [0008-cache-manifests](changes/0008-cache-manifests/acceptance.md) | Publicación atómica — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-CACHE-004` | [0008-cache-manifests](changes/0008-cache-manifests/acceptance.md) | Provenance auditable — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-HPC-001` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | Aislamiento — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-HPC-002` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | Adaptador Slurm — ver escenario y evidencia en spec/acceptance | **PARTIAL local / smoke NOT RUN** |
| `REQ-HPC-003` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | Manifiesto final — ver escenario y evidencia en spec/acceptance | **PARTIAL local / smoke NOT RUN** |
| `REQ-HPC-004` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | Seguridad salloc — ver escenario y evidencia en spec/acceptance | **PARTIAL local / smoke NOT RUN** |
| `REQ-STAGE-001` | [0010-scientific-integration](changes/0010-scientific-integration/acceptance.md) | Contrato uniforme — ver escenario y evidencia en spec/acceptance | **PASS local estructural** |
| `REQ-STAGE-002` | [0010-scientific-integration](changes/0010-scientific-integration/acceptance.md) | Integridad per-residue — ver escenario y evidencia en spec/acceptance | **PARTIAL — outputs remotos acotados** |
| `REQ-STAGE-003` | [0010-scientific-integration](changes/0010-scientific-integration/acceptance.md) | Rollout por lote — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-STAGE-004` | [0010-scientific-integration](changes/0010-scientific-integration/acceptance.md) | Sin inventar ciencia — ver escenario y evidencia en spec/acceptance | **PARTIAL — código** |
| `REQ-API-001` | [0011-incremental-api](changes/0011-incremental-api/acceptance.md) | Resultados parciales — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-API-002` | [0011-incremental-api](changes/0011-incremental-api/acceptance.md) | SSE resiliente — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-API-003` | [0011-incremental-api](changes/0011-incremental-api/acceptance.md) | Artefactos autorizados — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-API-004` | [0011-incremental-api](changes/0011-incremental-api/acceptance.md) | API rápida sin ciencia — ver escenario y evidencia en spec/acceptance | **PASS local — diseño** |
| `REQ-UX-001` | [0012-residue-explorer](changes/0012-residue-explorer/acceptance.md) | Flujo usuario — ver escenario y evidencia en spec/acceptance | **PARTIAL — E2E científico NOT RUN** |
| `REQ-UX-002` | [0012-residue-explorer](changes/0012-residue-explorer/acceptance.md) | Selección sincronizada — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-UX-003` | [0012-residue-explorer](changes/0012-residue-explorer/acceptance.md) | Estados científicos claros — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-UX-004` | [0012-residue-explorer](changes/0012-residue-explorer/acceptance.md) | Accesibilidad y benchmark — ver escenario y evidencia en spec/acceptance | **PARTIAL** |
| `REQ-SEC-001` | [0013-security-access](changes/0013-security-access/acceptance.md) | Authz por recurso — ver escenario y evidencia en spec/acceptance | **PASS local / aprobación externa pendiente** |
| `REQ-SEC-002` | [0013-security-access](changes/0013-security-access/acceptance.md) | Sin secretos — ver escenario y evidencia en spec/acceptance | **PASS local / gate externo pendiente** |
| `REQ-SEC-003` | [0013-security-access](changes/0013-security-access/acceptance.md) | Cuotas aprobadas — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-SEC-004` | [0013-security-access](changes/0013-security-access/acceptance.md) | Auditoría — ver escenario y evidencia en spec/acceptance | **PASS local** |
| `REQ-AUTH-001` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Registro y verificación — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-AUTH-002` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Login, refresh rotation y logout — ver escenario y evidencia en spec/acceptance | **PASS local — incluye carrera PostgreSQL** |
| `REQ-AUTH-003` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Middleware Bearer y autorización — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-AUTH-004` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Cambio y reset de password — ver escenario y evidencia en spec/acceptance | **PASS local — serializado por usuario** |
| `REQ-AUTH-005` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Rate limits y auditoría — ver escenario y evidencia en spec/acceptance | **PASS local — incluye carrera PostgreSQL** |
| `REQ-AUTH-006` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Una run no terminal por usuario — ver escenario y evidencia en spec/acceptance | **PASS local — carrera PostgreSQL** |
| `REQ-AUTH-007` | [0016-auth-account-security](changes/0016-auth-account-security/acceptance.md) | Uploads pequeños y SCP confinado — ver escenario y evidencia en spec/acceptance | **PARTIAL local / SCP NOT RUN** |
| `REQ-OPS-001` | [0014-operations-deployment](changes/0014-operations-deployment/acceptance.md) | Recovery — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-OPS-002` | [0014-operations-deployment](changes/0014-operations-deployment/acceptance.md) | Backup restaurable — ver escenario y evidencia en spec/acceptance | **PASS local aislado** |
| `REQ-OPS-003` | [0014-operations-deployment](changes/0014-operations-deployment/acceptance.md) | Observabilidad — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-OPS-004` | [0014-operations-deployment](changes/0014-operations-deployment/acceptance.md) | Despliegue controlado — ver escenario y evidencia en spec/acceptance | **PARTIAL local** |
| `REQ-REL-001` | [0015-product-release](changes/0015-product-release/acceptance.md) | Flujo E2E real — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-REL-002` | [0015-product-release](changes/0015-product-release/acceptance.md) | Reuso selectivo — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-REL-003` | [0015-product-release](changes/0015-product-release/acceptance.md) | Regresión científica — ver escenario y evidencia en spec/acceptance | **NOT RUN** |
| `REQ-REL-004` | [0015-product-release](changes/0015-product-release/acceptance.md) | Release auditado — ver escenario y evidencia en spec/acceptance | **NOT RUN** |

## Trazabilidad adicional (fichas científicas y HPC)

| `REQ-SCI-005` | [0007-science-baseline](changes/0007-science-baseline/acceptance.md) | Evidencia científica remota obtenida sin modificación: Revisión del inspector y comparación de metadata de archivos antes/después (solo operaciones de lectura). | **PARTIAL** |
| `REQ-HPC-005` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | Backend HPC adaptado a Linux/Windows y BSC: Matrix de perfiles, smoke remoto aprobado y documentación por SO. | **PARTIAL** — transporte manual SFTP verificado; cliente de aplicación y smoke científico pendientes |
| `REQ-HPC-006` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | Inspector separado estrictamente solo lectura: INS-01..INS-18; mocks/adversarios + smoke MN5 exclusivamente de lectura. | **PARTIAL** — inspector local/SFTP, límites y pruebas adversariales implementados; matriz formal y aprobación MN5 pendientes |
| `REQ-HPC-007` | [0009-hpc-gpfs](changes/0009-hpc-gpfs/acceptance.md) | VPN externa y secretos SSH password-only protegidos: Security config review, fault injection y smoke autorizado. | **PARTIAL** — host key y separación VPN/app revisadas; fault injection e integración pendientes |
| `REQ-SEC-005` | [0013-security-access](changes/0013-security-access/acceptance.md) | Gobierno de inspección GPFS de solo lectura: INS-04..INS-11, INS-15, threat model/ADR-013. | **PARTIAL local/remoto** |
| `REQ-OPS-005` | [0014-operations-deployment](changes/0014-operations-deployment/acceptance.md) | Operación multiplataforma VPN/SSH y modo nativo aprobado: Linux/Windows connectivity drills y revisión de hosting BSC. | **PARTIAL Linux / Windows NOT RUN** |
| `REQ-REL-005` | [0015-product-release](changes/0015-product-release/acceptance.md) | Aceptación de permisos remotos y ausencia de escrituras: INS-01..INS-18, revisión independiente de permisos y evidencia del smoke read-only. | **PARTIAL read-only smoke / sign-off pendiente** |

## Política de cierre

Una obligación `MUST` solo se marca PASS tras ejecución y evidencia (comando/entorno/resultado). `NOT RUN` es un bloqueo de aceptación, no un resultado positivo. Para R5, comparar también invariantes de `constitution.md`, `contracts/` y las 18 fichas científicas contra el pipeline real.

Las 18 fichas científicas principales tienen ahora revisión de código/contrato/entrypoint contra MN5 (`CODE REVIEWED`); los criterios de ejecución, baseline, equivalencia y aceptación siguen en `NOT RUN` hasta obtener outputs y evidencia reproducible.
