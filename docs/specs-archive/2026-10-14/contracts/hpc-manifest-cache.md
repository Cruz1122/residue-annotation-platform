# Contrato HPCClient / manifests / caché — DRAFT

Fuentes: `Arquitectura propuesta.pdf`, pp. 3, 5, 7–8; `02-orchestration.md`; `06-runtime.md`.

## HPCClient (backend interno)

`submit(job_spec)`, `status(job_id)`, `cancel(job_id)`, `read_manifest(storage_key)`, `open_artifact(storage_key)`. Transporte aprobado por ADR-001; no servicio público independiente.

## Worker científico MN5

Recibe inputs/recursos materializados; ejecuta un stage; escribe a GPFS:

```text
stage workspace/
  annotations.tsv  # si aplica
  artifacts/...
  provenance.json
  logs/...
  result_manifest.json  # escrito al final
```

El `result_manifest.json` final incluye stage/version, cache_key esperado, hashes y tamaños de inputs/outputs, schema annotations, métricas, exit status, tool/model/resource version, provenance y referencias relativas. **El worker no usa credenciales PostgreSQL.** El worker-orquestador backend valida e ingesta transaccionalmente; crash antes de manifest ≠ success.

## Clave y reuso

```
SHA256(canonical(stage_id, stage_version, source_hash, declared_input_hashes,
                upstream_stage_result_keys, scientific_parameters,
                tool_versions, resource_manifest_hash))
```

**Esta fórmula es orientativa pendiente de ADR-008:** debe reconciliarse con el hash de código y estructura de recursos del pipeline actual, no invalidar ciencia incorrectamente. Cambiar log level o max_parallel no debe modificar la identidad científica. Un hit exige success, clave idéntica y artifacts requeridos verificables (hash o tamaño según la política explícita). Staging + publicación atómica sin overwrite inseguro.

## Política MN5

No desplegar Docker Compose como si fuera un scheduler Slurm. En MN5 cargar `module add hdf5` y `module add python` antes de Python científico. Para AF3 H100 disponible en jobs aprobados, los recursos se asignan bajo Slurm. Dentro de `salloc`, nunca `exit/logout` ni `set -euo pipefail` de riesgo en shell principal; smoke en subshell seguro con STATUS. No relanzar salloc existente ni borrar runs running/desconocidas. Guardar logs/timings y console cuando corresponda.

## Pruebas que bloquean producto final

Submit/status/cancel con job mínimo real; manifiesto ausente/corrupto; cache obsoleta; doble worker; caída GPFS; worker restart; recursos insuficientes; provenance verificable; no fuga de rutas absolutas por API; prueba científica real luego de smoke técnico.

## Perfiles HPC y frontera de inspección (adición)

**HPCClient ejecutor:** mock para desarrollo sin clúster, SSH (VPN del host + SSH por contraseña) para jobs reales autorizados en Linux/Windows, y Slurm native si hay host persistente BSC aprobado. No acoplar el motor del pipeline al mecanismo de red.

**ReadOnlyMN5Inspector técnico:** es independiente, utiliza mock/SFTP read-only/GPFS read-only. Puede consultar **únicamente** `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion` y nunca escribir, enviar/cancelar jobs ni ejecutar comandos remotos. Limitar files, bytes, symlinks, paths y auditoría según [`mn5-readonly-inspection.md`](mn5-readonly-inspection.md). La contraseña SSH personal usada hoy no es equivalente a un permiso OS read-only: se debe acordar la política con BSC.

**Pérdida VPN:** `REMOTE_UNAVAILABLE` en inspección o falta de estado en el cliente ejecutor; jobs ya aceptados en Slurm no se consideran fallidos solo por desconexión. Reconectar y reconciliar, sin reenvíos ciegos.
