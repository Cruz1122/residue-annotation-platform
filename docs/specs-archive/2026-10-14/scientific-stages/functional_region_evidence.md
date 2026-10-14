# Contrato de migración científica — `functional_region_evidence`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿El residuo cae en una región curada de LDL-C/estatinas?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `functional_region_evidence` |
| ID histórico | `P15` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``uniprot_features`` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `variant_in_statin_ldlc_region` |

## Invariantes específicos

False y NA no equivalen. Si el aa_ref contradice UniProt exacto, fallar.

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

- `stages/functional_region_evidence/stage.py:run` materializa `protein_identity` + `uniprot_features`, consume `uniprot_coordinate_mapping` y `resources/ldlc_statin_evidence`.
- Dependencia: `uniprot_features`; requiere `gene` y `uniprot_mapping_status`. Produce `variant_in_statin_ldlc_region` y los artefactos `ldlc_statin_evidence`, `summary`.
- Recursos declarados: 1 CPU, 0 GPU, sin red; sin requisito técnico adicional.
- El core distingue `false` de `NA` y falla si el `aa_ref` contradice el mapping UniProt exacto.
- Tests observados: `tests/functional_region_evidence/test_functional_region.py`.
