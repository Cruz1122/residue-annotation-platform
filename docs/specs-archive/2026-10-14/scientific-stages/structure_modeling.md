# Contrato de migración científica — `structure_modeling`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿El residuo i del modelo AlphaFold 3 es utilizable?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `structure_modeling` |
| ID histórico | `P04` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``membrane_topology`` |
| Opcional | `no` |
| CPU declarada | `8` |
| GPU declarada | `1` |
| Red declarada | `n/d` (n/d = no documentado, no "no") |
| Columnas publicadas | `structure_qc_status` |

## Invariantes específicos

pLDDT no prueba estabilidad/función/patogenicidad. Validar coordenadas y residuos.

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

- `stages/structure_modeling/stage.py:run` materializa identidad, UniProt y topología de membrana, llama a `core.run_structure_modeling` y publica `structure_qc_status`.
- Dependencia: `membrane_topology`; requiere `tmbed_topology`. Produce `model_cif`, `msa_cache_entry`, `af3_confidence_per_residue`, `structure_qc_per_residue`, `alphafold_dir`.
- Recursos declarados: 8 CPU, 1 GPU, sin red; sin requisito técnico en el `StageSpec`, aunque el código/documentación exige MSA `af3-msa-v1` y binario AF3.
- Si la caché MSA es válida, el wrapper usa `--norun_data_pipeline`; el QC se hace residuo a residuo y no convierte pLDDT en estabilidad, función ni patogenicidad.
- Tests observados: contrato de `tests/structure_modeling/`; smoke AF3 pendiente.
