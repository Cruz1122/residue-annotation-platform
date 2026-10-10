# Tasks 0002 — Quality

**Status:** BLOQUEADO hasta cierre de `0001`.

- [ ] **T01 [REQ-QLT-001]** Añadir tests de health y error de ruta, sin DB; **Done when:** pytest sale 0 y cada test prueba un comportamiento real.
- [ ] **T02 [REQ-QLT-002]** Añadir Ruff y comandos read-only de lint/format; **Depends on:** T01; **Done when:** checks corren con código 0.
- [ ] **T03 [REQ-QLT-003]** Añadir `astro check` y build al flujo documentado; **Done when:** strict TS y Astro check pasan.
- [ ] **T04 [REQ-QLT-003, REQ-QLT-004]** Añadir CI sin HPC tras decidir proveedor; **Depends on:** T02, T03; **Done when:** job real pasa y falla con una regresión intencional de prueba (sin subir la regresión).
- [ ] **T05 [REQ-QLT-001..004]** Actualizar README y acceptance; **Depends on:** T04; **Done when:** evidencia real registrada.

## Gates

- [ ] No agrega endpoints científicos ni servicios de Compose.
- [ ] No hay `continue-on-error` en checks obligatorios.
- [ ] Ninguna prueba requiere secretos ni GPUs.
