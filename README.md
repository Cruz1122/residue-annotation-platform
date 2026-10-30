# Residue Annotation Platform

Plataforma para registrar secuencias de proteínas, crear corridas persistidas y consultar estados, anotaciones parciales y artefactos autorizados. El repositorio contiene un frontend Astro/Preact y un backend FastAPI/SQLAlchemy organizado por features.

El contrato funcional activo está en [`01 — Entrada y configuración`](specs/01-entrada-configuracion.md), [`02 — Ejecución científica en MareNostrum 5`](specs/02-ejecucion-cientifica.md) y [`03 — Seguimiento y resultados`](specs/03-seguimiento-resultados.md). El [`ROADMAP.md`](ROADMAP.md) y el [archivo histórico de specs](docs/specs-archive/2026-10-14/) conservan contexto anterior. El checkout implementa el plano de identidad, runs, DAG persistente, API REST/SSE, almacenamiento de artefactos, caché/manifiestos y fronteras HPC; la ciencia de los 18 stages y la aceptación E2E sobre MN5 siguen pendientes. El worker no publica éxitos científicos inventados cuando no existe un adapter revisado.

## Puertos y servicios

Los puertos de desarrollo definidos para este proyecto son deliberadamente:

- frontend: `4742`
- backend: `8742`

`compose.yml` soporta dos perfiles de ejecución HPC; se debe activar uno según dónde corre el stack. `vpn` es el modo de workstation: levanta la VPN, espera el endpoint SSH de MareNostrum y usa SSH/SCP para transferir y enviar automáticamente las runs validadas a Slurm. `mn5` es el modo directo: se ejecuta dentro de MareNostrum, no levanta VPN ni usa SSH y llama al Slurm local sobre el GPFS montado. PostgreSQL, migraciones, API y frontend son comunes a ambos perfiles. Los workers usan `restart: unless-stopped`; los demás servicios requieren `docker compose up` y no tienen una política de reinicio configurada.

```text
residue-annotation-platform/
├── backend/
│   ├── app/core/                 # configuración, auth local y DB
│   ├── app/features/             # health, proteins, runs, stages, annotations, artifacts
│   ├── app/infrastructure/hpc/   # disabled, offline-test, SSH/native y SFTP read-only
│   ├── alembic/                  # migraciones versionadas
│   └── tests/
├── frontend/
│   ├── src/features/             # superficies por dominio
│   └── src/shared/api/           # cliente tipado de FastAPI
├── compose.yml                   # Perfiles VPN/MN5, Postgres, API, workers y frontend
├── infra/mn5-vpn/                # cliente VPN aislado y pinentry sin logs
├── scripts/secret_scan.py        # escaneo local de secretos
└── specs/
    ├── 01-entrada-configuracion.md
    ├── 02-ejecucion-cientifica.md
    └── 03-seguimiento-resultados.md
```

No se versionan datos de ejemplo, PDB/FASTA ficticios, previews, artefactos estáticos ni sesiones locales. La UI sólo muestra lo que devuelve el backend. La ejecución remota permanece `disabled` por defecto y no es una fuente de datos sintéticos ni un resultado científico.

## Arranque local con Docker

Requisitos: Docker Engine con Compose y puertos `4742` y `8742` libres.

```bash
cp .env.example .env
docker compose up --build
```

URLs:

| Servicio | URL |
| --- | --- |
| Frontend | <http://localhost:4742> |
| OpenAPI | <http://localhost:8742/docs> |
| Health | <http://localhost:8742/api/v1/health> |
| Health de DB | <http://localhost:8742/api/v1/health/db> |

Comprobación rápida:

```bash
curl --fail-with-body http://localhost:8742/api/v1/health
# {"status":"ok"}
docker compose config --services
# db
# migrate
# backend
# frontend
```

Ese arranque usa `APP_ENV=development` salvo que el entorno lo cambie. La contraseña local de Postgres es `residue-dev` si `POSTGRES_PASSWORD` no está definida. No cambia los puertos públicos `4742/8742`. Para detener el stack usa `docker compose down`. No uses `down -v` si necesitas conservar PostgreSQL y los artefactos.

Si vienes de una versión donde el worker corría como `root`, ejecuta una vez
la migración documentada de permisos del volumen `residue-artifacts` en
[`docs/operations-runbook.md`](docs/operations-runbook.md) antes de activar el
worker no-root. La migración preserva los contenidos y no es necesaria para un
volumen nuevo.

Para arrancar manualmente el perfil VPN, configura una sola vez en `.env` los paths host de los secretos y del `known_hosts` verificado. No pongas passwords en `.env`, en argumentos de proceso ni en el repositorio:

```bash
COMPOSE_PROFILES=vpn \
HPC_EXECUTION_MODE=ssh \
HPC_VPN_HOST=gw.bsc.es \
HPC_VPN_PORT=443 \
HPC_VPN_USERNAME=<vpn-user> \
HPC_VPN_CONFIG_FILE=/ruta/local/openfortivpn.conf \
HPC_VPN_PASSWORD_FILE=/ruta/local/hpc_vpn_password \
HPC_SSH_HOST=glogin4.bsc.es \
HPC_SSH_USERNAME=bsc001997 \
HPC_SSH_PASSWORD_FILE=/ruta/local/hpc_ssh_password \
HPC_KNOWN_HOSTS_FILE=/ruta/local/known_hosts \
docker compose up --build -d
```

El password de VPN puede vivir en un archivo de una sola línea con permisos `0600`, o en un archivo de configuración `openfortivpn` protegido. El servicio `vpn` es el único que recibe `NET_ADMIN`; `worker-vpn`, `worker-vpn-snapshots` y `worker-vpn-executor` ejecutan como el UID no root configurado en `HPC_WORKER_UID`, que debe ser propietario de los secretos protegidos, y usan el GID interno `HPC_APP_GID` para compartir artefactos privados con el backend. `worker-vpn-snapshots` actualiza los estados de etapa desde `run_context.json`; `worker-vpn` publica manifiestos y artefactos verificados sin reenviar jobs; `worker-vpn-executor` procesa las corridas normales. El backend, frontend y los workers nunca reciben `NET_ADMIN`, no tienen red directa al host y sólo los workers montan, en modo lectura, el password SSH y `known_hosts`; no se monta `.env` ni el filesystem del host.

### Ejecución directa en MareNostrum

El perfil `mn5` se usa en el host de MareNostrum donde ya están disponibles Docker, el GPFS y la autenticación local de Slurm. El worker nativo debe usar una imagen previamente preparada en MN5 con la aplicación, sus dependencias Python y los clientes `sbatch`, `squeue`, `sacct` y `scancel`. El perfil monta el root GPFS, `/etc/slurm` y `/run/munge` de forma explícita; si alguno falta, el worker termina sin intentar una ejecución incompleta.

```bash
# Ejecutar en MareNostrum; activar sólo este perfil.
COMPOSE_PROFILES=mn5 \
HPC_NATIVE_WORKER_IMAGE=residue-annotation-platform-worker-native \
HPC_NATIVE_UID=<uid-de-la-cuenta-mn5> \
HPC_NATIVE_GID=<gid-de-la-cuenta-mn5> \
docker compose up --build -d
```

En este modo no se configuran `HPC_VPN_*`, `HPC_SSH_*`, archivos de passwords ni `known_hosts`. El worker fija `HPC_EXECUTION_MODE=native` y ejecuta `sbatch --wrap` directamente en el entorno local de Slurm; la aplicación no crea ni deja un archivo `.sbatch` local. En el modo `vpn`, el worker fija `HPC_EXECUTION_MODE=ssh` y el túnel VPN es una dependencia de salud; no se deben activar ambos perfiles a la vez.

Antes de cualquier `sbatch`, el worker ejecuta un preflight persistido sobre la
configuración confirmada, los hashes de inputs, dependencias, accession,
recursos y capacidades aprobadas. Los requisitos externos (`external_cache`,
MaveDB, homología y `msa_cache:*`) sólo se preparan cuando el stage
seleccionado los necesita. Para habilitar esa preparación, el operador debe
validar en el checkout de MN5 un comando con `{accession}` y
`{requirements}`, y configurarlo como `HPC_PIPELINE_PREFETCH_COMMAND`. Su
última línea debe devolver un acknowledgement JSON con `status=success` y
exactamente los requisitos solicitados; si no está configurado, no reconoce
algún requisito o falla, la etapa queda en `ready` con preparación bloqueada y
no se envía ningún job. El comando no se acepta desde el payload del usuario.
Los requisitos locales adicionales se declaran mediante
`HPC_AVAILABLE_TECHNICAL_REQUIREMENTS` sólo después de comprobarlos en el
host autorizado.

## Desarrollo sin Docker

Backend, Python 3.12 y `uv`:

```bash
cd backend
uv sync --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8742
```

Frontend, Node `>=22.12.0` y pnpm mediante Corepack:

```bash
cd frontend
corepack pnpm install
PUBLIC_API_BASE_URL=http://localhost:8742/api/v1 corepack pnpm dev --host 0.0.0.0 --port 4742
```

La URL browser-side se configura mediante `PUBLIC_API_BASE_URL`; el valor de ejemplo es `http://localhost:8742/api/v1`. CORS acepta por defecto `http://localhost:4742`. No se debe poner una URL `backend:8742` en la configuración que consume el navegador del host.

## Flujo implementado

1. En `/` se registra una secuencia FASTA real o se lee un archivo local en el navegador.
2. El frontend hace `POST /api/v1/proteins` y después `POST /api/v1/runs`; `sessionStorage` sólo conserva la sesión Bearer real de la cuenta.
3. `/proteins/{id}/progress/?run={run_id}` abre el stream SSE autenticado de estado persistido y vuelve automáticamente a GET/polling si el stream se corta o el navegador no puede consumirlo.
4. `/proteins/{id}/info/?run={run_id}` muestra únicamente filas de anotación y artefactos publicados por el backend; `NA`, pendiente, fallido y ausencia de evidencia no se convierten en cero.
5. `/proteins/{id}/viewer/?run={run_id}` muestra la secuencia registrada y carga Mol* con un artefacto PDB/mmCIF publicado o, si todavía no existe, con el upload de estructura de esa corrida. Sin estructura se informa que no está disponible.
6. `/proteins/` consulta el catálogo privado mediante `GET /api/v1/proteins`.

Para una run también se pueden subir inputs pequeños mediante `POST /api/v1/uploads` con `input_type=fasta` o `input_type=structure` (`.pdb/.cif/.mmcif`). La run acepta los `upload_ids` resultantes; con el stack único, el worker transfiere los inputs por SCP y envía las etapas a Slurm sin un comando adicional del usuario.

Endpoints principales:

```text
GET  /api/v1/health
GET  /api/v1/health/db
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/verify-email
POST /api/v1/auth/reset-password
POST /api/v1/auth/reset-password/confirm
POST /api/v1/auth/change-password
GET  /api/v1/auth/users                     # admin
PATCH /api/v1/auth/users/{user_id}/role     # admin
POST /api/v1/proteins
GET  /api/v1/proteins
GET  /api/v1/proteins/{id}
POST /api/v1/uploads
GET  /api/v1/uploads/{id}
GET  /api/v1/uploads/{id}/content
POST /api/v1/runs
GET  /api/v1/runs/{id}
GET  /api/v1/runs/{id}/stages
GET  /api/v1/runs/{id}/events
GET  /api/v1/runs/{id}/annotations
POST /api/v1/runs/{id}/cancel
GET  /api/v1/artifacts/{id}
GET  /api/v1/artifacts/{id}/content
```

El registro siempre crea el rol `user`. El primer `admin` se promueve de forma explícita sobre una cuenta activa y verificada; después los administradores gestionan roles desde `/auth/users/`:

```bash
cd backend
uv run python -m app.manage bootstrap-admin --email admin@example.com
```

## Verificación

Backend:

```bash
cd backend
uv run ruff check app alembic tests
uv run ruff format --check app alembic tests
uv run pytest -q
# Optional: PostgreSQL concurrency tests (run-slot unique, remote poll claim,
# refresh rotation race, logout race, rate-limit bucket race, and invariants).
POSTGRES_TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/db uv run pytest -q

# Compare two local stage annotation tables. The command reports exact
# differences and exits 1 when outputs differ; it never signs off scientific
# equivalence by itself. Keep NA distinct from numeric zero and provide any
# numeric tolerance explicitly.
uv run python -m app.features.runs.science_diff \
  /path/to/baseline/annotations.tsv \
  /path/to/candidate/annotations.tsv \
  --absolute-tolerance 0.001
```

Frontend:

```bash
cd frontend
corepack pnpm check
corepack pnpm build
```

Estos checks no requieren VPN, GPU, secretos, `SLURM_JOB_ID` ni acceso a MN5. Los checks técnicos offline no sustituyen el smoke autorizado de Slurm/GPFS ni la regresión científica.

## Configuración y seguridad

`.env.example` sólo contiene valores no secretos y referencias a ficheros externos. `.env`, `run/secrets/`, bases SQLite, artefactos y salidas de build están ignorados por Git. Las credenciales no se pasan en argumentos ni se registran: Compose monta sólo los archivos necesarios como read-only. El contenedor VPN se limita a `NET_ADMIN` y `DAC_READ_SEARCH` para leer su secreto local protegido; el worker corre como usuario no root, sin capabilities adicionales y sin `NET_ADMIN`. El backend y frontend no reciben capabilities Linux adicionales, el root filesystem de los servicios sensibles es read-only y la verificación SSH exige `known_hosts`; una clave ausente o cambiada hace fallar cerrado. La autenticación de desarrollo usa una identidad local configurable; en `APP_ENV=production` faltan `X-User-Id` y `X-Project-Id` y el backend falla cerrado. La autorización se comprueba al leer proteínas, runs y artefactos.

La autenticación de cuenta usa Bearer tokens en producción; el fallback por headers sólo existe en development/test. En producción, `AUTH_JWT_SECRET` debe ser explícito y tener al menos 32 caracteres, y `CORS_ORIGINS` debe contener únicamente orígenes HTTPS concretos, sin wildcard. Los refresh tokens y tokens de verificación/reset se almacenan únicamente como hashes, los passwords se derivan con scrypt y las acciones de auth generan auditoría sin secretos. La verificación y recuperación se entregan mediante Resend cuando `EMAIL_PROVIDER=resend`; la API key permanece en el entorno y `EMAIL_FROM` debe usar un dominio verificado en producción. La regla de dominio es máximo una run no terminal por usuario. La VPN se establece en un contenedor separado del backend y sólo ese contenedor recibe `NET_ADMIN`. La inspección MN5, cuando esté autorizada, utiliza la interfaz separada `ReadOnlyMN5Inspector` y el factory `build_read_only_inspector`, que exige habilitación explícita y selecciona `mock`, `ssh_sftp` o `native` sin fallback implícito; todos los drivers usan paths relativos y exponen sólo lectura, sin shell ni operaciones SFTP de escritura. Los uploads de run se transfieren por SCP con host keys verificadas y se materializan bajo un namespace `uploads/platform-run-<run_id>` aislado de las entradas preexistentes de la accesión; consultar [`02 — Ejecución científica en MareNostrum 5`](specs/02-ejecucion-cientifica.md), el [threat model](docs/security-threat-model.md) y el [contrato histórico de inspección MN5](docs/specs-archive/2026-10-14/contracts/mn5-readonly-inspection.md).

## Límites actuales

- Los 18 stages están registrados con dependencias, recursos y columnas; no hay adapters científicos ejecutables aprobados en este checkout.
- El worker falla de forma auditable cuando no existe un executor real; no crea anotaciones ni artefactos sintéticos.
- La integración SSH/native y los inspectores read-only tienen fronteras de seguridad; el stack ya tiene los caminos automáticos VPN → SSH/SCP → Slurm y ejecución native → Slurm/GPFS local, pero la regresión científica y la comparación contra un baseline siguen requiriendo evidencia de resultados reales.
- El visor no infiere `aa_position` canónica a partir de un número de residuo estructural; requiere mapping publicado por el pipeline.
- El release final, backup/restore, cuotas completas, auditoría de producción y E2E científico están pendientes según las acceptance de cada change.
- La suite de autenticación y el adaptador Resend están implementados localmente, pero el material histórico de inputs/concurrencia permanece `PENDING`: entrega real de email, SSO, IDOR independiente con dos principals PostgreSQL, threat model y SCP autorizado aún requieren evidencia externa. Los tests de concurrencia PostgreSQL están implementados y pasan contra PostgreSQL 16 aislado; el secret scan local pasa, pero su ejecución en el proveedor CI sigue pendiente. El contexto archivado está en `docs/specs-archive/2026-10-14/changes/0016-auth-account-security/`.
