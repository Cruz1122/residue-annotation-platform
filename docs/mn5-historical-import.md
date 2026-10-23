# Importación histórica MN5 de APOE/P02649

**Fecha de validación:** 2026-10-18/19
**Cuenta de destino:** `jccpyt@gmail.com`
**Estado:** importación completada en PostgreSQL; contratos, integridad, API y
  vistas principales validados.
**Naturaleza:** publicación histórica de resultados ya ejecutados; no vuelve a
  ejecutar Slurm ni afirma una nueva ejecución científica.

Este documento describe cómo se proyectó la corrida real de MN5 al modelo
durable de la plataforma. La inspección de MN5 se realizó mediante el límite
read-only documentado en `docs/mn5-current-state.md`: no se abrió shell remoto,
no se enviaron jobs y no se modificó el filesystem de MN5.

## Resultado publicado

La importación quedó asociada al usuario y proyecto de la cuenta indicada:

| Elemento | Valor verificado |
| --- | --- |
| Usuario | `jccpyt@gmail.com` |
| Secuencia científica | `P02649` / `APOE` / Homo sapiens |
| Longitud | 317 residuos |
| SHA-256 de secuencia | `eddd8b84fbb094df0b4067ca1d0b9b137ddaee4f8b3a548fcff5152e92a4dd4b` |
| Proteína local deduplicada | `aea47aa4-be96-439a-b651-5cb22c0594b4` |
| Corridas importadas | 4: una CPU completa y tres corridas DDG |
| Estados finales | `success` en las cuatro corridas |
| Filas por stage | 317, con cobertura de posiciones 1..317 |

La proteína ya existía en la base local con el mismo contenido canónico. Por
eso se reutilizó por SHA-256 y se añadió el acceso al proyecto de la cuenta,
sin cambiar el propietario preexistente ni borrar datos de otra cuenta. Había
un alias histórico `uniprot:P02649` en otra proteína de 299 residuos; se
conservó intacto y no se reutilizó para evitar una asociación científica
incorrecta. El encabezado FASTA `sp|P02649|APOE_HUMAN` de la proteína de 317
residuos sí se conservó como identidad válida.

## Mapeo de corridas y contratos

El registro remoto observado contiene 19 definiciones: 18 etapas CPU de la
corrida base, más `variant_ddg` como etapa opcional. La importación conserva
esa topología en `RunStage`, incluyendo etapas no aplicables como `skipped`, y
no inventa una etapa ejecutada que no aparece en el contexto remoto.

### Corrida CPU completa

| Campo | MN5 | Plataforma |
| --- | --- | --- |
| Job padre | `47442432` | `Run.remote_job_id` |
| Run remoto | `P02649_eddd8b84fbb0_20261018T210041779016Z` | `RunConfiguration.scientific_parameters.remote_run_id` |
| Resultado | 18 stages `success` | 18 `RunStage.success` |
| `variant_ddg` | No forma parte de esta corrida | `RunStage.skipped`, razón `separate_variant_ddg_run` |
| Exportación final | 317 x 66 | artefacto de corrida `final_annotations` |
| Selección de campaña | 3 variantes | artefacto de corrida `selected_variants` |

Los 18 stages son `protein_identity`, `clinvar`, `variant_predictors`,
`pharmacogenomics`, `sequence_frustration`, `uniprot_features`,
`evolutionary_conservation`, `functional_region_evidence`,
`experimental_variant_evidence`, `membrane_topology`, `structure_modeling`,
`conformational_ensemble`, `structural_regime`, `ensemble_frustration`,
`protein_relaxation_energy`, `physicochemical_context`,
`structural_frustration` y `structural_contacts`.

El contrato de ClinVar se alineó con el remoto: SNV germinal en GRCh38,
dependencia de `protein_identity`, requerimiento de `gene`, cinco familias de
artefactos y las seis columnas de resumen (`clinvar_n_variants`,
`clinvar_n_pathogenic_or_likely`, `clinvar_n_benign_or_likely`,
`clinvar_n_vus`, `clinvar_n_conflicting`, `clinvar_status`). La importación
preserva las clasificaciones publicadas; no convierte una clasificación
ClinVar en una conclusión patogénica nueva a nivel de residuo.

### Corridas DDG

Las tres corridas publicadas se conservaron como corridas independientes para
que la interfaz pueda abrir cada variante y descargar su tabla final:

| Variante | Job MN5 | Run remoto | Cache key DDG | Exportación |
| --- | ---: | --- | --- | --- |
| R43C | `47512680` | `P02649_eddd8b84fbb0_20261018T234300711349Z` | `b2c48d3b907ecbfdf51de04599f4e2fc0e40546f5199212edfc022ad42c79b47` | 317 x 24 |
| R154S | `47512681` | `P02649_eddd8b84fbb0_20261018T235626909555Z` | `6a554c02896e991d987a6384b6b46d4e8986930339ae47cc74f0e293fc18fad3` | 317 x 24 |
| E21K | `47512682` | `P02649_eddd8b84fbb0_20261018T235627979465Z` | `f0d18906d260b7fed18df3301bc5738ca978dc64399838c56d16891148c3979a` | 317 x 24 |

Cada contexto remoto contiene exactamente siete stages: las seis etapas
compartidas necesarias (`protein_identity`, `uniprot_features`,
`membrane_topology`, `structure_modeling`, `structural_regime` y
`protein_relaxation_energy`) y `variant_ddg`. En la base, los seis resultados
compartidos apuntan al mismo `StageResult`/cache key de la corrida CPU y se
presentan como `reused`; sólo `variant_ddg` se publica como resultado propio
de cada job. Las demás etapas aparecen como `skipped` con razón
`not_in_historical_variant_run`.

Los valores DDG se mantienen en REU. La configuración persistida aclara que
son diferencias de score de Rosetta, no kcal/mol y no una afirmación de
patogenicidad. La variante, posición, residuo de referencia, residuo alterno,
`variation_id`, `clnsig`, `clnrevstat` y condición se validan contra la
secuencia y contra `selected_variants.tsv` antes de insertar.

El contrato remoto de `variant_ddg` no declara una capacidad de launcher
adicional, pero el registro local mantiene el gate operativo
`slurm:SLURM_JOB_ID` + `command:srun` porque el entrypoint Rosetta registrado
se ejecuta dentro de un step Slurm. Esto evita que una corrida nueva desde la
interfaz se presente como ejecutable en un worker que no tenga ese entorno; no
altera la clasificación `success` de los resultados históricos ya publicados.

## Qué se persiste y qué se muestra

La proyección sigue el contrato normal de la aplicación:

```text
Run
├── RunConfiguration       entradas, selección, versiones y provenance
├── RunPreparation         prerrequisitos y snapshot histórico exitoso
├── RunStage[]             estado por stage, job, cache y motivo de omisión
│   └── StageResult         manifest, provenance, cache key y filas de anotación
│       └── Artifact[]      archivos publicados del stage
└── Artifact[]              exportaciones finales de la corrida
```

Cada `StageResult` importado conserva `source_job_id`, el run remoto,
`source_status=success`, la clave de caché remota y la evidencia de integridad.
Las rutas GPFS absolutas no se guardan como rutas utilizables por el cliente:
el provenance las representa como referencias `mn5://...`. Los artefactos se
copian a `ArtifactStore` con hash SHA-256, tamaño y tipo MIME, y se sirven por
la ruta autenticada de artefactos.

La exportación final de la corrida CPU se puede descargar desde el historial,
igual que `selected_variants.tsv`. Cada DDG ofrece su propia tabla final. Las
vistas de topología, frustración y DDG consumen las filas y artefactos reales;
no hay fixtures científicos ni tarjetas de resultado simuladas.

Las filas de anotación y toda la relación científica viven en PostgreSQL. Los
bytes de los archivos publicados siguen el contrato de almacenamiento de la
plataforma: se conservan en el `ArtifactStore` local/volumen persistente y
PostgreSQL guarda su propietario, relación, tamaño, MIME, clave y SHA-256.
Las descargas siempre pasan por la API autenticada y por la verificación de
integridad del descriptor.

## Integridad y límites de importación

Antes de insertar se verificaron, entre otras, estas invariantes:

- SHA-256 y longitud de la secuencia canónica.
- Existencia y estado `success` de cada manifest/provenance remoto.
- Correspondencia exacta entre cache keys esperadas y stage IDs.
- 317 filas por tabla de anotación y cobertura 1..317.
- Mapeo de estructura para las 317 posiciones.
- Variante DDG del contexto remoto contra la campaña y contra la secuencia.
- Hash y tamaño de las exportaciones finales.
- Integridad de cada archivo regular que se transfirió.

El adaptador aplica un límite deliberado de 2,000,000 bytes por artefacto
histórico. Se excluyen directorios, caches externas y archivos regulares que
superan ese límite; el caso observado es el árbol grande de
`structural_contacts/arpeggio_json`. La exclusión no se oculta: cada
`StageResult.provenance.import_validation` conserva `skipped_artifacts`, el
límite, el número de artefactos copiados y las filas importadas. La tabla final
de cada corrida y los archivos necesarios para las vistas sí quedaron
publicados.

La importación es idempotente por cuenta, proyecto y job remoto. Una segunda
invocación completa devuelve `already_imported` con los IDs existentes; una
importación parcial se detiene con error y no mezcla corridas ni crea nuevos
artefactos. La base impone además `uq_runs_owner_project_remote_job`, y la
copia de cada archivo se crea con `O_EXCL`: dos importadores concurrentes no
pueden sobrescribir el archivo del otro. Si PostgreSQL reporta la colisión, el
adaptador hace rollback, verifica el conjunto completo de jobs y reconcilia la
respuesta como `already_imported` sólo cuando los cuatro runs están presentes.
La migración `0013_import_invariants` también exige que cada `Artifact` tenga
exactamente un propietario (`run_id` o `stage_result_id`) y que los timestamps
persistidos no sean nulos.

## Estados y mensajes de UX

La interfaz separa el estado de la corrida del estado de cada stage y conserva
el detalle técnico para diagnóstico sin obligar al usuario a intervenir:

| Estado persistido | Presentación | Acción humana |
| --- | --- | --- |
| `pending` | Preparando / esperando al worker | Ninguna; refresco automático |
| `queued` sin job | Envío al ejecutor | Ninguna |
| `queued` con job | Esperando recursos de cómputo | Ninguna |
| `running` | En ejecución | Ninguna; consultar progreso |
| `success` | Completada; resultados disponibles | Explorar o descargar |
| `reused` | Resultado reutilizado | Explorar; no repetir cómputo |
| `skipped` | No aplica, con motivo legible | Ninguna |
| `failed` | Fallida con mensaje sanitizado | Revisar diagnóstico/reintentar según código |
| `cancel_requested` / `cancelled` | Cancelación en curso / cancelada | Esperar confirmación o iniciar otra corrida |

Un problema de VPN, SFTP o disponibilidad remota no se convierte en una
falla científica ni provoca un reenvío automático. Un manifest, hash, tamaño,
tabla o contrato inválido sí se marca como error determinista de validación.
En ambos casos el backend conserva `error_code`, `error_message`,
`preflight_*` y provenance para soporte, mientras el frontend muestra una
explicación corta y accionable.

## Validación de API y de interfaz

Se verificó la API autenticada con la cuenta de destino:

- El catálogo devuelve la proteína P02649 y las corridas históricas.
- Las cuatro corridas tienen 19 `RunStage` y el contrato de configuración
  correspondiente.
- La corrida base expone sus dos artefactos de nivel de corrida.
- Cada DDG expone su exportación final y la variante correspondiente.
- La descarga autenticada conserva el tamaño y SHA-256 registrados.

También se validó visualmente en el navegador del frontend local:

- El catálogo/historial muestra la cuenta, la proteína, las cuatro corridas,
  sus estados y los enlaces de exportación.
- Topología renderiza el modelo estructural real en Mol* y sus 317 posiciones.
- Frustración muestra la gráfica por residuo y la evidencia real del ensamble:
  `bioemu-v1.2`, 207 conformeros retenidos, 207 frames indexados, 1,250
  muestras brutas, 214 descartadas por QC y cinco rondas.
- DDG muestra la gráfica y el panel real de R43C: sustitución `R → C`,
  `2.9866 REU`, desviación entre réplicas y cinco réplicas.
- No quedaron estados de carga, alertas de error ni mapeos estructurales
  inválidos visibles después de cargar las páginas.

Para esa validación se creó únicamente una sesión efímera de desarrollo en el
navegador local mediante un token emitido por la CLI; no se cambiaron
credenciales ni datos de la base. La sesión se limpia al terminar la prueba.
