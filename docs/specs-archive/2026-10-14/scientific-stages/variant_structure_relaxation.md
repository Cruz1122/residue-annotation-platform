# Utilidad científica standalone — `variant_structure_relaxation`

**Estado: CODE REVIEWED IN MN5 / SCIENTIFIC EXECUTION NOT RUN.** Este paquete existe en el checkout remoto, pero no pertenece al registry principal de 18 stages y no debe representarse como un nodo normal del pipeline sin ampliar el contrato de entradas.

## Propósito

Mutar las variantes presentes en un PDB suministrado y relajar cada mutante de forma independiente con Rosetta FastRelax. Es una utilidad path-based y no consume el `RunContext` canónico del pipeline principal.

## Contrato observado en el código de MN5

| Atributo | Valor observado |
| --- | --- |
| `stage_id` | `variant_structure_relaxation` |
| Registro principal | No registrado en `orchestration/registry.py` |
| Entry point | `stages/variant_structure_relaxation/stage.py:run_from_paths` |
| Dependencias declaradas | Ninguna |
| Anotaciones publicadas | Ninguna |
| Artefactos | `variant_manifest`, `provenance`, `variants_dir` |
| Recursos | 4 CPU, 0 GPU, sin red |
| Requisito técnico | `SLURM_JOB_ID` |
| Protocolo observado | Rosetta FastRelax por variante; módulo `gcc/12.3.0`, módulo Rosetta `rosetta/3.14` |
| Defaults observados | soluble=`ref2015`, membrana=`franklin2019`, 5 repeticiones, timeout 36000 s |

## Decisión de integración

No añadirlo al pipeline ni a la UI de los 18 stages hasta representar de forma explícita sus entradas por ruta, identidad de PDB, lista de variantes, aislamiento, provenance y política de permisos. La existencia de `stage.py`, `core.py` y `contract.py` no demuestra que pueda ejecutarse como una etapa del pipeline principal.

## Evidencia y gates pendientes

- Código revisado por SFTP read-only el 2026-10-10: `stages/variant_structure_relaxation/{stage.py,core.py,config.py,contract.py}`.
- No se ejecutó el utility, no se creó una variante remota y no se modificó ningún PDB.
- No existe una carpeta equivalente de tests de stage en el inventario remoto; requiere tests de entradas, seguridad de rutas, launcher Slurm, manifest y outputs antes de integrarlo.
- Smoke, baseline, tiempos, provenance y aceptación científica: `NOT RUN`.
