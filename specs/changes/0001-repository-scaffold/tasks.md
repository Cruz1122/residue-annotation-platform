# Tasks 0001 — Scaffold

**Status:** PLAN; no ejecutado. **Precondición:** aprobación de la spec `0001`.

- [ ] **T01 [REQ-SCF-001]** Crear raíz del repo, estructura por features y archivos mínimos; **Done when:** árbol coincide con el contrato y no hay capas sin uso.
- [ ] **T02 [REQ-SCF-002, REQ-SCF-006]** Inicializar backend Python/FastAPI; registrar `/api/v1/health` y configuración CORS; **Depends on:** T01; **Done when:** endpoint responde HTTP 200 JSON correcto.
- [ ] **T03 [REQ-SCF-003, REQ-SCF-004, REQ-SCF-006]** Inicializar Astro y un `getHealth()` tipado reutilizable; mostrar `Checking`, `Connected`, `Unavailable`; **Depends on:** T02; **Done when:** interfaz cambia según resultado real.
- [ ] **T04 [REQ-SCF-005, REQ-SCF-006]** Añadir Dockerfiles, `compose.yml` y variables documentadas para dos servicios; **Depends on:** T02, T03; **Done when:** Docker Compose levanta ambos sin pasos ocultos.
- [ ] **T05 [REQ-SCF-001, REQ-SCF-007]** Añadir README y `.gitignore`; **Depends on:** T04; **Done when:** onboarding se puede seguir desde cero.
- [ ] **T06 [REQ-SCF-001..007]** Ejecutar checks de Compose, health, UI arriba/abajo y revisión de alcance; **Depends on:** T05; **Done when:** `acceptance.md` tiene evidencia real y no quedan MUST sin comprobar.

## Gates

- [ ] Sin PostgreSQL, worker, SSE, HPC ni viewer PDB.
- [ ] No se simula salud del backend.
- [ ] Variables del navegador correctas para red externa a Docker.
- [ ] No hay configuración ni imports huérfanos.
- [ ] Todos los REQ-SCF tienen chequeo y evidencia.
