# Contrato de migración científica — `variant_predictors`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Qué dicen AlphaMissense/CADD/REVEL de las missense posibles?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `variant_predictors` |
| ID histórico | `P16` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_identity`` |
| Opcional | `no` |
| CPU declarada | `4` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `alphamissense_*`, `cadd_phred_mean`, `revel_mean` |

## Invariantes específicos

NA no significa benigno; evitar atribuir patogenicidad clínica a promedios de predictores.

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

- `stages/variant_predictors/stage.py:run` consume `protein_identity` y `transcripts`, llama a `core.run_variant_predictors` y publica `annotations.tsv`.
- Dependencia: `protein_identity`; requiere `gene`. Produce `alphamissense_mean`, `alphamissense_max`, `cadd_phred_mean`, `revel_mean` y los artefactos `predictor_per_position`, `predictor_substitutions`, `transcript_mapping`, `metadata`.
- Recursos declarados: 4 CPU, 0 GPU, sin red; requisito técnico declarado: `genomic_mapping`.
- `config.py` fija recursos locales `resources/variant_predictors` y `resources/ensembl`. El core usa recursos locales/Tabix y no descarga durante la etapa.
- Tests observados: `tests/variant_predictors/` cubre predictores, mapping CDS, contrato de identidad y metadata compartida de mapping.
