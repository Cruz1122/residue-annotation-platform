# Contrato de persistencia y ownership — DRAFT

Fuente objetivo: `Arquitectura propuesta.pdf`, pp. 3–5. Fuente pipeline actual: `02-orchestration.md`.

| Entidad | Datos mínimos | Ownership / unicidad |
| --- | --- | --- |
| `protein` | id, sequence_sha256, sequence, length | SHA256 UNIQUE para secuencia normalizada exacta |
| `protein_identifier` | protein_id, source, identifier | Aliases UniProt/gen/user no crean nueva protein |
| `run` | id, protein_id, status, timestamps, auth scope futuro | Es solicitud lógica, no copia outputs científicos |
| `run_stage` | run_id, stage_id, stage_result_id, status, slurm_job_id, timestamps | Une run con cómputo o reuso |
| `stage_result` | id, protein_id, stage_id, cache_key, status, provenance | Cálculo reutilizable entre runs |
| `artifact` | id, stage_result_id, type, storage_backend, storage_key, sha256, size | Índice de objeto GPFS, sin ruta absoluta pública |
| `annotation_<stage>` | stage_result_id, aa_position, aa_ref, columnas tipadas | Una tabla tipada por stage, no EAV genérico |

**Identidad:** reconstruir secuencia, quitar separadores de formato, normalizar mayúscula, validar alfabeto, **sin recortar ni transformar biológicamente residuos**. Una misma cadena produce una única protein.

**Composición:** GET annotations de run sigue `run_stage → stage_result` para resultados success/reused; no duplica resultados por cada solicitud.

**QC:** posiciones canónicas 1-based; comparar aa_position + aa_ref y cobertura según stage; zero solo cuando fuente informó zero. La vista exportable es **derivada**; no es el bus interno entre stages. Formato de export `annotations.tsv` vs `aa_annotations.tsv` pendiente de ADR-007.

**Migración:** Alembic versionado, constraints y FKs comprobados, índice por cache_key/estado; pruebas transaccionales y rollback. Auth scopes para reuso sin fugas de datos requieren ADR-011.
