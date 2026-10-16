# 01 — Entrada y configuración

**Estado:** ENT-001–013 implementados en el plano local y cubiertos por pruebas; ENT-014–015 quedan posteriores. Este cierre no afirma ejecución científica end-to-end ni readiness productivo.

## Objetivo

Permitir que una persona autenticada proporcione una proteína, defina la intención científica de su análisis y confirme una ejecución reproducible.

Al terminar esta entrega, la plataforma debe conservar en PostgreSQL la configuración que el usuario confirmó: identidad de la proteína, referencias a los inputs, variantes, fuente estructural, stages aplicables y parámetros que puedan cambiar el resultado. Esa configuración es la fuente de verdad para preparar, ejecutar y consultar la run.

El flujo prioritario recibe FASTA, PDB o ambos. El soporte existente para otros formatos no se amplía ni se convierte en requisito de esta entrega.

## Experiencia del usuario

1. La persona inicia sesión.
2. Carga un FASTA, un PDB o ambos.
3. La plataforma valida los archivos y resuelve la secuencia canónica y, cuando sea necesario, un accession científico.
4. Puede seleccionar variantes; si no selecciona ninguna, los análisis dependientes de variantes quedan omitidos.
5. Elige entre generar una estructura con AlphaFold 3 o utilizar la estructura proporcionada.
6. La interfaz muestra un resumen comprensible de la configuración y del análisis que se ejecutará, sin obligarle a conocer los 18 IDs técnicos.
7. Confirma la solicitud.
8. La plataforma crea una run nueva y devuelve su identificador.
9. La misma configuración puede solicitarse de nuevo intencionalmente y debe producir otra run, sin sobrescribir la anterior.

## Comportamiento esperado

### Inputs e identidad

- FASTA, PDB y FASTA + PDB son las combinaciones prioritarias.
- El FASTA se normaliza sin cambiar su significado biológico y se identifica por su hash de secuencia normalizada.
- Si se proporciona estructura, se valida la cadena seleccionada, su correspondencia con la secuencia y la integridad del archivo.
- Si la ejecución remota requiere un accession UniProt, el sistema lo resuelve o detiene la confirmación con un error accionable. No se crea una run que sólo pueda fallar más tarde por carecer de identidad científica.
- Cuando hay FASTA y PDB, la compatibilidad se comprueba antes de confirmar: secuencia, cadena, posiciones y reglas de mapping deben ser coherentes.

### Variantes

- Las variantes son opcionales.
- Cada variante conserva posición canónica 1-based, `aa_ref` y `aa_alt`.
- `aa_ref` debe coincidir con la secuencia canónica en esa posición y las posiciones no se repiten.
- Los stages dependientes de variantes sólo se seleccionan cuando existe un conjunto de variantes válido.
- El conjunto normalizado de variantes forma parte de la intención persistida y, para stages que lo consumen, de la equivalencia de caché.

### Fuente estructural y selección de stages

- La elección `alphafold3` frente a `provided_pdb` llega al backend y queda persistida; no puede depender de `localStorage` ni de estado temporal del navegador.
- Omitir AF3 no significa omitir todos los análisis estructurales. La selección se resuelve con la estructura proporcionada y el DAG real; los stages sin precondiciones satisfechas se omiten o bloquean explícitamente.
- La selección se deriva del registro científico real, de las dependencias declaradas, de los inputs disponibles, de las variantes y de los prerrequisitos. No se crea un DAG paralelo para la UI.
- La interfaz puede mostrar categorías legibles, pero el backend conserva los IDs y dependencias efectivos.

### Runs nuevas, reintentos y resultados reutilizables

Una solicitud explícita de nueva ejecución y un reintento técnico de la misma petición son casos distintos:

- Una nueva solicitud siempre crea un `run_id` distinto, una configuración propia, historial propio, estado propio y asociaciones `RunStage` propias.
- Un reintento HTTP con la misma clave de idempotencia, o una repetición causada por pérdida de respuesta, debe resolver la run ya creada y no crear otra por accidente.
- La entidad `Protein` puede deduplicarse por identidad biológica. La deduplicación de la proteína nunca debe deduplicar la run.
- Un `StageResult` publicado puede asociarse a más de una run del mismo ámbito de autorización cuando la equivalencia científica está demostrada. El reuso no convierte dos runs en una sola.
- La identidad de Protein se comparte globalmente por hash de secuencia normalizada; cada proyecto que la registra puede usarla. Los aliases iguales se deduplican en esa identidad compartida.
- Las cachés científicas de MN5 pueden reutilizar stages entre solicitudes/proyectos sólo cuando la clave científica, provenance y recursos coincidan. La plataforma mantiene los `StageResult` y artefactos publicados dentro del ámbito owner/project de cada run; un hit remoto no autoriza leer artefactos privados de otro proyecto.
- El límite actual de una run no terminal por usuario es una política de concurrencia, no una regla de unicidad de proteína ni un mecanismo de deduplicación. Debe mantenerse separado de la semántica de runs independientes hasta que el equipo decida si permite solicitudes concurrentes.

### Política de reuso por stage

La posibilidad de reutilizar no se decide sólo porque dos solicitudes nombren la misma proteína. El hit requiere, como mínimo, un `stage_id` y una `cache_key` científica idénticos, un resultado `success`, todos los artefactos requeridos presentes e íntegros y autorización para que la nueva run pueda verlos. En MN5, un hit de caché de ejecución puede ahorrar el cálculo entre proyectos; el resultado que se ingresa en la plataforma para la nueva run permanece dentro del ámbito owner/project de esa run.

La clave debe incluir todos los factores que puedan cambiar el resultado: versión y código del stage, identidad de recursos y modelos, parámetros científicos normalizados, hashes de secuencia query/reference cuando apliquen y las claves de los resultados upstream. El logging, el formato de logs y otros controles no científicos no deben invalidar una equivalencia.

| Grupo de reuso candidato | Stages del registro | Se puede reutilizar cuando… | No se reutiliza cuando… |
| --- | --- | --- | --- |
| Identidad, secuencia y evidencia sobre la proteína | `protein_identity`, `sequence_frustration`, `variant_predictors`, `pharmacogenomics` | Coinciden la identidad/secuencia normalizada, el upstream, la versión de código, los recursos y los parámetros científicos. `variant_predictors` y `pharmacogenomics` sólo se comparten si sus recursos de mapping y evidencia son los mismos. | Cambia la secuencia, la resolución de identidad, el mapping, los recursos/versiones o cualquier parámetro científico relevante. |
| Evidencia externa proyectada | `uniprot_features`, `evolutionary_conservation`, `functional_region_evidence`, `experimental_variant_evidence`, `membrane_topology` | Coinciden `protein_identity`, sus claves upstream y el snapshot/versionado de UniProt, InterPro, homología, MaveDB o TMbed que el stage utiliza. | Cambia la evidencia externa, la caché aprobada, la versión de herramienta o el mapping; no basta con que el accession sea igual. |
| Estructura y ensemble | `structure_modeling`, `conformational_ensemble`, `ensemble_frustration` | Para AF3: misma secuencia, versión/modelo, parámetros y entrada MSA (`af3-msa-v1`) cuando aplique. Para PDB: mismo hash de contenido, cadena, mapping y configuración. Los stages derivados deben coincidir además con las claves exactas de sus upstream. | Se cambia AF3 por PDB o viceversa, cambia el archivo/modelo/MSA, la cadena, el mapping, el ensemble o cualquier versión/parámetro científico. |
| Estructura derivada | `structural_regime`, `protein_relaxation_energy`, `physicochemical_context`, `structural_frustration`, `structural_contacts` | Coinciden la estructura y el resultado upstream exactos, las reglas, el modo de energía (`auto`, `foldx`, `rosetta` o `both` cuando aplique), versiones, recursos y parámetros. | Cambia la estructura de referencia, el modo de relajación/energía, una regla de régimen, la herramienta o una clave upstream. |
| Evaluación de variantes | `variant_ddg` | Coinciden exactamente el conjunto normalizado de variantes, `protein_identity`, la topología, la estructura de referencia seleccionada y las versiones/recursos del cálculo. | Falta el conjunto de variantes, cambia cualquier posición/ref/alt, cambia la estructura o cambia el runtime científico. |

Esta matriz identifica reutilización científicamente plausible a partir del registro real; no autoriza hits aproximados. Si un manifest no demuestra un factor relevante, el resultado debe tratarse como miss hasta ampliar el contrato de provenance/cache. Un resultado parcial, fallido, omitido, corrupto, expirado o sin artefactos verificables nunca es un hit.

## Contratos esenciales

### Configuración persistida

La run debe conservar, como mínimo:

- identidad de la proteína y su hash de secuencia normalizada;
- referencias a FASTA/PDB, hashes, cadena y mapping;
- fuente estructural seleccionada (`alphafold3` o `provided_pdb`);
- variantes normalizadas;
- stages aplicables, stages omitidos y razón de omisión;
- parámetros científicos y prerrequisitos usados para la selección;
- versiones de código, recursos, modelos y contrato necesarias para reproducibilidad;
- propietario, proyecto, timestamps y una referencia de auditoría a la confirmación.

Los resultados compartidos se indexan como `StageResult` independiente de la run. Cada run conserva su `RunStage`, su estado y su asociación al resultado reutilizado o recién publicado.

### Estados y relaciones mínimas

- `Run`: solicitud del usuario y estado global.
- `RunStage`: una instancia de cada stage aplicable dentro de una run.
- `StageResult`: output científico reusable identificado por proteína, stage y `cache_key`, persistido por ámbito de proyecto para conservar la privacidad de artefactos.
- `Artifact`: bytes o referencias de output con tamaño, hash, tipo y provenance.
- Estado `reused`: el `RunStage` queda terminado y enlaza un `StageResult` válido; no representa una ejecución nueva del cálculo.

La autorización se comprueba antes de vincular o servir un resultado. Compartir una proteína no implica que un proyecto pueda leer artefactos privados de otro.

### Evidencia técnica usada

- El registro local contiene 18 `StageDefinition`, dependencias, artefactos consumidos y parámetros de caché: [`backend/app/features/stages/registry.py`](../backend/app/features/stages/registry.py).
- La clave canónica contempla `stage_id`, versión/código, secuencias, dependencias, recursos y parámetros científicos: [`backend/app/features/runs/cache.py`](../backend/app/features/runs/cache.py).
- La persistencia impone unicidad por `(protein_id, stage_id, cache_key, project_id)` y permite que `RunStage` apunte a un `StageResult` propio del ámbito autorizado: [`backend/app/features/runs/models.py`](../backend/app/features/runs/models.py).
- El contrato de manifest exige clave, provenance e integridad antes de publicar: [`specs-archive/2026-10-14/contracts/hpc-manifest-cache.md`](../docs/specs-archive/2026-10-14/contracts/hpc-manifest-cache.md).

## Estado actual

### Implementado o reutilizable

- La autenticación, ownership, normalización de proteína y deduplicación de la entidad biológica tienen cobertura local.
- `RunCreate` valida proteína, variantes, posiciones, uploads, FASTA/PDB, mapping estructural, accession y parámetros; el registro crea 18 `RunStage`.
- La base actual separa `Run`, `RunStage`, `StageResult` y `Artifact`; el estado `reused` existe.
- `RunConfiguration` conserva identidad, referencias/hash de inputs, fuente estructural, mapping, variantes, stages seleccionados/omitidos, prerrequisitos, parámetros, versiones, ownership y auditoría de confirmación.
- La selección se deriva de `STAGE_DEFINITIONS`; omisiones como AF3 no seleccionado o stages dependientes de variantes quedan explicadas en configuración y `RunStage`.
- El executor remoto y el worker pueden buscar un resultado `success` con la misma clave; el pre-submit exige provenance de clave/factores, autorización por propietario/proyecto y tamaño/SHA-256 íntegros en todos los artefactos.
- El onboarding envía la fuente estructural al backend y usa `Idempotency-Key`; la fuente efectiva se lee siempre de `RunConfiguration`.
- La API devuelve la configuración completa y ofrece historial de runs sin colapsar solicitudes independientes.
- La política actual de slots permite crear otra run después de que la anterior sea terminal, pero rechaza una segunda run mientras el slot del usuario siga activo.

### Verificación pendiente, sin bloquear Spec 1

- La auditoría global sigue siendo válida como evidencia histórica de que este checkout no demostró ejecución científica end-to-end de los 18 stages: [`AUDIT_REPORT.md`](../AUDIT_REPORT.md). Ejecutar ciencia, enviar Slurm y validar MN5 no forman parte de esta Spec 1.
- La cobertura de concurrencia específica de PostgreSQL y la conexión real a HPC requieren sus entornos autorizados; la suite local cubre la política, idempotencia y límites sin abrir VPN/SSH/Slurm.
- ENT-014 (comparación de configuraciones) y ENT-015 (reuso de cachés externas) permanecen explícitamente posteriores.

## Requisitos funcionales

### Imprescindible

- **ENT-001 — Autenticación y ownership.** El sistema MUST exigir una identidad autorizada antes de aceptar inputs o crear una run, y MUST impedir que otro proyecto lea o reutilice artefactos sin permiso.
- **ENT-002 — Ingesta prioritaria.** El sistema MUST aceptar FASTA, PDB o FASTA + PDB, validar tamaño, formato, integridad y ownership, y rechazar combinaciones incompatibles antes de confirmar.
- **ENT-003 — Identidad reproducible.** El sistema MUST normalizar la secuencia, conservar el hash y resolver la identidad científica requerida por el pipeline. Una secuencia idéntica puede resolver al mismo `protein_id`, pero no al mismo `run_id`.
- **ENT-004 — Variantes canónicas.** El sistema MUST validar posición, `aa_ref`, `aa_alt` y duplicados; MUST persistir el conjunto normalizado y MUST omitir stages dependientes cuando no hay variantes.
- **ENT-005 — Fuente estructural.** El sistema MUST persistir la elección AF3/PDB, el hash de la estructura proporcionada y el mapping usado. No puede inferir esa decisión desde el navegador al ejecutar.
- **ENT-006 — Selección basada en el registro.** El sistema MUST calcular stages aplicables y dependencias a partir del registro real, inputs, variantes y prerrequisitos, y MUST persistir tanto la selección como las omisiones explicadas.
- **ENT-007 — Runs independientes.** Dos confirmaciones explícitas de la misma proteína, incluso con parámetros idénticos, MUST producir dos `run_id` y dos historiales. La unicidad de `StageResult` sólo puede deduplicar outputs científicos equivalentes, nunca solicitudes.
- **ENT-008 — Reintento técnico.** El endpoint MUST aceptar una clave de idempotencia o mecanismo equivalente para que una repetición técnica de la misma petición devuelva la run original. La ausencia de respuesta HTTP no puede producir duplicados accidentales.
- **ENT-009 — Equivalencia de caché.** El sistema MUST reutilizar sólo un `StageResult` `success` cuya clave incluya todos los factores científicos aplicables y cuyos artefactos hayan pasado la verificación de integridad y autorización.

### Necesario para cerrar la entrega

- **ENT-010 — Lectura de intención.** La API MUST devolver a la persona toda la configuración confirmada, no sólo variantes y uploads.
- **ENT-011 — Separación de política de concurrencia.** Un conflicto por una run no terminal MUST informar que es una política de concurrencia; nunca debe presentarse como “proteína duplicada”. La decisión de permitir múltiples runs simultáneas se documentará por separado y no cambiará la regla de identidad.
- **ENT-012 — Preselección explicable.** Antes de enviar a ejecución, el sistema MUST poder explicar qué stages se ejecutarán, cuáles se omitirán, cuáles se reutilizarán y qué prerrequisito impide cada stage no aplicable.
- **ENT-013 — Provenance de reutilización.** Cada hit MUST conservar la `cache_key`, el `stage_result_id` origen y la razón/factores de equivalencia visibles para auditoría.

### Posterior, sin bloquear el recorrido principal

- **ENT-014 — Comparación de configuraciones.** El historial podrá comparar dos configuraciones de la misma proteína sin mezclarlas.
- **ENT-015 — Reuso de cachés externas.** La preparación de cachés externas compartidas podrá optimizar tiempo, siempre que no sustituya la equivalencia de `StageResult`.

## Casos límite

- Dos FASTA con headers distintos pero la misma secuencia normalizada reutilizan la entidad `Protein`; dos confirmaciones crean dos runs.
- Una nueva run cambia AF3 por un PDB con el mismo largo: no reutiliza `structure_modeling` salvo que el contrato demuestre identidad de fuente, contenido, mapping y parámetros; igualdad de secuencia no basta.
- Un PDB con un byte cambiado, otra cadena o mapping diferente invalida los stages estructurales derivados.
- Cambiar una sola variante invalida `variant_ddg`, aunque los predictores generales de la proteína pudieran seguir siendo reutilizables si su propia clave no depende del conjunto solicitado.
- Un stage externo conserva una caché antigua o de versión desconocida: se prefiere miss a equivalencia no demostrada.
- Falta de accession, secuencia incompatible, `aa_ref` incorrecto, archivo truncado o upload perteneciente a otro proyecto: la run no se confirma.
- La misma petición llega dos veces por timeout: la clave de idempotencia devuelve la primera run; una nueva confirmación explícita fuera de esa petición crea otra.
- Una run anterior está activa y el usuario solicita otra: se aplica la política de slot vigente y se informa el conflicto sin colapsar las runs por proteína.

## Criterios de aceptación

- Una persona autenticada puede cargar FASTA, PDB o ambos, validar la identidad y recuperar por API la configuración completa confirmada.
- La elección AF3/PDB persiste en backend y sigue presente aunque se cierre o recargue el navegador.
- Variantes válidas e inválidas producen, respectivamente, stages dependientes seleccionados u omitidos con razón explícita.
- El listado de stages y dependencias de la run coincide con `STAGE_DEFINITIONS`; no se muestra una selección inventada por el frontend.
- Dos confirmaciones idénticas realizadas como solicitudes independientes producen `run_id`, historial, estado y `RunStage` distintos. Una sola petición repetida técnicamente no produce una segunda run.
- Para una segunda run, sólo se marca `reused` cada stage cuyo `cache_key`, provenance, autorización y artefactos íntegros coincidan. Un miss ejecuta el stage; no se aceptan hits por proteína sola.
- Un cambio de AF3 a PDB, de variante, de versión de stage, de recurso, de parámetro científico o de estructura invalida el reuso afectado.
- Una prueba de autorización demuestra que un usuario/proyecto no puede reutilizar ni descargar un `StageResult` o artefacto privado fuera de su ámbito, aunque la identidad Protein sea compartida.

## Trabajo pendiente

1. Ejecutar las pruebas autorizadas de concurrencia PostgreSQL y la integración HPC/MN5 cuando estén disponibles esos entornos.
2. Implementar ENT-014 para comparar snapshots sin mezclar historiales.
3. Implementar ENT-015 para optimizar cachés externas sin sustituir la equivalencia de `StageResult`.

## Fuera de alcance

- Ejecutar stages científicos, enviar Slurm o cambiar algoritmos del pipeline.
- Añadir nuevos stages, modos del visor, microservicios o un sistema de colas alternativo.
- Convertir mmCIF u otros formatos adicionales en requisito prioritario.
- Exponer GPFS, SSH, Slurm o un explorador de archivos al usuario.
- Permitir reutilización aproximada por accession, longitud, nombre de archivo o igualdad parcial de parámetros.
- Eliminar la entidad `Protein` compartida o copiar físicamente artefactos para cada run.
