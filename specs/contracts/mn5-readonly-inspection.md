# Contrato de inspección MN5 por VPN + SSH — EXCLUSIVAMENTE SOLO LECTURA

**Estado:** DRAFT / transporte manual verificado; implementación del inspector y aceptación completa **NOT RUN**. **Propósito:** permitir a los agentes de desarrollo e investigadores autorizados consultar evidencias, layouts y artefactos existentes para especificar, implementar y validar la integración. **No es una feature de explorador web para usuarios**. No autoriza alterar datos ni enviar jobs desde el flujo de inspección.

## 1. Alcance autorizado (normativo)

La **única raíz remota inspeccionable** es:

`/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`

Se admiten su contenido y descendientes, incluido `new/` **solo si el servidor permite lectura**. No navegar a directorios padres, hermanos, otros proyectos, `$HOME`, `/tmp`, `/etc`, etc. El prefijo compartido con un directorio hermano **no** da acceso. No inferir permisos o existencia de archivos: verificarlos por operación de lectura aprobada.

**SOLO LECTURA:** consultar nombres, tipos, tamaños, tiempos, listas parciales y bytes de archivos necesarios. Ningún procedimiento del agente debe modificar el filesystem remoto: NO upload, delete, rename, chmod, chown, truncate, append, touch, mkdir, `git pull`, parche, ejecución de script científico, `sbatch`, `scancel`, `salloc`, ni la escritura de un temporal. **El pipeline ejecutado por Slurm en otras fases es un canal diferente** y no recibe autorización por este contrato.

## 2. Acceso real observado y límites

1. **VPN:** se observó la VPN del host activa hacia `gw.bsc.es:443`, con interfaz `ppp0`. La contraseña no se almacena en este repositorio ni se imprime.
2. **SSH/SFTP:** se autenticó correctamente `bsc001997@glogin4.bsc.es` por **contraseña**, sin abrir shell remota. La host key ED25519 `SHA256:c3d+hIywoqNHYQlYsmXFisK3wPXiPoGNS/V5NYFsvlQ` coincidió con `known_hosts`.
3. **Directorio:** `pwd` y los listados confirmaron la raíz literal indicada arriba. Se leyeron código, contratos, documentación y tests dentro del perímetro; no se ejecutaron stages, scripts ni jobs.

La implementación automática del inspector, la aceptación de jobs, la autorización institucional y las políticas BSC **siguen pendientes de aprobación/prueba**. El perfil operativo corregido usa `glogin4.bsc.es`/`bsc001997`; los alias/perfiles anteriores quedan invalidados para esta integración. Las cuentas BSC son personales e intransferibles: no introducir la contraseña personal en CI ni distribuirla a terceros.

## 3. Entornos y estrategia de implementación

| Entorno | Modo normal de desarrollo | Inspección remota opcional | Producción |
| --- | --- | --- | --- |
| Linux local | FastAPI/Astro/worker mock con Compose | VPN con `openfortivpn` en **host** + SSH password + **SFTP read-only** | No aplica |
| Windows local | Contenedores Linux con Docker Desktop/WSL2 | VPN del **host Windows** compatible con BSC + SSH/SFTP password. Validar DNS/rutas desde los contenedores | No aplica |
| Infraestructura BSC autorizada | No presumir Docker en nodos de cómputo | Inspección `native` de GPFS por APIs locales, solo lectura si la identidad del servicio está autorizada | Solo si se concede hosting persistente/VM/servicio independiente de Slurm/GPFS |

`HPCClient` para **ejecutar** jobs tiene perfiles futuros `mock`, `ssh` (VPN/SSH) y `native` (Slurm local autorizado). La herramienta de inspección usa una interfaz **distinta** `ReadOnlyMN5Inspector` con solo `list/stat/read_preview` y drivers `mock`, `ssh_sftp`, `native`. No compartir una abstracción SSH genérica que exponga `exec` dentro de la interfaz de lectura.

**No exigir VPN ni credenciales para desarrollar el scaffold o correr tests/CI**. La inspección remota se usa **cuando hace falta evidencia real**, no como parte automática de instalación, lint, build o test unitario. Sin conectividad, informar `REMOTE_UNAVAILABLE` y marcar gate HPC como `NOT RUN` en vez de inventar archivos.

## 4. Configuración sin credenciales publicadas

Variables *propuestas* a implementar únicamente cuando se apruebe el change correspondiente:

```dotenv
HPC_EXECUTION_MODE=mock
MN5_INSPECTION_MODE=mock
MN5_INSPECTION_ENABLED=false
MN5_READONLY_ROOT=/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion
MN5_VPN_HOST=gw.bsc.es
MN5_VPN_PORT=443
MN5_VPN_REQUIRED=true
MN5_SSH_HOST=glogin4.bsc.es
MN5_SSH_PORT=22
MN5_SSH_USER=bsc001997
MN5_SSH_AUTH_METHOD=password
MN5_SSH_PASSWORD_FILE=/run/secrets/mn5_ssh_password
MN5_SSH_KNOWN_HOSTS_FILE=/run/secrets/mn5_known_hosts
MN5_LIST_MAX_ENTRIES=100
MN5_PREVIEW_MAX_BYTES=1048576
```

- `.env.example` puede contener **solo** valores no sensibles y rutas a secretos; nunca contraseñas. El usuario de VPN puede ser distinto del SSH. No asumir que un archivo `.env` por sí mismo conecta la VPN.
- **La VPN es responsabilidad del host/infraestructura**, no de FastAPI. Evitar `sudo` dentro de backend/worker/contenedores; no poner la contraseña VPN en argumento `--password`, logs o imagen Docker.
- La contraseña SSH se entrega al cliente SFTP desde un almacén/archivo secreto protegido en el sistema local; no pasarla en argumentos de procesos ni exponerla a UI, agentes terceros o herramientas de registro.
- Verificar el certificado TLS del gateway VPN y la identidad del host SSH mediante `known_hosts` obtenido de fuente confiable. Prohibido `known_hosts=None`, `StrictHostKeyChecking=no` o bypass TLS.
- La aceptación de conectividad/uso automatizado o de cuentas de servicio debe venir del BSC. Si no está aprobada, usar mocks y documentar el bloqueo, no eludirlo.

### Perfil de conectividad recibido para este repositorio

El entorno de desarrollo entregó un perfil equivalente con namespace `HPC_*`. Se registra aquí para evitar perder la configuración de operación. El transporte manual de este perfil fue verificado por SFTP el 2026-10-10, pero **no se considera una implementación del inspector ni una prueba de aceptación del producto**:

```dotenv
HPC_VPN_HOST=gw.bsc.es
HPC_VPN_PORT=443
HPC_VPN_USERNAME=mmenaca
HPC_VPN_REQUIRED=true
HPC_SSH_HOST=glogin4.bsc.es
HPC_SSH_PORT=22
HPC_SSH_USERNAME=bsc001997
HPC_SSH_AUTH_METHOD=password
HPC_SSH_PASSWORD_FILE=/run/secrets/hpc_ssh_password
HPC_VPN_PASSWORD_FILE=/run/secrets/hpc_vpn_password
HPC_POLL_INTERVAL_SECONDS=30
```

La correspondencia semántica con el bloque `MN5_*` todavía está abierta: `HPC_SSH_USERNAME` corresponde provisionalmente a `MN5_SSH_USER`, `HPC_*_PASSWORD_FILE` expresa la ubicación de secretos externos y `HPC_POLL_INTERVAL_SECONDS` es una opción de supervisión sin equivalente directo en este contrato. Hasta aprobar esa normalización, los adaptadores no deben aceptar silenciosamente ambos nombres ni elegir uno por precedencia implícita. El transporte observado queda como evidencia manual; los criterios de aceptación de los adaptadores permanecen `NOT RUN`.

## 5. Protocolo normativo de inspección

Preferencia: **SFTP con biblioteca verificada (p. ej. AsyncSSH)**, `listdir/scandir`, `lstat`, `stat`, `realpath` y apertura **exclusiva** `open(path, 'rb')`. Nunca `open('w')`, `open('a')`, `open('r+')`, `mkdir`, `remove`, `rename`, `put`, `setstat`, `chmod` o `ssh.run` en el flujo `ReadOnlyMN5Inspector`. Si SFTP falla, **no** hacer fallback a shell remota.

- Aceptar solo paths **relativos POSIX** derivados de la raíz fija; denegar absolutos y segmentos `..`, caracteres NUL/de control, barras inversas, percent-encoding ambiguo y separadores inesperados. No usar `str.startswith(root)`; comprobar pertenencia por **componentes** tras canonicalizar.
- Resolver y validar la raíz canónica; usar `lstat` para examinar cada componente. Política inicial: **no seguir enlaces simbólicos**, incluso los que apunten dentro de la raíz. Denegar symlinks, archivos especiales, rutas incomprobables y paths con tipos inesperados.
- Verificar antes de abrir y durante lectura cuando sea posible. Validación + apertura puede tener riesgos TOCTOU; no prometer confinamiento irrompible con una cuenta SSH que tenga permisos amplios. Para garantía estricta la identidad del servidor debe estar restringida por ACL/chroot/read-only, sujeta a aprobación BSC.
- Usar listado no recursivo y paginado; previews acotadas y whitelist de formatos científicos (`.pdb`, `.cif`, `.mmcif`, `.tsv`, `.csv`, `.json`, `.fasta`, `.fa`, `.faa`, `.txt`, `.log`, `.md`) con sanitización de contenido. Dotfiles, archivos secretos, llaves y binarios denegados por defecto. No extraer archives automáticamente.
- No hacer escrituras locales **en la raíz remota**. Cuando se necesite comparar artefactos, procesar bytes en memoria o guardar en almacenamiento local de pruebas **si** lo autoriza la política de datos BSC; no copiar datos científicos a servicios externos sin permiso.
- Timeouts, límites por bytes/directorio/concurrencia, registros de auditoría **sin datos sensibles**, y errores diferenciados: VPN/SSH caída (`REMOTE_UNAVAILABLE`), no autorizado, ruta inválida, archivo ausente y preview demasiado grande.

## 6. Separación de funciones y trazabilidad SDD

- **Inspección:** evidencia de archivos reales usada para baseline, contratos, migración y debugging. Solo lectura, ninguna API pública ni privilegio a usuarios de frontend. En el futuro, si se solicita una UI de navegación GPFS, **abrir nueva spec/ADR de producto**; este contrato no la autoriza.
- **Ejecución científica:** `HPCClient.submit/status/cancel` puede requerir escritura GPFS por los stages bajo Slurm, pero **no se llama desde el inspector**; sus permisos y gates son distintos y requieren aprobación específica.
- **Evidencia de pruebas:** sin MN5 activo, registrar `NOT RUN`; con autorización, smoke real con directorio y archivo ya existentes aprobados. Comparar metadata y hashes antes/después **solo leyendo**, sin crear archivos de prueba en remoto.
- **Seguridad:** autenticación SSH por contraseña no convierte automáticamente la cuenta en read-only a nivel OS. El límite de nuestro código no sustituye una ACL de servidor.

## 7. Criterios de aceptación

Los escenarios positivos y negativos están en [`../tests/mn5-readonly-inspection-matrix.md`](../tests/mn5-readonly-inspection-matrix.md). La versión documental puede pasar validación estática sin conectividad; la aceptación real de SSH/SFTP o de jobs requiere conexión BSC y autorización. Todas las pruebas empiezan `NOT RUN`.

## 8. Referencias oficiales

- BSC MN5 login, política de cuentas y transferencia: https://www.bsc.es/supportkc/docs/MareNostrum5/logins
- Manual oficial de OpenFortiVPN (opciones `--config`, `--pinentry` y controles TLS): https://github.com/adrienverge/openfortivpn/blob/master/doc/openfortivpn.1.in
- API oficial de AsyncSSH (SFTP `open('rb')`, `lstat`, `realpath` y SSH): https://asyncssh.readthedocs.io/en/latest/api.html
- Manual oficial de Slurm (referencia exclusiva del **canal de ejecución**, no de inspección): https://slurm.schedmd.com/overview.html
