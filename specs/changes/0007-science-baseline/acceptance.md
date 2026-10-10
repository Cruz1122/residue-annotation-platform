# 0007 — Baseline y reconciliación científica

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F3 Ciencia. **Dependencias:** `0002`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `SCI-001` | Artefactos reales + manifest. Given stage real, when smoke, then se puede comparar con baseline. | **NOT RUN** | PENDIENTE |
| `SCI-002` | Diff científico. Given before/after, when compara, then diferencias/tolerancias reportadas. | **NOT RUN** | PENDIENTE |
| `SCI-003` | Negative residue mapping. Given residuo con aa_ref distinto, when merge, then falla. | **NOT RUN** | PENDIENTE |
| `SCI-004` | Golden P5. Given TM de evidencia concluyente con pLDDT bajo, when P5, then mantiene decisión biológica salvo conflicto especificado. | **NOT RUN** | PENDIENTE |

| `SCI-005` | Revisión del inspector y comparación de metadata de archivos antes/después (solo operaciones de lectura).; Given carpeta real disponible y autorización, when inspecciona contratos/logs/manifests, then conserva evidencias por lectura. Given credenciales no disponibles, then NOT RUN sin inventar outputs. | **NOT RUN** | Se confirmó manualmente la raíz y se inspeccionaron contratos/código/documentación por SFTP, pero no existe aún `ReadOnlyMN5Inspector` ni se hizo comparación de metadata antes/después; el criterio permanece NOT RUN. |

## Registro de ejecución e inspección

- Fecha UTC: `2026-10-10` para la inspección documental; ejecución científica NOT RUN
- Commit/release: `e3c69c8` local; checkout remoto inspeccionado por SFTP sin release fijado
- Comando/entorno/exit code: listados y lecturas SFTP read-only; no se ejecutaron stages/jobs
- Logs/artefactos/capturas: inventario local; no se copiaron resultados masivos ni secretos
- Evaluación científica/operacional: código observado; baseline y diff científico NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
