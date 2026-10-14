# Decisiones arquitectónicas abiertas (ADRs)

**Estado:** OPEN hasta decisión validada con responsables y evidencia. No sustituir por elecciones inventadas.

| ID | Tema y conflicto | Bloquea | Acción necesaria |
| --- | --- | --- | --- |
| ADR-001 | Transporte seguro web/worker ↔ MN5/Slurm/GPFS | 0009, 0014 | Decisión del equipo de infraestructura, políticas de red y permisos |
| ADR-002 | Biblioteca viewer: Mol* frente a alternativa | 0003, 0012 | Benchmark reproducible en PDB/mmCIF real y licencia |
| ADR-003 | Relación PDB/mmCIF `auth_seq_id`, `label_seq_id`, chain/model/icode ↔ `aa_position` | 0003, 0012 | Mapping validado con fixtures ambiguos y `aa_ref` |
| ADR-004 | SSO/institución, roles, proyecto, modelo sharing y confidencialidad | 0013 | Threat model y dueño de datos |
| ADR-005 | PDF objetivo llama `reference_preparation`; documentación actual llama `protein_relaxation_energy` | 0007, 0010 | Contrastar código, contrato de migración y alias explícito |
| ADR-006 | PDF conserva `legacy_id` en provenance; `05-migration.md` documenta ausencia de `legacy_id` en código actual | 0007, 0010 | Aprobar política versionada de provenance sin inventar un campo actual |
| ADR-007 | PDF habla de export `aa_annotations.tsv`; pipeline documentado usa `annotations.tsv` | 0010, 0011 | Versionar endpoint/export y validar scripts consumidores |
| ADR-008 | cache_key del PDF incluye tool/model versions y recursos; código documentado incluye además hash de código | 0008 | Serialización canónica, casos de invalidación y comparación con cache real |
| ADR-009 | Host de servicios, secretos y política de despliegue BSC | 0009, 0014 | Diagrama de red/confianza y aprobación operativa |
| ADR-010 | Presupuesto de latencia API, WebGL y concurrencia, GPU/CPU quotas, RPO/RTO | 0012–0015 | Baseline y objetivos medibles aprobados |
| ADR-011 | Retención de artefactos, referencias compartidas entre usuarios y acceso autorizado | 0008, 0011, 0013 | Modelo de ownership, GC y protección de datos |
| ADR-012 | Pipeline del PDF frente a 18 stages actuales: barreras A/B/C, etapa identidad, rama de preparación de estructura | 0007, 0010 | Contrastar registro y dependencia científica real, no orden histórico |

**Fuente de divergencias:** `Arquitectura propuesta.pdf` (pp. 2–10) frente a `02-orchestration.md`, `03-stages.md` y `05-migration.md`. El PDF es **diseño objetivo**; los Markdown son **descripción del pipeline documentado**. Ninguno se declara implementación verificada sin inspección del código/outputs.

Cada decisión aprobada debe generar un archivo ADR con fecha, estado, autor, drivers, opciones, impacto en contratos, evidencia y rollback.

## Decisiones abiertas adicionales — acceso VPN + SSH de inspección read-only

| ID | Tema | Bloquea | Evidencia/decisión necesaria |
| --- | --- | --- | --- |
| ADR-013 | Acceso de agentes mediante SSH **password-only** y cuenta personal BSC (`bsc001997`) en `glogin4.bsc.es` | 0007, 0009, 0013 | El login/SFTP manual fue verificado; falta confirmar permiso institucional para automatización y forma de proveer credencial sin compartir la cuenta personal; identidad restringida read-only si BSC lo permite |
| ADR-014 | VPN `openfortivpn gw.bsc.es:443` en Linux y solución VPN host Windows/WSL2 | 0009, 0014 | Validar certificados, DNS/rutas desde contenedores, gestión de secretos y desconexión sin root en FastAPI |
| ADR-015 | Perímetro GPFS de inspección, symlinks, TOCTOU, tipos/volúmenes de archivos y política de descarga local | 0007, 0009, 0013 | Aprobar raíz fija, deny de symlinks, cuotas, necesidad de ACL read-only OS y gestión de evidencias |
| ADR-016 | Despliegue permanente dentro BSC (`native`) versus solo cuota GPFS/Slurm | 0014, 0015 | Confirmar servicio persistente/VM autorizado. `salloc` y espacio de proyecto no son web hosting |
| ADR-017 | Namespace de configuración `HPC_*` recibido frente a `MN5_*` propuesto por el contrato read-only | 0009, 0014 | El perfil real ya fue verificado manualmente como `glogin4.bsc.es`/`bsc001997`; todavía falta elegir nombres canónicos, equivalencias, precedencia, migración y si `HPC_POLL_INTERVAL_SECONDS` pertenece al cliente ejecutor o al supervisor |
| ADR-018 | P07 `variant_ddg`: entrypoint registrado Rosetta frente a `core.py`/docs legacy FoldX; gates Slurm no reflejados de forma uniforme en los contratos | 0010, 0009 | Tomar `stage.py` + registry como fuente del camino actual, marcar FoldX como legacy hasta decisión, y actualizar `technical_requirements`/runtime policy para `SLURM_JOB_ID` antes de planificar jobs desde la plataforma |

`ADR-001` debe distinguir **HPCClient de ejecución** de **ReadOnlyMN5Inspector para observación técnica**. Este segundo contrato no habilita un browser GPFS público ni autoriza writes del pipeline. Ver [`contracts/mn5-readonly-inspection.md`](contracts/mn5-readonly-inspection.md).

La inspección read-only de MN5 confirmó la evidencia de ADR-018 en la raíz `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`, pero no resuelve la decisión: no se ejecutaron stages ni jobs y el producto local todavía no implementa el cliente HPC.

## ADR-018 — Fuente de verdad y gates de `variant_ddg`

**Estado:** OPEN — requiere aprobación manual.  
**Fecha:** 2026-10-10  
**Supersede:** ninguna.

### Contexto y evidencia

La inspección SFTP read-only del checkout MN5 observó que `orchestration/registry.py` registra `variant_ddg` y que `stages/variant_ddg/stage.py` llama al runtime Rosetta (`pipeline_runtime.py`/`rosetta_runner.py`). El contrato remoto declara scoring WT/MUT emparejado, `rosetta_metadata` y `variant_set`. En paralelo, `stages/variant_ddg/core.py`, `docs/stages/variant_ddg.md` y el job legacy `jobs/p07_all_variants.sbatch` describen FoldX BuildModel. También se observó que `structural_contacts` exige `SLURM_JOB_ID` en el core aunque su `technical_requirements` esté vacío, y que el camino Rosetta de `protein_relaxation_energy` requiere una asignación Slurm para MPI.

La evidencia es de código, contrato y documentación; no incluye una corrida ni un resultado científico.

### Drivers

- No ejecutar desde la plataforma un protocolo distinto del que el registry registra.
- Mantener trazabilidad de método, versión, recursos y launcher en provenance.
- Evitar que el scheduler admita etapas que fallan tarde por un gate Slurm no declarado.
- Preservar compatibilidad con los artefactos legacy mientras se decide su retiro.

### Opciones consideradas

1. **Tratar FoldX como camino actual:** compatible con la documentación legacy, pero contradice el entrypoint registrado y el contrato actual.
2. **Tratar Rosetta como camino registrado actual y FoldX como legacy:** coincide con `stage.py`, registry y contrato; requiere actualizar docs/jobs legacy y validar una corrida.
3. **Mantener ambos como protocolos seleccionables:** ofrece compatibilidad, pero exige un selector explícito, contratos de artefactos separados y provenance inequívoca; no debe inferirse por el nombre del archivo.

### Decisión provisional propuesta

Mientras el ADR siga abierto, la integración de la plataforma debe tratar `stage.py` + registry + `contract.py` como fuente del camino registrado: P07 es Rosetta. FoldX se documenta como legacy y no se declara eliminado ni científicamente aceptado. Antes de habilitar ejecución, se debe elegir formalmente la opción 2 o 3, actualizar la documentación/job correspondiente y añadir los gates `SLURM_JOB_ID`/launcher a los contratos o a una política de runtime verificable.

### Consecuencias, riesgos y rollback

- **Positivas:** el planificador no confunde el protocolo ejecutable con la documentación antigua; provenance puede distinguir método y recursos.
- **Costes:** habrá que actualizar docs, jobs, fixtures y posiblemente claves de caché; puede requerir migración de artefactos P07.
- **Riesgos:** declarar Rosetta sin smoke autorizado puede ocultar un fallo de módulos, licencia o launcher; declarar FoldX por costumbre puede ejecutar un camino que ya no es el registrado.
- **Rollback:** hasta la aprobación, mantener P07 fuera de una ruta de ejecución productiva y conservar ambos caminos solo como código/documentación sin modificar sus resultados existentes.

### Seguimiento

- Propietario: equipo de integración científica/HPC.
- Evidencia requerida: decisión aprobada, contrato actualizado, tests de launcher/gates y smoke Slurm de P07 con provenance.
- Referencias: [`docs/mn5-stage-code-inventory.md`](../../../docs/mn5-stage-code-inventory.md), `stages/variant_ddg/stage.py`, `stages/variant_ddg/contract.py`, `stages/variant_ddg/pipeline_runtime.py`, `docs/stages/variant_ddg.md` en el checkout MN5.
