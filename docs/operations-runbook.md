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

The executor preserves that boundary explicitly: transport failures while
polling an accepted job or ingesting its result leave the stage retryable and
do not create `remote_result_invalid` or a `StageResult`. A malformed marker,
manifest, provenance record, hash, size, or annotation table remains a
deterministic result-validation failure and is recorded as such. This does not
replace a real VPN/Slurm outage drill; the local regression tests cover the
state-preservation contract only.

### Remote result artifacts

The MN5 pipeline may publish either regular files or directory artifacts. A
regular file is transferred only when its manifest size and SHA-256 match. A
directory artifact is traversed through the confined SFTP/native adapter; the
native adapter uses descriptor-relative no-follow opens, while SFTP validates
stable entry metadata and fails closed when a tree changes during traversal.
Both reject symlinks and special files, create a deterministic `.tar` archive,
and apply both limits below before the artifact is published:

```text
HPC_MAX_RESULT_BYTES       maximum bytes for each downloaded result/archive
HPC_MAX_ARTIFACT_ENTRIES   maximum files and directories in one archive
```

The default entry limit is `10000`. Lower it for a constrained deployment when
the stage contracts permit it; increasing it does not make an unapproved
scientific output safe to publish. Directory artifacts have no producer-side
file hash in the observed `stage-result-v1` contract, so the backend records a
local archive hash and marks the artifact media type as `application/x-tar`.
External annotation paths are rejected until MN5 supplies the same bound
integrity record for them; ordinary annotation tables must remain inside the
stage result directory. The result tree must be immutable after `DONE`; SFTP
does not provide an atomic `openat` equivalent, so that infrastructure
guarantee is part of the authorized deployment gate.
This is an integration boundary, not a substitute for a real authorized stage
smoke on MN5.

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

Artifact and upload downloads verify size and SHA-256 before opening the HTTP
stream and then stream that same open descriptor. This keeps a path replacement
between verification and response delivery from bypassing the recorded
integrity check; Linux uses `O_NOFOLLOW` for the final file component.

Restore only into an isolated PostgreSQL database and an empty artifact
directory that have been selected by the operator:

```bash
DATABASE_URL=postgresql+psycopg://... python scripts/backup_restore.py restore --bundle /path/to/backup-bundle --artifact-root /path/to/empty/restore-artifacts --confirm RESTORE
```

The explicit confirmation is intentional: `pg_restore --clean --if-exists`
changes the target database. A production restore requires an approved
maintenance window, a separate target check, application quiescence, and a
post-restore health/readability check before traffic is pointed at it.

### One-time artifact-volume migration to the non-root worker

The current worker runs as the configured host UID/GID and uses the image's
`app` group (`999:999`) for the artifact volume. A named volume created by a
previous release may contain files owned by the old root worker, so migrate it
once before enabling the non-root `worker-vpn` profile. This operation changes
ownership and group-write bits only; it does not delete or rewrite artifact
contents.

First stop new submissions and take/verify the backup bundle above. Then run
the explicit maintenance container below from the repository root. It uses
temporary `CHOWN`/`FOWNER` capabilities only for this migration; the normal
worker keeps `cap_drop: ALL` and receives no such capabilities:

```bash
docker compose --profile vpn run --rm --no-deps \
  --user 0:0 --cap-add CHOWN --cap-add FOWNER \
  --entrypoint sh worker-vpn -c '
    find /app/data/artifacts -xdev -exec chown --no-dereference 999:999 {} +
    find /app/data/artifacts -xdev -type d -exec chmod g+rwx {} +
    find /app/data/artifacts -xdev -type f -exec chmod g+rw {} +
  '
```

Verify that the artifact root and a representative existing artifact are
readable/writable by the configured non-root worker before restarting the
profile. For a new volume, the image initializes `/app/data/artifacts` with
`999:999` and mode `0770`, so this migration is not required. If the host
secret files are owned by a different UID, set `HPC_WORKER_UID` and
`HPC_WORKER_GID` to that owner before starting the VPN profile; do not loosen
their `0600` mode.

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
docker compose --profile vpn up -d backend worker-vpn frontend
curl --fail-with-body http://localhost:8742/api/v1/health/db
```

For an approved native deployment on a MareNostrum host, use the native
profile instead of the VPN worker:

```bash
COMPOSE_PROFILES=mn5 docker compose up -d db
COMPOSE_PROFILES=mn5 docker compose run --rm migrate
COMPOSE_PROFILES=mn5 docker compose up -d backend worker-mn5 frontend
```

The `vpn` profile is the workstation path: the VPN container owns the PPP
interface and `worker-vpn` shares only that network namespace. The `mn5`
profile is the direct-host path: `worker-mn5` runs with the host's Slurm and
GPFS integration and does not start a VPN or SSH client.

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
rejected before any remote file is opened. Directory listings are non-recursive
and bounded by `MN5_MAX_ENTRIES`; previews are bounded by
`MN5_MAX_PREVIEW_BYTES`.

For Windows development, validate the host VPN route and whether Docker/WSL2
can reach the approved SSH endpoint before enabling the SSH Compose overlay.
If the VPN route is unavailable from the container, report a preflight block;
do not infer a failed scientific job and do not copy a personal password into
the container image or CI.
