# Residue Annotation Platform

Plataforma para registrar secuencias de proteínas, crear corridas persistidas y consultar estados, anotaciones parciales y artefactos autorizados. El repositorio contiene un frontend Astro/Preact y un backend FastAPI/SQLAlchemy organizado por features.

El contrato de producto y sus límites están en [`ROADMAP.md`](ROADMAP.md) y [`specs/`](specs/). El checkout implementa el plano de identidad, runs, DAG persistente, API REST/SSE, almacenamiento de artefactos, caché/manifiestos y fronteras HPC; la ciencia de los 18 stages y la aceptación E2E sobre MN5 siguen pendientes. El worker no publica éxitos científicos inventados cuando no existe un adapter revisado.

## Puertos y servicios

Los puertos de desarrollo definidos para este proyecto son deliberadamente:

- frontend: `4742`
- backend: `8742`

`docker compose up --build` levanta PostgreSQL, las migraciones Alembic, la API, el worker y el frontend. Sin el worker una corrida queda en `pending` y ocupa el cupo de una corrida activa. `compose.ssh.yml` es el único overlay extra: monta la contraseña SSH y `known_hosts` sólo cuando se pide un submit autorizado.

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
├── compose.yml                   # Postgres, migraciones, API, worker y frontend
├── compose.ssh.yml               # overlay explícito para SCP autorizado
├── scripts/validate_specs.py     # validación documental estática
└── specs/
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
# worker
# frontend
```

Ese arranque usa `APP_ENV=development` salvo que el entorno lo cambie. La contraseña local de Postgres es `residue-dev` si `POSTGRES_PASSWORD` no está definida. No cambia los puertos públicos `4742/8742`. Para detener el stack usa `docker compose down`. No uses `down -v` si necesitas conservar PostgreSQL y los artefactos.

Para habilitar únicamente la transferencia SCP de uploads pequeños en un entorno autorizado, prepara un archivo de password SSH y un `known_hosts` verificado fuera del repositorio y ejecuta el overlay explícito:

```bash
HPC_SSH_HOST=glogin4.bsc.es \
HPC_SSH_USERNAME=bsc001997 \
HPC_REMOTE_ROOT=/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion \
HPC_SSH_PASSWORD_FILE=/ruta/local/hpc_ssh_password \
HPC_KNOWN_HOSTS_FILE=/ruta/local/known_hosts \
docker compose -f compose.yml -f compose.ssh.yml up --build
```

El overlay sólo configura el worker; no habilita el inspector read-only ni autoriza jobs científicos por sí mismo.

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

Para una run también se pueden subir inputs pequeños mediante `POST /api/v1/uploads` con `input_type=fasta` o `input_type=structure` (`.pdb/.cif/.mmcif`). La run acepta los `upload_ids` resultantes; el worker sólo usa SCP cuando `HPC_INPUT_TRANSFER_ENABLED=true` y el perfil SSH está explícitamente configurado.

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
```

Frontend:

```bash
cd frontend
corepack pnpm check
corepack pnpm build
```

Validación documental:

```bash
python scripts/validate_specs.py
```

Estos checks no requieren VPN, GPU, secretos, `SLURM_JOB_ID` ni acceso a MN5. Los checks técnicos offline no sustituyen el smoke autorizado de Slurm/GPFS ni la regresión científica.

## Configuración y seguridad

`.env.example` sólo contiene valores de desarrollo y referencias a ficheros de secretos externos. `.env`, `run/secrets/`, bases SQLite, artefactos y salidas de build están ignorados por Git. La autenticación de desarrollo usa una identidad local configurable; en `APP_ENV=production` faltan `X-User-Id` y `X-Project-Id` y el backend falla cerrado. La autorización se comprueba al leer proteínas, runs y artefactos.

La autenticación de cuenta usa Bearer tokens en producción; el fallback por headers sólo existe en development/test. Los refresh tokens y tokens de verificación/reset se almacenan únicamente como hashes, los passwords se derivan con scrypt y las acciones de auth generan auditoría sin secretos. La verificación y recuperación se entregan mediante Resend cuando `EMAIL_PROVIDER=resend`; la API key permanece en el entorno y `EMAIL_FROM` debe usar un dominio verificado en producción. La regla de dominio es máximo una run no terminal por usuario. La VPN se establece fuera de FastAPI. La inspección MN5, cuando esté autorizada, utiliza la interfaz separada `ReadOnlyMN5Inspector`, paths relativos y SFTP sin shell ni operaciones de escritura. Los uploads de run sólo se transfieren por SCP con perfil SSH explícito; consultar la spec 0016 y [`specs/contracts/mn5-readonly-inspection.md`](specs/contracts/mn5-readonly-inspection.md).

## Límites actuales

- Los 18 stages están registrados con dependencias, recursos y columnas; no hay adapters científicos ejecutables aprobados en este checkout.
- El worker falla de forma auditable cuando no existe un executor real; no crea anotaciones ni artefactos sintéticos.
- La integración SSH/native y el inspector SFTP tienen fronteras de seguridad, pero el smoke autorizado de Slurm/MN5 y la regresión científica permanecen `NOT RUN`.
- El visor no infiere `aa_position` canónica a partir de un número de residuo estructural; requiere mapping publicado por el pipeline.
- El release final, backup/restore, cuotas completas, auditoría de producción y E2E científico están pendientes según las acceptance de cada change.
- La suite de autenticación y el adaptador Resend están implementados localmente, pero la spec 0016 permanece `PENDING`: entrega real de email, SSO, IDOR independiente con dos principals PostgreSQL, secret scan, threat model y SCP autorizado aún requieren evidencia externa. Los tests de concurrencia PostgreSQL están implementados, pero en esta verificación quedan `NOT RUN` porque `POSTGRES_TEST_DATABASE_URL` no está configurada.
