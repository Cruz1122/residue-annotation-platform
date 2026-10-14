# Contrato de migración científica — `conformational_ensemble`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Qué conformaciones genera BioEmu y cuáles se retienen?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `conformational_ensemble` |
| ID histórico | `P17` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_identity`` |
| Opcional | `no` |
| CPU declarada | `4` |
| GPU declarada | `1` |
| Red declarada | `n/d` (n/d = no documentado, no "no") |
| Columnas publicadas | ninguna |

## Invariantes específicos

No promueve columnas per-residue. Retener frames solo tras QC y mínimo de conformeros exigido.

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

- `stages/conformational_ensemble/stage.py:run` ejecuta `ensure_msa`, materializa el MSA/embeddings, corre rondas de BioEmu y finaliza el ensemble; devuelve `copy_scaffold` porque no publica columnas por residuo.
- Dependencia científica: `protein_identity`; requisito técnico: `msa_cache`. Produce `conformational_ensemble_final_dir`, `metadata`, `frames_index`, `ensemble_aligned_ca`, `ensemble_flat_ca`, `topology`, `ensemble_cache`, `msa_manifest`, `log`.
- Recursos declarados: 4 CPU, 1 GPU, sin red. `config.py` fija `resources/bioemu`, `samples_per_round=250`, `max_rounds=20` y `bioemu-v1.2` salvo overrides.
- El MSA `af3-msa-v1` es prerrequisito técnico compartido; la etapa no debe inventar un ensemble si no hay MSA válido o no existe un generador inyectado.
- Tests observados: `tests/conformational_ensemble/` cubre MSA, rondas, embeddings, launcher, retención y finalización.
