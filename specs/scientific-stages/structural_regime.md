# Contrato de migración científica — `structural_regime`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Membrana, soluble plegada o incierta?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `structural_regime` |
| ID histórico | `P05` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``structure_modeling`` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `structural_regime`, `structural_regime_rule`, `topology_agreement` |

## Invariantes específicos

Evidencia TM concluyente domina a la mera usabilidad AF3; conflictos topológicos se resuelven con reglas explícitas.

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

- `stages/structural_regime/stage.py:run` materializa identidad, UniProt, TMbed y structure modeling; consume `af3_confidence_per_residue` y `structure_qc_per_residue`.
- Dependencia: `structure_modeling`; requiere `uniprot_topology`, `tmbed_topology`, `structure_qc_status`. Produce `structural_regime`, `structural_regime_rule`, `topology_agreement` y `structural_regime_detail`.
- Recursos declarados: 1 CPU, 0 GPU, sin red; sin requisito técnico adicional.
- El core implementa reglas deterministas para `membrane`, `aqueous_folded` y `structurally_uncertain`; la topología concluyente se evalúa antes que la confianza AF3.
- Tests observados: `tests/structural_regime/test_audit_regime.py` y tests de contrato.
