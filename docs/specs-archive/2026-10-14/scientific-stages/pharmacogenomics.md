# Contrato de migración científica — `pharmacogenomics`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿El residuo pertenece a un alelo estrella y con qué evidencia?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `pharmacogenomics` |
| ID histórico | `P14` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_identity`` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | 3 columnas `pgx_*` |

## Invariantes específicos

El score de evidencia de gen no debe presentarse como función demostrada de cada residuo.

Conservar `aa_position` 1-based, `aa_ref`, cobertura 1..L según contrato, NA ≠ cero, provenance, herramientas y unidades nativas.

## Gate de migración

- [x] Revisar stage real, versiones, dependencias, recursos, parámetros y esquemas en código.
- [ ] Crear baseline con entradas reales, hashes y artefactos del stage.
- [ ] Validar sintaxis, tests unitarios, fallos negativos y smoke real en el entorno permitido.
- [ ] Comparar outputs/NA/QC/unidades/coverage con baseline. No declarar equivalencia conceptual como equivalencia empírica.
- [ ] Integrar vía worker y manifest final; verificar no publicar success parcial ni reuso falso.
- [ ] Registrar evidencia de coste, tiempos, PASS/FAIL/NOT RUN y aprobador.

**Resultado actual:** `CODE REVIEWED` contra MN5; baseline, smoke, outputs, costes y equivalencia científica continúan `NOT RUN`.

## Revisión del código observado en MN5 (2026-10-10)

**Resultado de revisión:** `VERIFIED — CODE REVIEWED`; se inspeccionaron `contract.py`, `stage.py`, `config.py` y el código de soporte del stage en el checkout remoto. Esta evidencia confirma estructura, contrato y wiring; no confirma resultados científicos ni equivalencia empírica.

### Entry point y contrato actual

- `stages/pharmacogenomics/stage.py:run` llama a `ensure_residue_genomic_mapping`, materializa `run/orchestration/genomic_mapping/missense_substitutions.tsv` y después invoca `core.run_pharmacogenomics`.
- Dependencia: `protein_identity`; requiere `gene`. Produce `pgx_star_alleles`, `pgx_allele_function`, `pgx_gene_evidence_level` y los artefactos `pgx_per_position`, `pgx_alleles`, `metadata`, `genomic_mapping`, `genomic_substitutions`.
- Recursos declarados: 1 CPU, 0 GPU, sin red; requisito técnico `genomic_mapping`.
- El código recibe `pharmacogenomics_resources.lock_path` congelado en el contexto. `resources/pharmacogenomics/` contiene PharmVar/PharmGKB y el jar por defecto documentado es `dependencies/pharmcat/pharmcat-3.2.0-all.jar`.
- Tests observados: `tests/pharmacogenomics/` cubre ejecución, recursos, freeze/promotion y contrato de mapping.
