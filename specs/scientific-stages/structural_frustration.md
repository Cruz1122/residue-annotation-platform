# Contrato de migración científica — `structural_frustration`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Cuál es la frustración del residuo en la referencia?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `structural_frustration` |
| ID histórico | `P08` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_relaxation_energy`` |
| Opcional | `no` |
| CPU declarada | `4` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | 12 columnas `structural_frustration_*` |

## Invariantes específicos

El término mutational de Frustratometer no implica variante genética real; window5 excluye NA.

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

- `stages/structural_frustration/stage.py:run` materializa identidad, UniProt y la relajación; consume `structure_mapping` y `selected_reference_pdb` y llama a `core.run_structural_frustration`.
- Dependencia: `protein_relaxation_energy`. Produce 12 campos: `structural_frustration_fi_singleresidue`, los agregados `*_window5_mean`/`*_window5_median`, `*_configurational`, `*_mutational`, seis conteos `structural_frustration_n_contacts_*` y `structural_frustration_status`.
- Artefactos: `frustration_per_residue`, `structure_index`, `provenance`, `native_output_dir`. Recursos: 4 CPU, 0 GPU, sin red.
- `config.py` fija ventana 5 y `seqdist=12` por defecto; el runtime usa Frustratometer/R y recursos `dependencies/r-frustratometer-library` e `dependencies/imagemagick6_runtime`.
- La métrica mutational de Frustratometer no representa una variante del usuario. Tests observados: contrato de `tests/structural_frustration/`; smoke científico pendiente.
