# Stages científicos: contratos de migración (18)

Se mantiene una ficha por cada stage científico registrado en el pipeline principal. Cada ficha conserva el contrato de migración de origen y una sección **CODE REVIEWED IN MN5** basada en `contract.py`, `stage.py`, `config.py`, código de soporte, tests y documentación remota inspeccionados el 2026-10-10. La revisión de código no equivale a un smoke, baseline, resultado científico ni equivalencia empírica: esos gates siguen `NOT RUN`.

Lotes sugeridos: (1) identidad + UniProt; (2) ramas de secuencia/evidencia; (3) topología/AF3/régimen/energía; (4) estructura downstream; (5) BioEmu + ensemble. Estos lotes son de **refactor/validación**, no redefinen el pipeline científico.

`variant_ddg` es opcional y su entrypoint registrado actual usa Rosetta paired WT/MUT; la documentación FoldX que aún existe en el checkout remoto se conserva como legacy y requiere ADR-018. `protein_relaxation_energy` permite `auto`, `foldx`, `rosetta` y `both` (por defecto `both`) y necesita reconciliación de nombres con `reference_preparation` de la arquitectura objetivo PDF.

El inventario consolidado, el pipeline observado, los recursos y las divergencias de contrato están en [`../../../../docs/mn5-stage-code-inventory.md`](../../../../docs/mn5-stage-code-inventory.md). El paquete remoto `variant_structure_relaxation` tiene código y contrato, pero no está en el registry principal; se documenta por separado como utilidad standalone y no como stage 19 del pipeline.
