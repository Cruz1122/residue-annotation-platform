# Operations runbook

This runbook covers the local application boundary and the hand-off to an
approved BSC/MN5 operator. It does not turn Docker Compose into a production
Slurm deployment, and it never treats an offline adapter as scientific
evidence.

## Health and correlation

The liveness and database readiness checks are:

```bash
curl --fail-with-body http://localhost:8742/api/v1/health
curl --fail-with-body http://localhost:8742/api/v1/health/db
curl --fail-with-body http://localhost:8742/api/v1/metrics
```

The worker emits JSON `worker_event` records with `run_id`, `stage_id`, and,
when a remote stage exists, `job_id`. Error text is deliberately omitted from
these correlation records; the durable stage fields retain the sanitized
`error_code`/`error_message`. The metrics endpoint contains only aggregate
counters and stage/status labels, not run or job identifiers.

A VPN or SFTP outage is a remote-availability event. It must not be converted
into a Slurm job failure or trigger an automatic resubmission. The next worker
poll reconciles the accepted job after connectivity returns.

## Backup and restore

`scripts/backup_restore.py` creates a custom-format PostgreSQL dump and an
artifact inventory. To make a self-contained drill bundle, include the
artifact snapshot explicitly:

```bash
DATABASE_URL=postgresql+psycopg://... python scripts/backup_restore.py backup --artifact-root /path/to/artifacts --output /path/to/new/backup-bundle --copy-artifacts
python scripts/backup_restore.py verify --bundle /path/to/backup-bundle
```

The database URL is read from the environment and is never written to the
manifest or printed. The bundle records hashes and relative artifact names,
not GPFS paths for public consumption. A reference-only bundle is still
useful for a storage-provider snapshot, but it cannot be restored by this
script until an artifact snapshot is present.

Restore only into an isolated PostgreSQL database and an empty artifact
directory that have been selected by the operator:

```bash
DATABASE_URL=postgresql+psycopg://... python scripts/backup_restore.py restore --bundle /path/to/backup-bundle --artifact-root /path/to/empty/restore-artifacts --confirm RESTORE
```

The explicit confirmation is intentional: `pg_restore --clean --if-exists`
changes the target database. A production restore requires an approved
maintenance window, a separate target check, application quiescence, and a
post-restore health/readability check before traffic is pointed at it.

## Controlled deployment and rollback

Before a rollout, record the image/source revision, run the local quality
gates, render the Compose configuration, and apply migrations as a separate
step. The service order is `db → migrate → backend/worker → frontend`; a
migration failure must stop the rollout.

```bash
docker compose config --services
docker compose -f compose.yml config
docker compose up -d db
docker compose run --rm migrate
docker compose up -d backend worker frontend
curl --fail-with-body http://localhost:8742/api/v1/health/db
```

Rollback is a deployment decision, not a blind database downgrade. First stop
new submissions, preserve active-run state, and determine whether the release
changed schema or scientific contracts. Restore the last compatible image and
use a tested database/artifact recovery plan; do not delete active runs or
remote result directories as part of a routine rollback.

## MN5 hand-off

The host VPN is established outside FastAPI. The read-only inspection path is
limited to the configured project root and uses SFTP with a verified
`known_hosts` file. It may list/stat/read previews but cannot submit, cancel,
write, rename, or execute remote commands. Slurm submit/status/cancel is a
separate `HPCClient` boundary and requires independent BSC authorization.

Read previews are deliberately narrower than metadata inspection. Only
scientific/text suffixes (`.pdb`, `.cif`, `.mmcif`, `.tsv`, `.csv`, `.json`,
`.fasta`, `.fa`, `.faa`, `.txt`, `.log`, `.md`) are accepted; dotfiles,
secret-like names, binary files, special files, symlinks, traversal, backslash,
percent-encoded, control-character, and duplicated-separator paths are
rejected before any remote file is opened.

For Windows development, validate the host VPN route and whether Docker/WSL2
can reach the approved SSH endpoint before enabling the SSH Compose overlay.
If the VPN route is unavailable from the container, report a preflight block;
do not infer a failed scientific job and do not copy a personal password into
the container image or CI.
