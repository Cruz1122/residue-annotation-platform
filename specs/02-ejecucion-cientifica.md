# 02 — Ejecución científica en MareNostrum 5

**Estado:** golden path real de `protein_identity` demostrado en MN5 mediante VPN/SSH/Slurm, publicación verificada por la API y reuso posterior sin un segundo job. La aceptación científica de los stages restantes, el prefetch externo y el baseline de producción siguen pendientes; esta spec no declara producción científica completa.

## Objetivo

Tomar una run configurada y persistida, preparar únicamente los materiales que necesita, enviarla al pipeline real de MareNostrum 5, supervisarla y publicar resultados científicos verificables para esa run.

La persona usuaria no debe administrar VPN, SSH, prefetch ni Slurm. El worker coordina esas operaciones dentro de los perfiles autorizados y mantiene el estado de producto en PostgreSQL.

## Experiencia del usuario

1. La persona confirma una run ya validada.
2. El sistema comunica que está preparando los datos y comprobando prerrequisitos.
3. El worker envía la ejecución al entorno autorizado sin pedir comandos manuales.
4. La persona ve si el trabajo espera recursos, está ejecutándose, terminó, falló o fue cancelado.
5. Los resultados aparecen únicamente después de que el manifest y los artefactos hayan sido validados.
6. Una segunda run puede reutilizar stages publicados equivalentes y ejecutar sólo lo que falte, conservando su propio seguimiento.

## Comportamiento esperado

### Preparación y modos de ejecución

El worker recupera la configuración persistida de la run y elige el perfil disponible:

| Perfil | Comportamiento |
| --- | --- |
| Local, Linux/Windows | Utiliza la frontera de contenedores y el mecanismo autorizado de VPN del host, después la conexión SSH con host keys y secretos protegidos. La persona no instala ni inicia la VPN manualmente. |
| MN5 nativo | Usa Slurm y GPFS directamente cuando BSC haya autorizado un servicio persistente y los recursos estén disponibles. No crea una sesión SSH ni repite el prefetch remoto sin necesidad. |
| Offline/mock de desarrollo | Permite probar estados, contratos y fallos de forma segura, pero nunca se presenta como resultado científico ni como integración real con MN5. |

Los hosts, usuarios, secretos, raíces y módulos se obtienen de configuración autorizada. No se hardcodean contraseñas, tokens ni rutas privadas en la run o en el frontend. La configuración observada en el repositorio usa el gateway VPN `gw.bsc.es:443` y un destino SSH configurado; cualquier alias de prefetch debe validarse contra el entorno real antes de habilitarlo.

### Prefetch y prerrequisitos

El prefetch se ejecuta antes del submit científico sólo en el modo y stages que lo necesitan. No se descargan recursos indiscriminadamente.

La selección actual del pipeline identifica como candidatos:

- `uniprot_features`: cachés de UniProt e InterPro;
- `experimental_variant_evidence`: caché aprobada de MaveDB;
- `evolutionary_conservation`: homólogos o caché de homología aprobada;
- `structure_modeling` y `conformational_ensemble`: entrada MSA `af3-msa-v1` cuando el flujo seleccionado la requiere.

Los recursos locales de predictores, farmacogenómica y evidencia funcional no se descargan por defecto como si fueran una tarea de red. La existencia de `network=True` en el registro no elimina el gate cache-only del job de cómputo.

Si un prerrequisito obligatorio no está disponible, el worker no envía un job que fallará de forma previsible. Registra el motivo, conserva la run recuperable y lo muestra como preparación fallida o pendiente según si puede reintentarse.

La preparación es durable: `RunPreparation` conserva los requisitos de la run,
los que ya fueron satisfechos, snapshots, clave de preparación, intentos y
errores; cada `RunStage` conserva el estado y el próximo instante de reintento
del preflight. El adapter remoto sólo recibe los requisitos faltantes de la
etapa reclamada. La última línea del comando debe ser un acknowledgement JSON
con `status=success` y exactamente los requisitos solicitados; texto plano,
estados ambiguos y snapshots fuera de tamaño se rechazan. Si el comando de
prefetch no está configurado, no reconoce algún requisito o falla, la etapa
vuelve a `ready` con preflight bloqueado y el worker no llama a `sbatch`.

### Construcción y envío del job

- El comando se construye desde `RunConfig`, no desde el estado del navegador ni de variables efímeras.
- Se utiliza la CLI real de `main.py` observada en el pipeline remoto; no se inventan flags ni nombres de stage.
- La solicitud conserva accession, inputs materializados, fuente AF3/PDB, variants, stages, dependencias, recursos, directorios, logs y correlación con `run_id`.
- El worker usa `sbatch` sólo después de que inputs, prefetch, recursos y configuración hayan pasado sus gates.
- Cuando el pipeline remoto resuelve entradas normales bajo `uploads/<protein_id>`, el worker usa un namespace `uploads/platform-run-<run_id>` aislado por run y pasa la accesión científica por `--accession`; esto evita que FASTA/PDB preexistentes bajo otra carpeta cambien la entrada confirmada.
- El identificador Slurm se persiste inmediatamente y se puede recuperar si la respuesta de submit se pierde, evitando un doble submit.
- Una pérdida ambigua durante `submit` no se reintenta dentro del mismo tick: la etapa queda reintentable y la siguiente invocación reconcilia primero el receipt determinista.
- Si Slurm acepta el job pero falla la publicación del receipt, el wrapper devuelve un marcador `SUBMISSION_AMBIGUOUS:<job_id>` y el worker persiste ese `job_id` para polling/cancelación en vez de volver a enviar.
- Slurm es fuente de verdad del estado del job remoto; PostgreSQL es fuente de verdad del estado de producto y de las transiciones persistidas de cada `RunStage`.

### Reuso antes de calcular

Antes de enviar un stage, el worker evalúa la `cache_key` científica prevista y busca un `StageResult` reusable. Si encuentra un resultado `success` con artefactos íntegros y autorizado:

1. crea o conserva el `RunStage` de la nueva run;
2. lo marca `reused`;
3. enlaza el `stage_result_id` existente;
4. registra la clave, provenance y razón del hit;
5. desbloquea los descendientes que ya tienen todas sus dependencias utilizables;
6. no ejecuta `sbatch` para ese stage.

Si la clave difiere, faltan artefactos, el manifest es incompatible, el resultado no es `success` o una política de acceso impide el vínculo, se trata como miss. El cálculo queda asociado sólo a la nueva run. Dos runs pueden compartir un `StageResult`, pero nunca comparten silenciosamente un `RunStage`, un lease, un job, un error o el estado global.

La matriz científica de qué puede llegar a reutilizarse está en [01 — Entrada y configuración](01-entrada-configuracion.md). En particular, estructura, ensemble y `variant_ddg` exigen coincidencia de estructura/entrada upstream y, para `variant_ddg`, del conjunto exacto de variantes.

### Estados del worker

Los nombres persistidos actuales se conservan y la UI puede traducirlos a mensajes de preparación. El worker debe distinguir, al menos:

| Situación observable | Estado persistido o señal | Regla |
| --- | --- | --- |
| Run recibida y validándose | `pending`/preparación | No afirmar que el cálculo empezó. |
| Stage listo para ser tomado | `ready` | Dependencias disponibles; aún no hay recursos asignados. |
| Trabajo aceptado o esperando recurso | `queued` y estado Slurm pendiente | Mostrar “esperando recursos”, no porcentaje ficticio. |
| Job en ejecución | `running` y estado Slurm activo | Habilitar seguimiento de ejecución. |
| Resultado vinculado desde caché | `reused` | No hubo cálculo nuevo para ese stage. |
| Resultado publicado | `success` | Sólo después de manifest, provenance, integridad y anotaciones válidas. |
| Error, omisión o cancelación | `failed`, `skipped`, `cancelled` | Conservar código y mensaje accionable. |

Un worker reiniciado reconcilia jobs ya aceptados antes de volver a enviar trabajo. Una desconexión no convierte automáticamente un job Slurm aceptado en fallo; se consulta y se reconcilia.

### Publicación de resultados

- El pipeline remoto escribe en su workspace de ejecución y publica `result_manifest.json` al final.
- El manifest incluye stage/version, `cache_key`, hashes/tamaños, schema de anotaciones, provenance, versiones y referencias relativas.
- El worker valida paths confinados, integridad, `aa_position` y `aa_ref`, tipos de anotación, status de salida y requisitos del stage.
- PostgreSQL almacena estados, referencias, metadata y anotaciones necesarias para la API; los artefactos pesados permanecen en la frontera de almacenamiento autorizada y no se exponen por SSH al navegador.
- Un crash antes del manifest final no es `success`. Un manifest corrupto o incompleto tampoco.
- El adapter acepta el contrato MN5 desplegado, cuyo bloque de cache/provenance vive bajo `provenance.operational`, y lo enlaza con la clave local planificada mediante comprobaciones estrictas de secuencia, ejes query/reference, dependencias, parámetros, manifest y consistencia de la clave remota.
- El inspector read-only de MN5 continúa separado del ejecutor y sólo puede consultar la raíz autorizada `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`; la ejecución autorizada tiene su propio contrato y no convierte el inspector en feature de usuario.

## Contratos esenciales

### Límites de responsabilidad

```mermaid
flowchart LR
    Config[RunConfig persistida] --> Worker[Worker]
    Worker --> Prep[Inputs y prefetch necesario]
    Prep --> Slurm[Slurm / pipeline real]
    Slurm --> Manifest[Manifest + artifacts + provenance]
    Manifest --> API[PostgreSQL / FastAPI]
    API --> Browser[Frontend]
```

- El navegador sólo llama a FastAPI.
- El worker es dueño de preparación, submit, polling/reconciliación, ingestión y transiciones.
- Slurm es dueño del estado del job; no se simula su ejecución con un porcentaje local.
- El pipeline científico es dueño de los outputs y su provenance; el producto valida antes de publicarlos.
- Las credenciales HPC nunca llegan al frontend ni se escriben en logs.

### Reuso y publicación

La unicidad actual de `StageResult` por `(protein_id, stage_id, cache_key)` es un índice de resultado, no un identificador de run. El worker debe conservar esa separación y aplicar el mismo criterio de equivalencia tanto para hits previos como para carreras donde dos runs intenten publicar el mismo resultado.

El resultado reutilizable debe tener:

- clave científica canónica;
- estado `success`;
- artefactos requeridos localizables, con tamaño y hash verificables;
- manifest y provenance compatibles;
- upstream keys que coincidan;
- autorización del propietario/proyecto receptor.

La publicación se hace de forma atómica. No se crea una fila `success` parcial ni se purgan artefactos de un resultado válido antes de que la nueva publicación sea durable.

### Evidencia técnica usada

- El worker actual implementa claims, leases, heartbeat, recuperación y finalización: [`backend/app/features/runs/worker_service.py`](../backend/app/features/runs/worker_service.py).
- La frontera SSH/native construye y reconcilia jobs, ingesta manifests y verifica reuso por clave e integridad: [`backend/app/features/runs/remote_executor.py`](../backend/app/features/runs/remote_executor.py).
- El inventario remoto documenta la CLI, los 18 IDs, recursos, prerrequisitos y cachés externas: [`docs/mn5-stage-code-inventory.md`](../docs/mn5-stage-code-inventory.md).
- El preflight y la preparación durable están implementados en [`backend/app/features/runs/preflight.py`](../backend/app/features/runs/preflight.py), [`backend/app/features/runs/worker_service.py`](../backend/app/features/runs/worker_service.py) y la migración [`0008_run_preparation`](../backend/alembic/versions/0008_run_preparation.py).
- La regresión local cubre “prefetch ausente ⇒ no submit”, prefetch selectivo y pérdida de transporte sin doble intento en [`backend/tests/test_preflight_execution.py`](../backend/tests/test_preflight_execution.py); el contrato de render/acknowledgement está cubierto en [`backend/tests/test_hpc_clients.py`](../backend/tests/test_hpc_clients.py).
- El smoke autorizado de esta implementación ejecutó la run `adb90655-878f-4a4b-9bc3-197f38701a5e` para `P22309` con FASTA de 542 bytes y SHA `0262c498…`; el job `47310214` fue aceptado por Slurm con cuenta `bsc08`, QoS `acc_bscls`, partición `acc`, nodo `as06r1b18` y terminó `COMPLETED|0:0`.
- La regresión real PDB-only `a86eae8d-28a7-47a9-88ca-a62d93bbe861` para `P69905` materializó un FASTA canónico run-owned (`0a5e2e95-5688-45de-8c68-2602e8d1564a`, 151 bytes, SHA `f26f7d9a…`), lo transfirió al namespace aislado del run y obtuvo el job Slurm `47311609`; se canceló mientras esperaba cola para no consumir recursos, por lo que no se presenta como evidencia de publicación científica.
- El log remoto registró `pdb=None`, la secuencia `dd312bcf…` confirmada localmente, `CACHE MISS`, `DONE` con 533 filas y cobertura `533/533`; el manifest y el bloque `operational` de provenance pasaron las validaciones de integridad y binding del adapter.
- PostgreSQL publicó `StageResult` `66ce5738-b8d4-4c56-be37-3dde1f9e39e1` con 13 artefactos y 46,531 bytes; la API devolvió 533 anotaciones `qc_status=verified`, desde `aa_position=1` hasta `533`, y el artefacto TSV descargado por FastAPI conservó 10,587 bytes y su SHA registrado.
- La run `f0acc8f7-5b38-4466-822e-7e96d8afa773` reutilizó ese mismo `StageResult` con `slurm_job_id=null`, autorización owner/project e integridad de artefactos verificada; no se creó un segundo job. Ambas runs se cancelaron después del root para no iniciar stages posteriores no preparados.
- Durante el smoke se corrigieron y quedaron cubiertos el aislamiento frente a inputs remotos ambientales, la transferencia con permisos compartidos backend/worker, el receipt de submit ausente, el provenance MN5 anidado y la carrera cancelación/preflight. Estos hechos no sustituyen un baseline científico aprobado.

## Estado actual

### Implementado o parcialmente implementado

- Existe un worker separado con estados, claims PostgreSQL, leases, heartbeat, cancelación y recuperación de etapas colgadas.
- Existen perfiles offline, SSH y native, transferencia confinada de inputs y validación local de manifests.
- El perfil SSH fue ejercitado contra el entorno autorizado: VPN activa, autenticación SSH con host key, transferencia SCP, `sbatch`, polling Slurm, lectura bounded del resultado, publicación en PostgreSQL y lectura posterior por FastAPI.
- `RunConfiguration` conserva la intención científica confirmada: identidad, accession, hashes de inputs, fuente/mapping estructural, variantes, stages seleccionados/omitidos, parámetros, requisitos y versiones.
- El worker ejecuta un preflight persistido antes de transferir/submit: valida identidad, hashes, accession, estructura, dependencias, recursos y requisitos técnicos; bloquea de forma recuperable lo que requiere intervención operativa.
- El prefetch externo es selectivo y explícito para SSH/native: exige un comando configurado por el operador con `{accession}` y `{requirements}`, persiste su acknowledgement/snapshots y no permite que el payload de usuario elija un shell command.
- La frontera remota puede recuperar un `job_id` tras pérdida de respuesta y evita doble submit en ese camino.
- El executor remoto ingesta manifests y tiene lookup de `StageResult` reusable por `(protein_id, stage_id, cache_key)` con comprobación de artefactos; para MN5 conserva la clave remota y una alias local de la configuración confirmada.
- El registry local contiene 18 stages, dependencias, recursos y gates técnicos; el inventario remoto se revisó de forma read-only.

### Pendiente o no demostrado

- [`backend/app/features/runs/worker_service.py`](../backend/app/features/runs/worker_service.py) no contiene adapters científicos locales: el executor offline falla de forma auditable en vez de inventar éxito.
- La compatibilidad del command builder con `main.py` y el registry MN5 quedó demostrada para `protein_identity`; el checkout local no contiene ese `main.py` científico y los demás stages aún necesitan su propia evidencia.
- El golden path `run → worker → VPN/SSH → Slurm → manifest → PostgreSQL → API` está demostrado sólo para `protein_identity`; no se debe extrapolar automáticamente al resto del DAG.
- No se ha validado científicamente la equivalencia entre todos los stages ni la reutilización por cada combinación de fuente estructural, recursos y parámetros.

La suite local verificable para esta base queda en `246 passed, 11 skipped` en
backend (los skips son escenarios PostgreSQL sin
`POSTGRES_TEST_DATABASE_URL`), `10 passed` en frontend y `astro check` sin
diagnósticos. Esto demuestra contratos y recuperación local; junto con el
smoke MN5 anterior demuestra el golden path de identidad, pero no sustituye
una comparación contra baseline científico ni la aceptación del DAG completo.

## Requisitos funcionales

### Imprescindible

- **EJE-001 — Preparación desde configuración.** Implementado localmente: el worker lee una `RunConfig` persistida y no reconstruye la intención desde el frontend.
- **EJE-002 — Preflight.** Implementado localmente: antes de enviar, valida identidad, inputs, accession, estructura/fuente, stages, dependencias, recursos y prerrequisitos externos de los stages seleccionados.
- **EJE-003 — Prefetch selectivo.** Implementado localmente para SSH/native: sólo prepara cachés externas que la etapa necesita y bloquea el submit si falla un prerrequisito obligatorio. La invocación real del alias queda pendiente de validación en MN5.
- **EJE-004 — Ejecución por perfil.** El sistema MUST distinguir local VPN/SSH, MN5 native y offline/mock, sin enviar secretos al navegador ni tratar el mock como ciencia real.
- **EJE-005 — CLI real.** Demostrado para `protein_identity`: la orden persistida usó el CLI desplegado, namespace FASTA aislado, `--accession P22309`, stage, límites de paralelismo/CPU y `--fail-fast`; el log confirmó `pdb=None` y la secuencia esperada.
- **EJE-006 — Submit idempotente.** Implementado en la frontera local y ejercitado con un `job_id` real persistido y reconciliado hasta `COMPLETED`; el escenario real de perder la respuesta de `sbatch` todavía sólo tiene cobertura local.
- **EJE-007 — Reuso previo.** Implementado localmente: antes de `sbatch`, evalúa hits válidos de la matriz de caché y marca el `RunStage` `reused` sin crear un job científico para ese stage.
- **EJE-008 — Estados durables.** Implementado localmente: persiste preparación, espera de recursos, ejecución, reuso, success, fallo, omisión y cancelación sin confundir `ready` con un resultado científico.
- **EJE-009 — Manifest verificable.** Demostrado para `protein_identity`: el worker rechazó la publicación implícita y sólo creó `StageResult` después de manifest final, provenance anidado, hashes/tamaños, identidad canónica, 13 artefactos y 533 filas de anotación válidas.

### Necesario para cerrar la entrega

- **EJE-010 — Recuperación.** Implementado localmente para reinicio, leases, claims y pérdida temporal de transporte; el smoke real reconcilió polling y publicación de un `job_id` aceptado, pero no simuló una caída durante ese job.
- **EJE-011 — Separación de artefactos.** Demostrado para el root real: los artefactos permanecieron fuera de PostgreSQL y FastAPI sirvió el TSV mediante el endpoint autorizado con tamaño/hash verificables.
- **EJE-012 — Provenance completa.** El smoke validó el bloque operativo MN5, clave remota, clave local alias, secuencias query/reference, dependencias, parámetros y recurso/código remoto para `protein_identity`; la cobertura de modelos/recursos del DAG completo sigue pendiente.
- **EJE-013 — Golden path.** Cumplido para `protein_identity`: la run real llegó desde creación y transferencia hasta Slurm, manifest, provenance, PostgreSQL y 533 anotaciones verificadas por API. Esto no declara integrados los demás stages.
- **EJE-014 — Expansión controlada.** La incorporación de cada stage posterior MUST exigir su propio contrato, baseline, manifest y evidencia; el registro de 18 IDs por sí solo no es aceptación.

### Posterior, sin bloquear la primera corrida

- **EJE-015 — Optimización de prefetch.** Reutilizar cachés externas compartidas por proteína y versión podrá reducir tiempo, sin relajar el `cache_key` de resultados.
- **EJE-016 — Schedulers auxiliares.** Cualquier mejora de capacidad debe usar el worker y Slurm existentes; no se crea otro sistema de colas para esta entrega.

## Casos límite

- VPN caída antes del submit: la run queda pendiente de preparación o falla con error operativo; no se crea un job parcial.
- SSH autenticado pero host key no válida, secreto ausente o root remoto fuera de alcance: se rechaza el camino de ejecución sin revelar detalles sensibles.
- Upload truncado o hash distinto: no se transfiere ni se ejecuta.
- Falta accession para el CLI remoto: se detiene antes de `sbatch` y se pide completar/resolver la identidad.
- Falta MSA `af3-msa-v1` para AF3/ensemble: no se envía el stage dependiente; un stage independiente puede continuar si el DAG lo permite.
- Dos runs calculan la misma etapa a la vez: sólo una publicación gana la clave; la otra revalida el resultado y puede marcarse `reused`, sin borrar una publicación válida.
- Un resultado existente perdió un artefacto o no coincide su hash: es miss, se conserva la run independiente y se republica sólo si el preflight lo permite.
- Slurm acepta el job y se pierde la conexión: el worker consulta/reconcilia por el identificador persistido; no lo vuelve a enviar ciegamente.
- El manifest declara un path absoluto no autorizado, una columna inválida o un `aa_ref` incompatible: se rechaza publicación y no se marca `success`.
- Cancelación mientras un job está en Slurm: se solicita cancelación autorizada y se conserva la trazabilidad; un worker obsoleto no puede revivir la run.

## Criterios de aceptación

- Una run correctamente configurada llega al pipeline real en MN5 por un perfil autorizado y se obtiene un `job_id` persistido.
- La prueba local demuestra que el preflight no envía `sbatch` cuando falta una caché externa obligatoria o un input incompatible.
- La prueba de recuperación tras perder la respuesta de submit reconcilia el job existente y no crea un segundo job.
- El golden path de `protein_identity` publica un manifest real, provenance, artefactos y anotaciones verificables en PostgreSQL y los expone por FastAPI. **Demostrado:** 47310214, 13 artefactos y 533 filas.
- Una segunda run de la misma proteína reutiliza sólo los stages cuyo hit satisface la matriz científica; los demás se envían con su propia asociación. **Demostrado para `protein_identity`:** `f0acc8f7…` quedó `reused`, sin `slurm_job_id` nuevo y con integridad verificada.
- Un artefacto alterado, ausente o un manifest inválido producen miss/fallo auditable, nunca `success` parcial.
- La desconexión VPN/SSH no marca como fallido un job Slurm ya aceptado sin reconciliación.
- La evidencia distingue pruebas mock/locales de una ejecución autorizada en MN5. No se declara integración end-to-end únicamente porque pasen tests unitarios.

## Trabajo pendiente

1. Validar el alias de prefetch, módulos, capacidades técnicas, cuotas y la compatibilidad exacta del command builder contra el checkout autorizado de MN5 para cada stage que lo necesite.
2. Probar en staging autorizado reinicio del worker durante un job real, timeout de submit, pérdida VPN/SSH, fallo de Slurm, manifest corrupto y cancelación con un job real.
3. Registrar baseline científico y aprobación independiente antes de anunciar que un stage produce resultados confiables.
4. Validar uno a uno los 17 stages restantes, comenzando por dependencias de identidad y evidencia, y luego por estructura/ensemble/variantes; cada uno necesita su manifest, provenance, baseline y política de reuso.

## Fuera de alcance

- Ejecutar el DAG científico completo y declararlo producción durante esta entrega.
- Exponer VPN, SSH, Slurm, GPFS, prefetch o un navegador de archivos al usuario.
- Desplegar microservicios, Kubernetes o una cola nueva.
- Implementar adaptadores científicos ficticios para simular los 18 stages.
- Cambiar algoritmos, herramientas, reglas científicas o la semántica de AF3.
- Sustituir SSE/polling por WebSockets.
- Hacer del inspector read-only un camino de ejecución o un endpoint público.
