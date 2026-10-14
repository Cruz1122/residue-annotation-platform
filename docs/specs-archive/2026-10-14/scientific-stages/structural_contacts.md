# Contrato de migración científica — `structural_contacts`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** La ficha conserva carácter de migración y no constituye evidencia de equivalencia empírica; el código, contrato y wiring del stage fueron revisados en el checkout remoto el 2026-10-10.

## Pregunta científica

¿Con qué contacta el residuo en la referencia?

## Contrato científico de migración documentado (fuente heredada)

> Esta tabla conserva la vista de migración original para trazabilidad. El contrato vigente observado en MN5 está en la sección `Revisión del código observado en MN5` de esta ficha y en el inventario consolidado.
| Atributo | Valor documentado |
| --- | --- |
| `stage_id` | `structural_contacts` |
| ID histórico | `P12` (identificador legado; no asumir columna persistida) |
| Dependencias científicas | ``protein_relaxation_energy`` |
| Opcional | `no` |
| CPU declarada | `4` |
| GPU declarada | `0` |
| Red declarada | `no` (n/d = no documentado, no "no") |
| Columnas publicadas | 5 columnas `structural_contacts_*` |

## Invariantes específicos

No inferir contactos ganados/perdidos; requiere estructura de referencia establecida.

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

- `stages/structural_contacts/stage.py:run` materializa identidad, UniProt y la relajación; consume `structure_mapping` y `selected_reference_pdb` y llama a `core.run_structural_contacts`.
- Dependencia: `protein_relaxation_energy`. Produce `structural_contacts_n_contacts`, `structural_contacts_n_partner_residues`, `structural_contacts_contact_types`, `structural_contacts_status`, `structural_contacts_qc_reason`.
- Artefactos: `contact_residue_summary`, `contacts_long`, `structure_index`, `provenance`, `arpeggio_json`, `arpeggio_log`. Recursos: 4 CPU, 0 GPU, sin red.
- Hallazgo operativo: el contrato remoto deja `technical_requirements=()`, pero `core.py` exige `SLURM_JOB_ID` antes de invocar Arpeggio. Debe reflejarse en el contrato o en una política de runtime antes de planificarlo desde la plataforma.
- Tests observados: `tests/structural_contacts/` cubre contrato y `runtime_env`; no se ejecutó Arpeggio remoto.
