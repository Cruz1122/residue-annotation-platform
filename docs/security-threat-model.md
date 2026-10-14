# Security threat model

**Status:** draft for independent review. This document describes the current
security boundary; it is not a production sign-off, an institutional BSC
authorization, or a penetration-test report.

**Scope:** the local `residue-annotation-platform` checkout, the Docker
Compose `vpn` profile, the direct `mn5` profile, the application API/worker,
the PostgreSQL database, the artifact store, and the explicitly configured
MareNostrum 5 project root.

## Assets and trust boundaries

| Asset | Sensitivity | Authoritative owner/boundary |
| --- | --- | --- |
| VPN and SSH passwords, `known_hosts`, JWT signing secret and Resend API key | Critical | Host secret files / deployment secret manager; never repository or browser |
| User accounts, password hashes, sessions and one-shot auth tokens | High | PostgreSQL; raw passwords and raw tokens must not be persisted |
| Uploaded FASTA/PDB files and published scientific artifacts | High | Private artifact volume and ownership checks in the API |
| Run, stage, lease, cache and audit records | High | PostgreSQL transactions and server-side authorization |
| MN5 project files and Slurm jobs | High | Configured GPFS root, SSH/Slurm boundary and BSC policy |
| Browser payloads and public URLs | Controlled | API schemas; no filesystem paths, GPFS paths or credentials |

The main trust boundaries are:

1. Browser to API: the browser supplies user input and Bearer credentials;
   authorization, validation and path resolution happen in the backend.
2. API/worker to local storage and PostgreSQL: application code runs with
   bounded inputs, private artifact keys and transactional state changes.
3. VPN container to SSH worker: only the VPN container receives `NET_ADMIN`;
   `worker-vpn` shares its network namespace but runs without extra
   capabilities and receives only the protected SSH material it needs.
4. Worker to MN5: SSH/SFTP/Slurm operates below the configured root. The
   read-only inspector is a separate interface from the job executor and has
   no shell or mutation method.
5. Native worker to MN5: the `mn5` profile assumes the application is already
   running on an authorized MN5 host with local Slurm/GPFS; it does not start
   a VPN or use SSH.

## Threat register

| ID | Threat and abuse case | Current controls | Evidence/status | Residual risk or required action |
| --- | --- | --- | --- | --- |
| T-01 | A secret is exposed through Git, process arguments, logs, HTML or API responses. | External secret files; password-file mode/symlink checks; VPN pinentry; no `.env` mount into application services; sanitized errors; secret scan. | Local secret scan passes; VPN argv tests pass; no sudo credential references remain. **VERIFIED locally.** | Execute secret scan in provider CI and review deployment secret storage. |
| T-02 | Traversal or a symlink escapes the local artifact root or the MN5 root. | Strict storage-key validation; lexical confinement; descriptor-relative `O_NOFOLLOW` traversal for native archives; SFTP `lstat`/stable-metadata checks for every remote component; bounded read-only inspector. | Local adversarial tests pass, including invalid roots, symlinks, bounded directory enumeration and dot-segment paths. **VERIFIED locally.** | SFTP has no atomic `openat` equivalent in the adapter; the remote result tree must be immutable after `DONE`, and any observed metadata change fails closed. Validate that infrastructure guarantee in the authorized deployment. |
| T-03 | User B reads, downloads, cancels or mutates user A's proteins, runs, uploads or artifacts. | Bearer authentication, server-side ownership joins, project checks, production fail-closed behavior, audit events. | HTTP/Bearer and PostgreSQL tests cover two principals. **VERIFIED locally; independent approval pending.** | Repeat the IDOR matrix in an approved staging environment and obtain review sign-off. |
| T-04 | Untrusted values become shell arguments, Slurm options or remote paths. | `shlex.quote`, fixed command shape, validated job IDs, fixed configured root, safe component validation, `sbatch --wrap` with no generated `.sbatch` file. | HPC client and remote-execution integration tests pass; remote CLI contract was inspected read-only. **VERIFIED by code/tests; real job NOT RUN.** | Execute a minimal authorized Slurm smoke and review the deployment configuration. |
| T-05 | A stale worker or replayed remote job revives a cancelled run, double-publishes, or releases another worker's lease. | Transactional claims, `SKIP LOCKED`, lease/heartbeat, poll claim tokens, terminal-state locks, cache namespaces and rollback cleanup. | SQLite and isolated PostgreSQL concurrency suites pass. **VERIFIED locally.** | Validate behavior with a real staging/Slurm job and failure injection. |
| T-06 | VPN/SSH outage is misreported as scientific failure or causes an unsafe resubmit. | Remote polling treats unavailable transport as retryable; job IDs and markers remain durable; automatic VPN service health gates `worker-vpn`; native mode avoids VPN. | Runtime Compose profile is up; code and recovery tests pass. **PARTIAL.** | Test a controlled VPN outage while a real approved job is active. |
| T-07 | A truncated, tampered or stale scientific result becomes a successful public result. | DONE marker, manifest schema, size/SHA-256, provenance hash/JSON, canonical row validation, bounded downloads, atomic storage and transactional publication; public artifact/upload responses stream the same descriptor that was verified, with `O_NOFOLLOW` where available. | Adversarial manifest/provenance/cache tests pass. **VERIFIED at the publication boundary; real scientific output NOT RUN.** | Compare a real stage output with the scientific baseline. |
| T-08 | A compromised or unreliable dependency/CI path ships an unsafe change. | Pinned/declared project tooling, Ruff, tests, Astro check/build, secret scan and local spec validator. | Local checks pass. **PARTIAL.** | Run the provider workflow and review dependency/update policy. |
| T-09 | Uploads, annotations, concurrent runs or remote jobs exhaust resources. | Bounded sequence/upload/result sizes, rate limits, one active run slot per account, CPU/GPU budgets, inflight-stage limits and bounded previews. | Unit and PostgreSQL tests cover the implemented limits. **PARTIAL.** | Obtain an approved operational quota and load/abuse-test it in staging. |
| T-10 | A development inspection path is used as a mutation or credential-sharing path. | `ReadOnlyMN5Inspector` exposes only list/stat/preview; helper uses SFTP read-only; no remote shell/jobs; exact authorized root; host-key rejection. | MN5 preflight, VPN and SFTP read-only inventory succeeded; before/after inventory was identical. **VERIFIED for this review.** | Confirm BSC permission for automated application execution and complete the independent INS matrix. |

## Security decisions and non-goals

- The host-managed VPN is an operational transport, not a FastAPI feature. The
  API and worker do not invoke `sudo`, create PPP interfaces, or read a sudo
  password.
- The `vpn` and `mn5` profiles are separate deployment modes. The workstation
  mode submits through SSH/SCP after the VPN becomes healthy; the direct mode
  runs on MN5 and uses local Slurm/GPFS. They must not be enabled together.
- The read-only inspection credentials and the job-execution credentials are
  separate configuration concerns. Inspection evidence does not authorize a
  scientific job or an upload.
- Scientific adapters, real Slurm execution, SSO/email delivery, Windows/WSL2
  connectivity, provider CI, penetration testing and production approval are
  intentionally not claimed by this document.

## Required approvals before production acceptance

1. Independent security review of T-01..T-10 and the HTTP/Bearer IDOR matrix.
2. BSC/MN5 confirmation of the account, root, host-key, upload and automated
   Slurm permissions.
3. Provider-CI evidence for the mandatory quality and secret checks.
4. Approved staging drills for VPN loss, worker restart, rollback, restore and
   resource exhaustion.
5. Scientific baseline and end-to-end evidence for every published stage.

Until those approvals and executions exist, the related specifications remain
`PARTIAL`, `NOT RUN` or `BLOCKED` as recorded in `specs/changes/*/acceptance.md`.
