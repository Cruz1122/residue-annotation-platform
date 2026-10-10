# 0004 — Identidad y catálogo de proteínas

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F2 Dominio. **Dependencias:** `0002`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `PROT-001` | Unit normalización + unique DB. Given dos headers para secuencia idéntica, when se registran, then resuelven al mismo protein_id. | **NOT RUN** | PENDIENTE |
| `PROT-002` | API negativo + transacción. Given FASTA malformado, when POST, then error 422 sin inserción. | **NOT RUN** | PENDIENTE |
| `PROT-003` | DB alias mapping. Given alias nuevo, when se enlaza, then protein_id y hash siguen idénticos. | **NOT RUN** | PENDIENTE |
| `PROT-004` | Contrato HTTP. Given protein existente, when GET, then metadata autorizable sin filesystem. | **NOT RUN** | PENDIENTE |

## Registro de ejecución obligatorio

- Fecha UTC: NOT RUN
- Commit/release: NOT RUN
- Comando/entorno/exit code: NOT RUN
- Logs/artefactos/capturas: NOT RUN
- Evaluación científica/operacional: NOT RUN
- Aprobador y excepciones: PENDIENTE

**No usar `PASS` hasta ejecutar y guardar evidencia concreta.**
