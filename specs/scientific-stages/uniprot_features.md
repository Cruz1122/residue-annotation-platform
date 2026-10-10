# Contrato de migración científica — `uniprot_features`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Qué features curadas de UniProt e InterPro caen en el residuo?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `uniprot_features` |
| ID histórico | `P02` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_identity`` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `sí` (n/d = no documentado, no "no") |
| Columnas publicadas | 10 columnas `uniprot_*`, `in_metal_site`, `interpro_*` |

## Invariantes específicos

Mapeo exacto; proyección solo donde aa_ref concuerda. Identidad de referencia documentada 0.90, validar contra código.

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

- `stages/uniprot_features/stage.py:run` exige `ctx.uniprot_accession`, consume `protein_identity` y llama a `core.run_uniprot_features`; publica `uniprot_coordinate_mapping` y `functional_features_long`.
- Dependencia: `protein_identity`; requiere `gene`. Produce diez columnas: `uniprot_domain`, `uniprot_active_site`, `uniprot_binding_site`, `uniprot_ptm`, `uniprot_disulfide_partner`, `uniprot_topology`, `in_metal_site`, `interpro_entries`, `interpro_status`, `uniprot_mapping_status`.
- Recursos declarados: 1 CPU, 0 GPU, red declarada; requisito técnico `external_cache`.
- En un job Slurm el preflight exige JSON cacheado de UniProt/InterPro y no descarga. `--prepare-external` se ejecuta fuera de la corrida.
- Tests observados: `tests/uniprot_features/test_audit_features.py` y tests de contrato.
