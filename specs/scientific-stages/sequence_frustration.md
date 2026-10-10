# Contrato de migración científica — `sequence_frustration`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Qué frustración predice el modelo solo con secuencia?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `sequence_frustration` |
| ID histórico | `P18` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_identity`` |
| Opcional | `no` |
| CPU declarada | `2` |
| GPU declarada | `1` |
| Red declarada | `n/d` (n/d = no documentado, no "no") |
| Columnas publicadas | 4 columnas `frustraiseq_*` |

## Invariantes específicos

Si se requiere GPU y no existe CUDA no continuar silenciosamente en CPU.

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

- `stages/sequence_frustration/stage.py:run` materializa el scaffold de `protein_identity`, llama a `core.run_sequence_frustration` y publica cuatro columnas.
- Dependencia: `protein_identity`. Produce `frustraiseq_index`, `frustraiseq_class`, `frustraiseq_entropy`, `frustraiseq_surprisal` y los artefactos `frustraiseq_per_residue`, `metadata`.
- Recursos declarados: 2 CPU, 1 GPU, sin red. La documentación exige fallar si se solicitó GPU y CUDA no está disponible; no debe caer silenciosamente a CPU.
- El runtime se encuentra bajo `dependencies/python-frustraiseq`; la etapa usa solo la secuencia canónica, no PDB ni MSA.
- Tests observados: `tests/sequence_frustration/test_sequence_frustration.py`.
