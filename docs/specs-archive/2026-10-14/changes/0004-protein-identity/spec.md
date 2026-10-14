# 0004 — Identidad y catálogo de proteínas

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F2 Dominio. **Dependencias:** `0002`.

## Contrato de comportamiento (WHAT)

**Objetivo:** Registrar secuencias FASTA y aliases de manera idempotente.

**No objetivos:** Sin jobs HPC, stages científicos ni un uploader masivo.

### REQ-PROT-001 — Secuencia canónica

MUST: normalizar mayúsculas y separadores de formato sin eliminar residuos biológicos; sequence_sha256 identifica proteína única.

- **Escenario verificable:** Given dos headers para secuencia idéntica, when se registran, then resuelven al mismo protein_id.
- **Prueba prevista:** Unit normalización + unique DB.

### REQ-PROT-002 — Rechazo fiable

MUST: FASTA vacío, malformado o con alfabeto prohibido se rechaza sin escritura parcial.

- **Escenario verificable:** Given FASTA malformado, when POST, then error 422 sin inserción.
- **Prueba prevista:** API negativo + transacción.

### REQ-PROT-003 — Aliases separados

MUST: UniProt, gen y nombres de usuario son aliases y no crean protein_version.

- **Escenario verificable:** Given alias nuevo, when se enlaza, then protein_id y hash siguen idénticos.
- **Prueba prevista:** DB alias mapping.

### REQ-PROT-004 — Consultas privadas

MUST: metadatos de la proteína se obtienen por ID y no exponen secrets ni rutas absolutas.

- **Escenario verificable:** Given protein existente, when GET, then metadata autorizable sin filesystem.
- **Prueba prevista:** Contrato HTTP.

## Restricciones

- Respetar `specs/constitution.md` y contratos científicos/HPC.
- No implementar fuera de esta entrega ni proclamar PASS sin prueba real.
- Dependencias de changes previos: `0002`.
- Resolver ADR relevante antes de decisiones irreversibles.
