# 0004 — Identidad y catálogo de proteínas

**Estado:** DRAFT — NO APROBADO — IMPLEMENTACIÓN LOCAL PARCIAL (ver acceptance.md). **Fase:** F2 Dominio. **Dependencias:** `0002`.

## Checklist de implementación

- [x] T-0004-01 — Crear modelos protein/protein_identifier y migración (`REQ-PROT-001`) — implementado y verificado en SQLite y PostgreSQL 16 aislado.
- [x] T-0004-02 — Implementar hash y validadores con property tests (`REQ-PROT-002`) — normalización, SHA-256, aa_ref y rechazos cubiertos por la suite local.
- [x] T-0004-03 — Crear endpoints POST/GET y tests DB (`REQ-PROT-003`) — endpoints de creación, lectura/listado, aliases y ownership implementados.
- [x] T-0004-04 — Revisar normalización/concurrencia y errores (`REQ-PROT-004`) — idempotencia y errores de validación verificados; queda pendiente el IDOR independiente con dos principals.

## Gate

Ejecutar aceptación de `PROT-001, PROT-002, PROT-003, PROT-004` con PASS/FAIL/NOT RUN y cierre humano; no pasar automáticamente al siguiente change.
