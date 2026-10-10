# Estado de implementación del checkout

**Fecha de corte:** 2026-10-10  
**Commit observado:** `e3c69c8`  
**Regla:** la existencia de una demo mock o de una fixture local no equivale a aceptación científica, integración MN5 ni producto final.

Este resumen complementa las `acceptance.md` de cada change. Los estados `PASS (local)` y `PARTIAL` describen evidencia reproducible del checkout; no sustituyen el gate humano de aprobación ni convierten un requisito de MN5 en PASS.

| Área | Estado observado | Evidencia |
| --- | --- | --- |
| Scaffold local | Parcialmente verificado | Compose con `frontend`/`backend`, health real y build local; la UI inicial no consume health y los puertos actuales son `4742/8742`, no `4321/8000` |
| Calidad | Parcialmente verificada | `astro check`, `astro build`, compilación Python y validación SDD pasan; pytest, Ruff y CI no están configurados/verificados |
| Visor molecular | Prototipo funcional mock | Mol* carga el PDB local de P01130 y la selección muestra anotaciones mock; no hay benchmark, mmCIF ambiguo ni mapping canónico validado |
| Biblioteca/progreso/información | Prototipo funcional mock | Hay biblioteca, pipeline de 18 stages, 18 paneles de stage y enlaces a 56 artefactos locales |
| Identidad, runs y API de dominio | No implementado | El backend solo expone `/api/v1/health`; no hay DB, endpoints de proteínas/runs, worker ni SSE |
| 18 stages científicos | Fichas y código remoto revisados; integración local pendiente | Se representan 18 IDs y existen 59 archivos mock en el checkout; en MN5 se revisaron 18 contratos/entrypoints/configs y tests. No hay adapters ejecutables locales, baseline MN5, smoke ni regresión científica |
| HPC/MN5 | Integración de producto pendiente; inspección de código verificada | No existe `HPCClient` ni `ReadOnlyMN5Inspector` en este checkout. La VPN y SFTP hacia `bsc001997@glogin4.bsc.es` fueron verificadas de forma read-only; se observó la raíz remota, 19 paquetes de stage, 18 IDs registrados, documentación y tests |

## Evidencia local reproducida

```text
python scripts/validate_specs.py              PASS
docker compose config --services              PASS: backend, frontend
docker compose up --build -d                  PASS
curl http://localhost:8742/api/v1/health      PASS: 200 {"status":"ok"}
curl http://localhost:4742/                   PASS: 200
corepack pnpm check                           PASS
corepack pnpm build                           PASS
python -m compileall -q backend/app            PASS
```

La revisión visual local verificó además 18 nodos de progreso, 18 paneles de información, 56 enlaces de artefacto y selección del residuo `M MET 1` en el visor con un panel etiquetado `MOCK`.

## Evidencia MN5 obtenida y pendiente

La VPN quedó activa con `ppp0`; el perfil corregido `glogin4.bsc.es` resolvió y aceptó TCP/22. La host key ED25519 observada coincide con `~/.ssh/known_hosts` y el intento SFTP con `bsc001997` fue exitoso. La raíz `/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion` fue listada y se leyeron de forma acotada código, contratos, documentación y tests. El inventario está en [`docs/mn5-stage-code-inventory.md`](../docs/mn5-stage-code-inventory.md).

La ruta absoluta `/run/secrets/hpc_ssh_password` sigue ausente; el fichero local ignorado usado para autenticación tiene modo `0600`. No se leyó ni registró contenido secreto. No se ejecutaron shell remota, stages, jobs Slurm ni operaciones de escritura.

La inspección remota del **código** ya tiene evidencia; la aceptación de `ReadOnlyMN5Inspector`, el acceso a Slurm, la ejecución científica y la validación de resultados continúan en `NOT RUN` en [la matriz MN5](tests/mn5-readonly-inspection-matrix.md). La información del pipeline real está documentada sin convertirla en evidencia de resultados.
