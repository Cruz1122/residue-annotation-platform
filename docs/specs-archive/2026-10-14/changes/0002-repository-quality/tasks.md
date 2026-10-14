# Tasks 0002 — Quality

**Status:** IMPLEMENTED locally; ejecución en proveedor CI pendiente.

- [x] **T01 [REQ-QLT-001]** Añadir tests de health y error de ruta, sin DB; **Done when:** pytest sale 0 y cada test prueba un comportamiento real.
- [x] **T02 [REQ-QLT-002]** Añadir Ruff y comandos read-only de lint/format; **Depends on:** T01; **Done when:** checks corren con código 0.
- [x] **T03 [REQ-QLT-003]** Añadir `astro check` y build al flujo documentado; **Done when:** strict TS y Astro check pasan.
- [x] **T04 [REQ-QLT-003, REQ-QLT-004]** Añadir CI sin HPC; **Depends on:** T02, T03; **Done when:** workflow falla si un check falla. Ejecución del proveedor pendiente.
- [x] **T05 [REQ-QLT-001..004]** Actualizar README y acceptance; **Depends on:** T04; **Done when:** evidencia local registrada.

## Gates

- [ ] No agrega endpoints científicos ni servicios de Compose.
- [ ] No hay `continue-on-error` en checks obligatorios.
- [ ] Ninguna prueba requiere secretos ni GPUs.
