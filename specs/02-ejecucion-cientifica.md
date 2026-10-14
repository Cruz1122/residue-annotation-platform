# 02 — Ejecución científica en MareNostrum 5

**Estado:** especificación funcional objetivo. El checkout actual tiene la frontera de worker/HPC y contratos de manifest, pero la ejecución científica end-to-end permanece pendiente de evidencia autorizada.

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

### Construcción y envío del job

- El comando se construye desde `RunConfig`, no desde el estado del navegador ni de variables efímeras.
- Se utiliza la CLI real de `main.py` observada en el pipeline remoto; no se inventan flags ni nombres de stage.
- La solicitud conserva accession, inputs materializados, fuente AF3/PDB, variants, stages, dependencias, recursos, directorios, logs y correlación con `run_id`.
- El worker usa `sbatch` sólo después de que inputs, prefetch, recursos y configuración hayan pasado sus gates.
- El identificador Slurm se persiste inmediatamente y se puede recuperar si la respuesta de submit se pierde, evitando un doble submit.
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
- La auditoría registra que no se ejecutaron jobs, `sbatch`, `scancel` ni escrituras en MN5/GPFS durante la revisión: [`AUDIT_REPORT.md`](../AUDIT_REPORT.md).

## Estado actual

### Implementado o parcialmente implementado

- Existe un worker separado con estados, claims PostgreSQL, leases, heartbeat, cancelación y recuperación de etapas colgadas.
- Existen perfiles offline, SSH y native, transferencia confinada de inputs y validación local de manifests.
- La frontera remota puede recuperar un `job_id` tras pérdida de respuesta y evita doble submit en ese camino.
- El executor remoto ingesta manifests y tiene lookup de `StageResult` reusable por `(protein_id, stage_id, cache_key)` con comprobación de artefactos.
- El registry local contiene 18 stages, dependencias, recursos y gates técnicos; el inventario remoto se revisó de forma read-only.

### Pendiente o no demostrado

- [`backend/app/features/runs/worker_service.py`](../backend/app/features/runs/worker_service.py) no contiene adapters científicos locales: el executor offline falla de forma auditable en vez de inventar éxito.
- La configuración actual de run no conserva todos los parámetros necesarios para construir el comando real ni para calcular una clave completa antes de submit.
- El camino remoto construye una orden desde el accession y stages, pero el checkout local no contiene `main.py` científico; su compatibilidad sólo puede validarse contra el checkout remoto autorizado.
- El prefetch aparece en la documentación del pipeline, pero no existe un gate integrado que impida `sbatch` cuando faltan cachés externas necesarias.
- La ejecución real del golden path `run → worker → VPN/SSH/native → Slurm → manifest → PostgreSQL → API` no está demostrada. La auditoría la deja como gate pendiente.
- No se ha validado científicamente la equivalencia entre todos los stages ni la reutilización por cada combinación de fuente estructural, recursos y parámetros.

## Requisitos funcionales

### Imprescindible

- **EJE-001 — Preparación desde configuración.** El worker MUST leer una `RunConfig` persistida y no reconstruir la intención desde el frontend.
- **EJE-002 — Preflight.** Antes de enviar, MUST validar identidad, inputs, accession, estructura/fuente, stages, dependencias, recursos y prerrequisitos externos de los stages seleccionados.
- **EJE-003 — Prefetch selectivo.** En modo local, MUST preparar sólo cachés externas que los stages seleccionados necesitan y MUST impedir el submit si un prerrequisito obligatorio falla.
- **EJE-004 — Ejecución por perfil.** El sistema MUST distinguir local VPN/SSH, MN5 native y offline/mock, sin enviar secretos al navegador ni tratar el mock como ciencia real.
- **EJE-005 — CLI real.** El job MUST invocar la CLI y los stages reales del pipeline aprobado, con inputs, variantes, fuente estructural, recursos y directorios derivados de la configuración persistida.
- **EJE-006 — Submit idempotente.** El worker MUST persistir y reconciliar el identificador Slurm antes de reintentar un submit, evitando doble submit tras timeout, caída o reinicio.
- **EJE-007 — Reuso previo.** Antes de `sbatch`, MUST evaluar hits válidos de la matriz de caché y marcar el `RunStage` `reused` sin crear un job científico para ese stage.
- **EJE-008 — Estados durables.** MUST persistir preparación, espera de recursos, ejecución, reuso, success, fallo, omisión y cancelación sin confundir `ready` con un resultado científico.
- **EJE-009 — Manifest verificable.** MUST publicar sólo resultados con manifest final, provenance, hashes/tamaños, identidad canónica y anotaciones válidas.

### Necesario para cerrar la entrega

- **EJE-010 — Recuperación.** Tras reinicio o pérdida temporal de conectividad, MUST reconciliar jobs aceptados, renovar claims/leases y continuar o fallar de manera auditable sin duplicar cálculos.
- **EJE-011 — Separación de artefactos.** MUST mantener artefactos pesados fuera de PostgreSQL cuando el contrato de almacenamiento lo requiera y servirlos sólo mediante FastAPI autorizado.
- **EJE-012 — Provenance completa.** Cada stage publicado o reutilizado MUST conservar versiones de código/modelo/recursos, inputs, upstream keys, `cache_key` y correlación con la run.
- **EJE-013 — Golden path.** MUST existir una prueba autorizada y reproducible de `protein_identity` desde la creación de la run hasta la API, antes de declarar integrados los demás stages.
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
- El golden path de `protein_identity` publica un manifest real, provenance, artefactos y anotaciones verificables en PostgreSQL y los expone por FastAPI.
- Una segunda run de la misma proteína reutiliza sólo los stages cuyo hit satisface la matriz científica; los demás se envían con su propia asociación.
- Un artefacto alterado, ausente o un manifest inválido producen miss/fallo auditable, nunca `success` parcial.
- La desconexión VPN/SSH no marca como fallido un job Slurm ya aceptado sin reconciliación.
- La evidencia distingue pruebas mock/locales de una ejecución autorizada en MN5. No se declara integración end-to-end únicamente porque pasen tests unitarios.

## Trabajo pendiente

1. Completar `RunConfig` y el cálculo de selección/cache antes de que el worker reclame un stage.
2. Implementar el preflight que resuelva accession, inputs, recursos, fuente estructural y cachés necesarias por stage.
3. Integrar el prefetch real y su resultado durable en los modos local y native, respetando la frontera read-only del inspector.
4. Reconciliar el command builder con la `main.py` y el registry del checkout MN5 autorizado.
5. Hacer que el lookup de `StageResult` ocurra antes de submit y que las carreras de publicación sean transaccionales.
6. Ejecutar, con autorización, el golden path de `protein_identity` y conservar logs, manifests, hashes y timings mínimos.
7. Validar el primer stage y después expandir uno a uno, comenzando por dependencias de identidad y evidencia, y luego por estructura/ensemble/variantes.
8. Probar reinicio del worker, timeout de submit, pérdida VPN/SSH, fallo de Slurm, manifest corrupto y cancelación.
9. Registrar baseline científico y aprobación independiente antes de anunciar que un stage produce resultados confiables.

## Fuera de alcance

- Ejecutar jobs reales durante esta reestructuración documental.
- Exponer VPN, SSH, Slurm, GPFS, prefetch o un navegador de archivos al usuario.
- Desplegar microservicios, Kubernetes o una cola nueva.
- Implementar adaptadores científicos ficticios para simular los 18 stages.
- Cambiar algoritmos, herramientas, reglas científicas o la semántica de AF3.
- Sustituir SSE/polling por WebSockets.
- Hacer del inspector read-only un camino de ejecución o un endpoint público.
