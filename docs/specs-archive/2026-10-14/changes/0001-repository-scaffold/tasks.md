# Tasks 0001 — Scaffold

**Status:** IMPLEMENTED locally; el smoke Docker actual de backend, DB, frontend, VPN y worker está documentado, pero la aceptación formal de staging/producción sigue fuera de este change. **Puertos contractuales:** 4742 frontend / 8742 backend.

- [x] **T01 [REQ-SCF-001]** Crear raíz del repo, estructura por features y archivos mínimos; **Done when:** árbol coincide con el contrato y no hay capas sin uso.
- [x] **T02 [REQ-SCF-002, REQ-SCF-006]** Inicializar backend Python/FastAPI; registrar `/api/v1/health` y configuración CORS; **Depends on:** T01; **Done when:** endpoint responde HTTP 200 JSON correcto.
- [x] **T03 [REQ-SCF-003, REQ-SCF-004, REQ-SCF-006]** Inicializar Astro y un `getHealth()` tipado reutilizable; mostrar `Checking`, `Connected`, `Unavailable`; **Depends on:** T02; **Done when:** interfaz cambia según resultado real.
- [x] **T04 [REQ-SCF-005, REQ-SCF-006]** Añadir Dockerfiles, `compose.yml` y variables documentadas para dos servicios en 4742/8742; **Depends on:** T02, T03; **Done when:** configuración Compose es consistente.
- [x] **T05 [REQ-SCF-001, REQ-SCF-007]** Añadir README y `.gitignore`; **Depends on:** T04; **Done when:** onboarding se puede seguir desde cero.
- [x] **T06 [REQ-SCF-001..007]** Ejecutar checks de Compose, health, UI y revisión de alcance; **Depends on:** T05; **Done when:** `acceptance.md` conserva evidencia y marca explícitamente lo pendiente.

## Gates

- [x] Las restricciones de alcance del scaffold son históricas y quedaron supersedidas por los changes posteriores que añadieron PostgreSQL, worker, SSE, HPC y viewer; no se usan como aceptación del producto completo.
- [x] No se simula salud del backend.
- [x] Las variables del navegador usan la URL pública correcta para red externa a Docker.
- [x] No hay configuración ni imports huérfanos detectados por los checks locales.
- [x] Todos los REQ-SCF tienen chequeo y evidencia local; la aceptación externa de despliegue queda separada.
