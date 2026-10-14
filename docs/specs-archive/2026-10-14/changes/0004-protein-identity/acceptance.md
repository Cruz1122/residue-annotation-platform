# 0004 — Identidad y catálogo de proteínas

**Estado:** PARTIAL local; falta el gate humano de aprobación de la spec y una ejecución PostgreSQL separada. La implementación y tests SQLite aislados existen.

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| PROT-001 | Dos headers o formatos para una secuencia idéntica resuelven el mismo protein_id | PASS (local) | Test de normalización y POST idempotente; sequence_sha256 es UNIQUE |
| PROT-002 | FASTA vacío/malformado o alfabeto prohibido no deja escritura parcial | PASS (local) | Test POST inválido devuelve 422 y cuenta Protein queda en cero |
| PROT-003 | Alias nuevo no crea protein_version ni cambia protein_id/hash | PASS (local) | Test de deduplicación conserva ID y agrega alias |
| PROT-004 | GET autorizado devuelve metadata sin filesystem ni rutas absolutas | PASS local / gate externo pendiente | El escenario HTTP/Bearer independiente contra el runtime Compose con PostgreSQL 16 creó una proteína como Alice y confirmó `403` para Bob; la respuesta extranjera no expuso `/gpfs/` ni `storage_key`. La aprobación independiente del gate sigue pendiente. |

## Registro de ejecución

Fecha UTC: 2026-10-14
Comando: uv run pytest -q
Resultado: 209 tests PASS localmente y los 11 escenarios concurrentes pasan en la ejecución completa de 220 tests contra PostgreSQL 16 aislado; ejecución SQLite in-memory con StaticPool, smoke runtime PostgreSQL y E2E HTTP/Bearer contra Compose PostgreSQL. El ownership service-level y el endpoint HTTP/Bearer contra PostgreSQL bloquean un principal extranjero; queda pendiente la aprobación independiente del gate.
