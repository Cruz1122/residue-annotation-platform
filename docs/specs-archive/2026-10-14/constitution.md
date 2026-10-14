# Constitución SDD — Residue Annotation Platform

**Versión propuesta:** 2.0. **Estado:** DRAFT / pendiente de aprobación humana.

1. **Spec antes de implementación.** Un change necesita propuesta, requisitos MUST observables y escenarios, diseño, tareas trazables, análisis de consistencia y aceptación comprobada. El agente no aprueba su propio trabajo.
2. **Un change, un alcance.** Aprobar ROADMAP no habilita ejecutar todas las fases; se implementa únicamente un change aprobado por vez. El scaffold 0001 no incluye DB, worker, HPC ni viewer.
3. **Modular monolith por features.** Astro frontend y un único backend Python con dos entrypoints web/worker cuando existan; mismo código/Postgres, sin HTTP interno entre procesos ni microservicios ficticios.
4. **Una frontera pública.** La UI consume backend REST/SSE; sin rutas absolutas GPFS ni comandos Slurm, credenciales o acceso DB en cliente.
5. **Ciencia reproducible.** `aa_position` canónica 1-based; merges validan `aa_position` y `aa_ref`; NA ≠ 0. No transformar algoritmos/unidades/thresholds al migrar arquitectura. Un cambio científico requiere spec y regresión separadas.
6. **Topología versus confianza.** Evidencia TM concluyente tiene prioridad donde contrato de structural_regime corresponde; baja confianza AF3 no significa no-transmembrana. AF3 no predice estabilidad, función o patogenicidad por su score de confianza.
7. **Identidad, reuse y manifests.** Protein por secuencia normalizada SHA256. Run es solicitud; stage_result es output reusable. Cache hit solo de success e integridad validada. Manifest final constituye publicación; no success parcial.
8. **Datos y secretos protegidos.** Access control sobre lecturas, cancelación y artefactos en backend; confidencialidad por defecto hasta decidir política de datos. No filtrar secretos en repo, frontend ni logs.
9. **SLURM interactivo seguro.** No iniciar `salloc` si ya existe; no usar `exit/logout` ni `set -euo pipefail` directamente en shell principal con riesgo de cerrar allocation. Parches en subshell, backups, py_compile, tests y smoke antes de costosas corridas; no borrar estados running/desconocidos.
10. **Medir antes de prometer.** Latencia, FPS, throughput, disponibilidad y budget HPC solo con dataset, dispositivo y umbrales aprobados; tests de WebGL, concurrencia y error real.
11. **Evidencia no decorativa.** PASS/FAIL/NOT RUN fieles al entorno; no cambiar specs retroactivamente para hacer aparecer éxito; fakes de unit tests no sustituyen MN5, datasets ni aceptación final.
12. **Contrato versionado.** Schemas de DB, API, stage, cache_key, manifest y export se versionan; breaking changes requieren migration/rollback y ADR.

13. **Inspección científica remota de solo lectura.** Toda consulta opcional de agentes al BSC se restringe a `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`. Solo `list/stat/read_preview`, paths relativos, SFTP read-only, sin `exec`, `upload`, `remove`, `rename`, `chmod`, `mkdir`, `sbatch`, `scancel` ni escrituras remotas. La validación de ruta/symlink no sustituye los permisos OS de BSC.
14. **Separación de transportes y entornos.** Desarrollo Linux/Windows con Compose, mock offline o VPN del host + SSH por contraseña y verificación de host key, sin secrets en repo/logs/frontend. La VPN **no** se arranca desde FastAPI. Producción nativa solo si BSC asigna servicio persistente y confirma políticas, no por mera disponibilidad GPFS/Slurm.

**Excepciones:** documentar requisito, alcance, aprobador, riesgo, compensación, fecha y expiración; nunca invisibilizar desviaciones científicas o filtraciones de datos.

