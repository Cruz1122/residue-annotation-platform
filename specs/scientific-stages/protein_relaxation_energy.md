# Contrato de migración científica — `protein_relaxation_energy`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Cuál es la energía del residuo tras relajar la referencia?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `protein_relaxation_energy` |
| ID histórico | `P06` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``structural_regime`` |
| Opcional | `no` |
| CPU declarada | `16` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `residue_energy_value`, `energy_tool`, `energy_status` |

## Invariantes específicos

Rama FoldX (kcal/mol) vs RosettaMP (REU), no convertir ni mezclar; nombre del PDF requiere ADR-005.

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

- `stages/protein_relaxation_energy/stage.py:run` tiene dos ramas: sistema PDB subido autocontenido o pipeline normal con `protein_identity` + `structural_regime`; consume modelo/QC AF3, segmentos TM y span.
- Dependencia normal: `structural_regime`; requiere `structural_regime`, `structural_regime_rule`, `topology_agreement`. Produce `rosetta_relaxation_status`, `foldx_relaxation_status`, `rosetta_energy_value`, `foldx_energy_value` y los artefactos `structure_mapping`, `selected_reference_pdb`, `selected_reference_json`, `provenance`.
- Recursos declarados: 20 CPU, 0 GPU, sin red. `config.py` permite `auto`, `foldx`, `rosetta`, `both`, con `both` como valor por defecto; usa FoldX 5.1 y módulo Rosetta 3.14.
- La ruta Rosetta MPI requiere `SLURM_JOB_ID`/`srun`; la rama uploaded tiene políticas de cobertura propia y no debe confundirse con el camino canónico completo.
- Tests observados: `tests/protein_relaxation_energy/` cubre contrato, ambos modos y force fields.
