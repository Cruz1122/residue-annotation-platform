# Especificación del producto final — Target R5

**Estado:** DRAFT, pendiente de aprobación. Describe comportamiento deseado, no software ya implementado.

## Problema

El pipeline produce anotaciones per-residue y artefactos bajo HPC, pero un usuario necesita gestionar sus solicitudes, ver qué resultados son fiables, visualizar las estructuras, consultar el progreso durante cómputos largos y reutilizar cálculos sin duplicarlos ni alterar su interpretación científica.

## Roles previstos

- **Investigador autorizado:** ingesta secuencia, crea/cancela runs según políticas, inspecciona resultados y descarga evidencia.
- **Revisor científico:** valida baseline, schema por stage, correspondencia canónica, reglas y equivalencia tras migración.
- **Operador:** autoriza infra, observa Slurm/GPFS, recupera jobs y restaura/backupea datos.

Proveedor de identidad, scopes, roles institucionales y política de confidencialidad se acuerdan en 0013; no asumir que las proteínas son públicas.

## Recorridos de aceptación de primera prioridad

**P0-01 Ingesta:** Given una secuencia/FASTA válida, When se registra, Then se normaliza sin modificación biológica y una segunda entrada con idéntica secuencia normalizada resuelve la misma proteína interna.

**P0-02 Run asincrónica:** Given protein_id autorizado, When se crea run, Then POST responde con id/estado de manera inmediata y el worker administra la ejecución sin que FastAPI espere AF3.

**P0-03 Reutilización:** Given stage_result previo `success`, cache_key compatible y artefactos válidos, When se programa otra run, Then RunStage referencia el resultado reusable y no copia ni recalcula outputs. Con artefacto ausente o caché inválida, pasa a ejecución.

**P0-04 Información incremental:** Given AF3 running y stage UniProt completado, When se abre detalle, Then existen estados y anotaciones de stages terminados y aviso explícito de faltantes; SSE mantiene la vista sincronizada, con resync tras desconexión.

**P0-05 Modelo 3D:** Given PDB/mmCIF real con cadena, modelo e insertion code, When se selecciona residuo, Then se muestra identidad estructural inequívoca y, **si sólo si** existe mapping validado, `aa_position` canónica, `aa_ref` y annotations; selección desde tracks/tabla hace highlight 3D correcto.

**P0-06 Evidencia honesta:** Given score AF3, topología TM, energía REU, cero válido y NA, When se consultan, Then la UI conserva QC, fuente, unidades y significado: no diagnostica patogenicidad ni confunde confianza, topología, estabilidad, NA y cero.

**P0-07 Fallo/recovery:** Given worker muere tras submit y se reinicia, When vuelve a consultar Slurm, Then no doble-submit, no success parcial y registro auditable. Cancelación requiere permiso.

**P0-08 Aislamiento:** Given usuarios A/B con distinta autorización, When B intenta leer run/artifact de A, Then backend deniega acceso sin filtraciones; límites de cuota impiden jobs HPC no autorizados.

## Features incluidas en R5

`proteins`, `runs`, `stages`, `annotations`, `artifacts`, `viewer`, `authentication/authorization`, `audit`, `worker`, `pipeline`, `cache`, `manifest`, `HPCClient`, `Slurm`, `GPFS`, `SSE`, `operations` y 18 adaptadores de stages científicos.

## No objetivos explícitos

Diagnóstico clínico y reportes de patogenicidad automática; simulación de datos científicos; un motor de gráficos molecular propio; UI conectada directamente a GPFS, Postgres o Slurm; microservicios por capricho; soporte obligatorio de Kubernetes; sugerir que la confianza estructural equivale a estabilidad; correr Docker Compose en nodos de cómputo como requisito.

## Características no funcionales y validación

- **Reproducibilidad:** tags/versiones de código, datasets, manifests, tool_versions, hash de entradas y recursos, output baseline; validación científica por stage.
- **Rendimiento:** medir carga/selección/molde 3D, recursos de navegador, número de residuos/artefactos y tiempos de endpoints no bloqueantes. Umbrales y dispositivos se fijan por ADR tras benchmark.
- **Concurrencia:** test de dos workers, múltiples runs con cache concurrente, caídas/reanudaciones, duplicados y cancelaciones.
- **Seguridad:** pruebas IDOR, authz de artifact, input validation, secretos, cuotas, trazas, prohibición de rutas absolutas y responsabilidad institucional.
- **Accesibilidad:** selección usable desde tabla/secuencia por teclado; estado textual si WebGL falla.
- **Operación:** backup/restore, logs correlacionados, métricas, despliegue staging/prod, rollback, incidente ensayado.

## Salida final verificable

El change `0015-product-release` documenta pruebas E2E **reales** y sign-off científico/operacional. Ninguna fila PASS se genera con esta suite. `specs/TRACEABILITY.md` conserva la matriz por requisito.

## Condiciones del entorno de desarrollo y acceso a fuentes HPC

El desarrollo local es reproducible en **Linux y Windows** sin MN5 utilizando mocks. El equipo o agente **puede necesitar** revisar outputs y organización de archivos reales del pipeline como evidencia de specs o regresión; la inspección utiliza exclusivamente VPN del host + SSH por contraseña + SFTP de **solo lectura** en la raíz GPFS autorizada, cuando BSC y el operador lo permitan. No es una capacidad solicitada para usuarios finales ni habilita endpoints de exploración. La evidencia de MN5 sigue siendo obligatoria en gates científicos/HPC específicos; un mock no la sustituye. Ver [`contracts/mn5-readonly-inspection.md`](contracts/mn5-readonly-inspection.md).
