# Contrato de migración científica — `variant_ddg`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Se evaluó el ΔΔG de la variante pedida en esa posición?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `variant_ddg` |
| ID histórico | `P07` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_relaxation_energy`` |
| Opcional | `**sí**` |
| CPU declarada | `4` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `ddg_variant_evaluated` |

## Invariantes específicos

Opcional, solo variante expresamente solicitada. El campo booleano no es el ΔΔG.

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

- `stages/variant_ddg/stage.py:run` es el entrypoint registrado y llama a `pipeline_runtime.run_variant_ddg_rosetta`; consume identidad/variantes P01, topología y referencia de P06.
- Dependencias del contrato: `protein_identity`, `membrane_topology`, `protein_relaxation_energy`. Es opcional y no requiere una variante manual para la ruta normal. Produce `ddg_variant_evaluated` y `variant_annotations`, `ddg_replicates`, `provenance`, `variant_dir`, `rosetta_metadata`, `variant_set`.
- Recursos declarados: 4 CPU, 0 GPU, sin red; `config.py` fija engine `rosetta_scripts`, protocolo paired WT/MUT no Cartesian, 5 réplicas por defecto, seed base 700001 y un relax repeat.
- Hallazgo de compatibilidad: `core.py`, `docs/stages/variant_ddg.md` y el job legacy `jobs/p07_all_variants.sbatch` todavía describen FoldX BuildModel. Para el pipeline registrado, la fuente actual es `stage.py` + `contract.py`; la divergencia requiere ADR-018 y smoke autorizado.
- Tests observados: `tests/variant_ddg/` cubre contrato, integration, pipeline runtime, protocolo Rosetta, runner, variant set y stage contract.
