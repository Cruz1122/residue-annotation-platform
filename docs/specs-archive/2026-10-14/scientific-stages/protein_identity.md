# Contrato de migración científica — `protein_identity`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Cuál es el andamio canónico residuo a residuo?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `protein_identity` |
| ID histórico | `P01` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | `—` |
| Opcional | `no` |
| CPU declarada | `1` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | `gene` (+ clave `protein_id`, `aa_position`, `aa_ref`) |

## Invariantes específicos

Una fila por residuo canónico; identidad externa ambigua no justifica inventar accession.

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

- `stages/protein_identity/stage.py:run(ctx, output_dir)` llama a `core.run_identity` con la FASTA query/canónica, `ctx.identity`, `ctx.identity_resources` e `input_state`, y publica mediante `stages._adapter_utils.publish`.
- Dependencias: ninguna. Anotación declarada: `gene`. Artefactos declarados: `canonical_fasta`, `protein_identity`, `transcripts`, `query_fasta`, `reference_mane_fasta`, `mane_reference`, `sifts_mapping`, `sequence_comparison`, `sequence_assessment`, `engineered_mutations`, `detected_variants`, `unresolved_differences`.
- Recursos declarados: 1 CPU, 0 GPU, sin red; `technical_requirements=()`.
- La etapa construye el scaffold canónico 1-based y deja separadas query/reference, MANE, SIFTS, transcripts, variantes detectadas y diferencias no resueltas. La documentación remota indica que Ensembl debe estar cacheado en un nodo Slurm.
- Tests observados: `tests/protein_identity/` cubre identidad, MANE, mapping, comparación de secuencia, integración de variantes y adapter.
