# 0006 — Worker y pipeline persistente

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F3 Ejecución. **Dependencias:** `0005`.

## Checklist de implementación

- [ ] T-0006-01 — Crear entrypoint worker y shutdown limpio (`REQ-EXEC-001`)
- [ ] T-0006-02 — Implementar el pipeline y transitions (`REQ-EXEC-002`)
- [ ] T-0006-03 — Definir claim/lease Postgres y tests (`REQ-EXEC-003`)
- [ ] T-0006-04 — Probar reinicios y cancelación (`REQ-EXEC-004`)

## Gate

Ejecutar aceptación de `EXEC-001, EXEC-002, EXEC-003, EXEC-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
