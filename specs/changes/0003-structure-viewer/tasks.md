# Tasks 0003 — Visor interactivo (NO EJECUTAR AÚN)

**Status:** BLOCKED, fuera de M0 y M1.

- [ ] **T01 [REQ-VIZ-005]** Decidir modelo de prueba, dispositivo y métricas; cerrar `OPEN-VIZ-*`.
- [ ] **T02 [REQ-VIZ-005]** Evaluar bibliotecas con el mismo caso y registrar resultado/ADR; **Depends on:** T01.
- [ ] **T03 [REQ-VIZ-001]** Integrar librería seleccionada como feature Astro; **Depends on:** T02.
- [ ] **T04 [REQ-VIZ-002, REQ-VIZ-003]** Añadir identificación/selección y mapping solo si validable; **Depends on:** T03.
- [ ] **T05 [REQ-VIZ-004]** Manejar carga inválida y limpieza de recursos; **Depends on:** T03.
- [ ] **T06 [REQ-VIZ-001..005]** Realizar pruebas con estructura real y reportar evidencia; **Depends on:** T04, T05.

## Gates

- [ ] No cambia pipeline científico.
- [ ] Ningún canon residual se infiere sin mapping.
- [ ] No cambia `compose.yml` por necesidad no probada.
