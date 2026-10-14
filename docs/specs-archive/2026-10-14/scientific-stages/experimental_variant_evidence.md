# Contrato de migración científica — `experimental_variant_evidence`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Cuánta evidencia missense hay en MaveDB?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `experimental_variant_evidence` |
| ID histórico | `P13` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``uniprot_features`` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `sí` (n/d = no documentado, no "no") |
| Columnas publicadas | 3 columnas `mavedb_*` |

## Invariantes específicos

Si MaveDB no respondió, los conteos son NA, no 0.

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

- `stages/experimental_variant_evidence/stage.py:run` materializa el scaffold de `uniprot_features` y llama a `core.run_experimental_variant_evidence` con `cache/mavedb`.
- Dependencia: `uniprot_features`; requiere `gene`. Produce `mavedb_position_assayed`, `mavedb_n_score_sets`, `mavedb_n_substitutions_tested` y el artefacto `mavedb_details`.
- Recursos declarados: 1 CPU, 0 GPU, red declarada; requisito `mavedb_access_or_cache`.
- La documentación remota identifica `https://api.mavedb.org/api/v1`, pero el job de cómputo usa caché; ausencia de respuesta se representa como NA, no cero.
- Tests observados: contrato de `tests/experimental_variant_evidence/`; el smoke remoto sigue pendiente.
