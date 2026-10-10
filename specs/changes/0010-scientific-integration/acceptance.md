# 0010 — Migración e integración de los 18 stages

**Estado:** REMOTE CODE INVENTORY VERIFIED / SCIENTIFIC EXECUTION NOT RUN. **Fase:** F4 Ciencia. **Dependencias:** `0007`, `0008`, `0009`.

## Matriz de verificación

| REQ | Método y escenario | Estado | Evidencia real |
| --- | --- | --- | --- |
| `STAGE-001` | Registry validation. Given registry, when audit, then 18 contratos verificables. | **PARTIAL** | En MN5, `orchestration/registry.py` registra 18 IDs y se observaron contratos/adapters/docs/tests de los stages principales. El checkout local no tiene registry/adapters backend integrados; existe además `variant_structure_relaxation` standalone fuera del registro. |
| `STAGE-002` | Scientific smoke. Given salida desalineada, when ingesta, then rechazo controlado. | **NOT RUN** | PENDIENTE |
| `STAGE-003` | Matriz PASS/NOT RUN. Given smoke pendiente, when review, then stage no se declara verified. | **NOT RUN** | PENDIENTE |
| `STAGE-004` | Preflight negativo. Given herramienta ausente, when stage ejecuta, then failure auditado. | **NOT RUN** | PENDIENTE |

## Registro de inspección y ejecución

- Fecha UTC: `2026-10-10`
- Commit/release local: `e3c69c8`; versión remota del checkout no fijada por commit porque la inspección fue SFTP de archivos
- Comando/entorno/exit code: listados y lecturas SFTP read-only; no se ejecutaron stages ni jobs
- Logs/artefactos/capturas: inventario documental local; no se conservaron resultados científicos masivos ni secretos
- Evaluación científica/operacional: código/contratos/documentación inspeccionados; ejecución científica NOT RUN
- Aprobador y excepciones: PENDIENTE

## Evidencia local

- `frontend/src/features/stages/data/pipeline.js` contiene 18 stages visuales.
- `frontend/public/mock-artifacts/` contiene 59 archivos organizados por stage.
- La página `/proteins/P01130/info/` muestra 18 paneles y 56 enlaces a artefactos mock.
- El inventario remoto de [`docs/mn5-stage-code-inventory.md`](../../../docs/mn5-stage-code-inventory.md) correlaciona 19 paquetes de stage, 18 IDs del registry, contratos, recursos, entrypoints y tests observados en `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`.
- El entrypoint registrado de `variant_ddg` usa runtime Rosetta; `core.py` y la documentación legacy todavía describen FoldX. Esta divergencia queda pendiente de decisión antes de aceptar resultados P07.
- No hay ejecución científica, manifest final validado, provenance ingestado, baseline MN5 ni comparación antes/después.

**No usar `PASS` para la integración científica hasta ejecutar stages, validar manifests/provenance y guardar evidencia concreta.**
