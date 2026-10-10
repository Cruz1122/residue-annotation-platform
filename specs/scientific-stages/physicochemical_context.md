# Contrato de migración científica — `physicochemical_context`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Secundaria y enterramiento del residuo de referencia?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `physicochemical_context` |
| ID histórico | `P10` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_relaxation_energy`` |
| Opcional | `no` |
| CPU declarada | `4` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `secondary_structure`, `buried_status` |

## Invariantes específicos

rSASA < 0.20 implica buried solo con dato válido; no reemplazar NA.

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

- `stages/physicochemical_context/stage.py:run` materializa identidad, UniProt y la relajación; consume `selected_reference_pdb`, `structure_mapping` y `structure_qc_per_residue`.
- Dependencia: `protein_relaxation_energy`. Produce `secondary_structure`, `buried_status` y los artefactos `dssp_per_residue`, `sasa_per_residue`, `physicochemical_context_detail`.
- Recursos declarados: 4 CPU, 0 GPU, sin red; DSSP y FreeSASA deben estar disponibles en `PATH`/módulo.
- El core colapsa DSSP a clases estructurales y clasifica `buried` con rSASA válida menor que 0.20; un residuo no mapeable conserva NA.
- Tests observados: `tests/physicochemical_context/` cubre stage, runtime defaults y reglas de contexto.
