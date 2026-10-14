# Tasks 0003 — Visor interactivo (integración existente)

**Status:** PARTIAL local; la UI existente ya integra Mol* y estados honestos, y no se modifica en este trabajo. Benchmark, mapping científico y E2E con una estructura publicada siguen pendientes.

- [ ] **T01 [REQ-VIZ-005]** Decidir modelo de prueba, dispositivo y métricas; cerrar `OPEN-VIZ-*`.
- [ ] **T02 [REQ-VIZ-005]** Evaluar bibliotecas con el mismo caso y registrar resultado/ADR; **Depends on:** T01.
- [x] **T03 [REQ-VIZ-001]** Integrar Mol* como feature Astro existente; **Depends on:** T02; el cierre de aceptación requiere estructura publicada.
- [x] **T04 [REQ-VIZ-002, REQ-VIZ-003]** Implementar identificación/selección y mapping sólo cuando es validable; **Depends on:** T03; la UI no infiere `aa_position` canónica.
- [x] **T05 [REQ-VIZ-004]** Manejar estructura ausente/inválida y limpieza de recursos; **Depends on:** T03.
- [ ] **T06 [REQ-VIZ-001..005]** Realizar pruebas con estructura real y reportar evidencia; **Depends on:** T04, T05.

## Gates

- [x] No cambia pipeline científico.
- [x] Ningún canon residual se infiere sin mapping.
- [x] No cambia `compose.yml` por necesidad no probada.
