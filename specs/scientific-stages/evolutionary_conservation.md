# Contrato de migración científica — `evolutionary_conservation`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Cuánto se conserva el residuo entre homólogos?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `evolutionary_conservation` |
| ID histórico | `P19` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``uniprot_features`` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `sí` (n/d = no documentado, no "no") |
| Columnas publicadas | `rate4site_score`, `consurf_grade` |

## Invariantes específicos

Publicar puntuaciones solo si el QC de homólogos y fiabilidad aprueba; de lo contrario NA.

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

- `stages/evolutionary_conservation/stage.py:run` materializa `protein_identity` + `uniprot_features`, usa `ASSIGNED_CPUS` o `SLURM_CPUS_PER_TASK` y llama a `core.run_evolutionary_conservation` con `cache/evolution`.
- Dependencia: `uniprot_features`; requiere `gene`. Produce `rate4site_score`, `consurf_grade` y los artefactos `evolution_per_residue`, `metadata`.
- Recursos declarados: 1 CPU, 0 GPU, red declarada; requisito `homology_access_or_cache`.
- La documentación exige evidencia de homólogos o caché válida y QC antes de publicar scores; si el QC falla, las columnas quedan NA.
- Tests observados: `tests/evolutionary_conservation/test_evolutionary_conservation.py`.
