# 0012 — Explorer 3D + secuencia + anotaciones

**Estado:** DRAFT — NO APROBADO — NO IMPLEMENTADO. **Fase:** F5 Experiencia. **Dependencias:** `0003`, `0010`, `0011`.

## Contexto y dirección técnica (HOW)

Mol* u opción tras benchmark; mapping PDB/mmCIF canónico validado; tracks per-residue, selección bidireccional y UI Astro islands.

## Decisiones y trade-offs

- Features agrupan lógica de dominio; `core/`, `db/`, `infrastructure/` solamente para dependencias transversales reales.
- Frontend no habla con SLURM/GPFS y los dos procesos backend no se comunican por HTTP.
- Tests usan fixtures/fakes en niveles unitarios; gates HPC/científicos exigen datos y ejecución reales.

## Riesgos

Mapeo autor/label, insertion codes, múltiples cadenas y latencia WebGL.

## Rollback / migración

Changes pequeños, compatibilidad versionada y rollback documentado. Si modifica DB, migration y backup previo; si modifica stages, baseline, smoke y no eliminar runs activas.

## Decisiones pendientes

Revisar `specs/DECISIONS.md`. No fijar transporte MN5, SSO, benchmark o naming científico mediante supuestos.

## Límite de la inspección técnica

La inspección opcional de carpetas MN5 en las specs de desarrollo **no exige una UI de exploración de GPFS**, endpoints GET arbitrarios ni acceso SSH del navegador. La visualización molecular del producto consume artefactos autorizados por su ID o fixtures aprobados. El acceso técnico de agentes por VPN+SSH+SFTP solo lectura se rige por `specs/contracts/mn5-readonly-inspection.md`.
