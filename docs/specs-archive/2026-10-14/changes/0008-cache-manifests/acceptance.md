# 0008 — Manifiestos, publicación y cache

**Estado:** PARTIAL local; las fronteras de cache y manifest están implementadas, pero este checkout no ha ejecutado un stage científico integrado que publique un resultado real.

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| CACHE-001 | Parámetro/recurso relevante cambia cache_key; log level no | PASS (local) | Test de cache_key verifica cambio ante parámetro científico |
| CACHE-002 | Artifact perdido fuerza cache miss | PASS local | `_find_reusable_result` exige que todos los artefactos existan con su tamaño y sha256 registrados; en un miss, `_purge_stale_results` elimina la fila obsoleta (y sus artefactos/annotations) antes de republicar, evitando el conflicto con `uq_stage_result_cache`; la limpieza de archivos se difiere hasta el commit y un fallo de republicación restaura fila y bytes anteriores. Tests: `test_reusable_result_requires_existing_artifacts`, `test_ingest_result_reuses_existing_cache_entry`, `test_stale_cache_entry_is_purged_and_republished`, `test_failed_republish_restores_stale_cache_row_and_files`; integración con un stage científico real pendiente |
| CACHE-003 | Crash antes de manifest no publica success | PARTIAL | validate_manifest, write_manifest_atomic con fsync y limpieza de temporales existen; el fallo simulado de `os.replace` no deja destino ni temporal y los manifiestos rechazan `size` booleano; falta publicación transaccional integrada con un stage real |
| CACHE-004 | Provenance reproduce inputs/versiones/hashes/unidades sin ruta pública | PARTIAL | Un snapshot SFTP read-only completo de `all_stages_47143345/profile_01/results/protein_identity/<cache_key>/` verificó 16 archivos explícitos: `DONE`, manifest, provenance, annotations y los 12 artefactos locales declarados. Todos quedaron `VERIFIED_READ`, sin fallos, con tamaño/hash coincidente; el manifest declara `stage-result-v1`, `protein_identity`, `success`, `partial=false` y pasa `validate_remote_manifest`. La ruta productiva `_ingest_result`, reproducida localmente con esos bytes, publicó 13 artefactos y 860 filas (`P01130`, cobertura `1..860`, `aa_ref` concordante) en SQLite temporal, conservando `provenance.source=mn5-slurm`. Falta ejecutar/publicar mediante worker y transporte SSH/native reales desde este checkout y validar outputs científicos completos, por lo que no es PASS de integración. |

## Registro de ejecución

Fecha UTC: 2026-10-14
Comando: uv run pytest -q
Resultado: 209 tests PASS localmente y los 11 escenarios concurrentes pasan en la ejecución completa de 220 tests contra PostgreSQL 16 aislado; incluye rechazo de storage key insegura, manifest inválido o con size booleano, compatibilidad con archivos grandes sin hash y annotations grandes sin integrity record, stages artifact-only con directorios `null/null`, rechazo de annotations externas, limpieza de temporales de manifest, reuso con cache miss por artefacto ausente, rollback de republicación stale, nombres de artifacts con basename colisionado, streaming desde descriptor verificado y los límites de auth/upload/run. Integración científica y fault injection con stage real: NOT RUN.
