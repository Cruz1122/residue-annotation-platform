# Runbook — inspección de lectura en MareNostrum 5

**Estado:** DOCUMENTACIÓN; transporte manual verificado el 2026-10-10; inspector de aplicación y aceptación científica NO EJECUTADOS. Contrato normativo: [`../contracts/mn5-readonly-inspection.md`](../contracts/mn5-readonly-inspection.md).

## Alcance

Raíz autorizada, **solo esta ruta y sus descendientes**:

`/gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion`

El acceso de inspección no autoriza ejecutar pipelines ni crear, modificar, borrar, renombrar, copiar, subir o cambiar permisos de archivos remotos. No inspeccionar carpetas fuera de la raíz aunque la cuenta personal SSH tenga acceso a ellas. Confirmar política BSC para automatización antes de iniciar acceso desatendido.

## Linux local: acceso manual de diagnóstico

1. **VPN en el host, nunca dentro de FastAPI.** OpenFortiVPN configura el túnel PPP y necesita permisos elevados (`sudo`). El usuario VPN puede ser diferente del usuario SSH; la contraseña se solicita interactiva y **no** se incluye en el comando.

   ```bash
   sudo openfortivpn gw.bsc.es:443 --username="<USUARIO_VPN>"
   ```

   Este paso afecta las rutas de red del host. No usar `--password` con contraseña en línea ni deshabilitar la validación del certificado TLS del gateway. Gestionar el ciclo de vida desde el host con autorización humana.

2. **Abrir sesión SFTP de lectura** en otra terminal una vez conectada la VPN. `sftp` usa SSH con autenticación por contraseña para la cuenta reportada. Si la host key es desconocida, verificar su huella por un canal institucional confiable antes de aceptarla.

   ```bash
   sftp bsc001997@glogin4.bsc.es
   ```

3. **Cambiar solo a la raíz autorizada y listar su contenido.** `cd` fija el directorio de trabajo; `pwd` confirma dónde estás; `ls -la` solicita listado y metadatos. Son instrucciones de consulta; no usar `put`, `rm`, `rename`, `mkdir`, `chmod`, ni navegar fuera de la raíz.

   ```text
   sftp> cd /gpfs/projects/bsc08/bsc001997/vcfs_1000geno/hilo_integrado_anotacion
   sftp> pwd
   sftp> ls -la
   ```

   Para leer previews **sin descarga masiva**, preferir un inspector programático SFTP con `open('rb')`, máximo de bytes, rechazo de symlinks y pertenencia por componentes. Evitar ejecutar `ssh "cat ..."` con rutas arbitrarias. Finalizada la inspección, cerrar SFTP sin modificar archivos y detener la VPN desde su propio servicio/terminal cuando corresponda. Nunca tocar `salloc` existente.

## Windows local

El backend corre como contenedores Linux en Docker Desktop/WSL2, pero la VPN se establece con un cliente Windows **aprobado por la institución y fuera del contenedor**. Comprobar DNS/routing a `glogin4.bsc.es` desde el contenedor; que funcione desde Windows no implica que funcione desde Docker/WSL2. No levantar VPN automáticamente dentro de FastAPI. Sin acceso, usar `mock` y marcar validación remota `NOT RUN`.

## Producción BSC

`native` solo si el BSC concede infraestructura **permanente** autorizada (VM/servicio) con GPFS accesible y una identidad que pueda leer, idealmente restringida por permisos del sistema. Un área de GPFS y recursos Slurm no equivalen a hosting público ni implican read-only a nivel OS para la cuenta personal SSH.

## Interfaz read-only del agente

```text
list_directory(relative_path, limit, cursor)
stat_entry(relative_path)
read_preview(relative_path, max_bytes)
```

**No contiene:** SSH remote exec, `sudo`, `sbatch`, `put`, `remove`, `rename`, `open('w')`. Toda ruta se interpreta como POSIX relativa, sin traversal ni symlinks. Archivos secretos/dotfiles denegados por defecto; JSON/TSV/PDB/mmCIF/FASTA/logs solo con límite de bytes y autorización. Fallo VPN/SSH -> `REMOTE_UNAVAILABLE`; sin permisos -> fail-closed. Las pruebas de mutación se ejecutan únicamente en mocks o laboratorio aislado, nunca sobre MN5.

## Evidencias y seguridad

Registrar fecha, commit, operador autorizado, archivo **relativo**, datos inspeccionados mínimos y resultados de solo lectura. Nunca copiar credenciales, contenido privado, rutas ajenas, logs sensibles o grandes artefactos a terceros sin aprobación. El transporte manual de esta guía ya fue verificado con el perfil `glogin4`/`bsc001997`; la interfaz read-only, los casos adversariales, la ejecución científica y los jobs siguen `NOT RUN`. Matriz: [`../tests/mn5-readonly-inspection-matrix.md`](../tests/mn5-readonly-inspection-matrix.md).

## Documentación oficial

- BSC MN5 y cuentas personales: https://www.bsc.es/supportkc/docs/MareNostrum5/logins
- OpenFortiVPN: https://github.com/adrienverge/openfortivpn/blob/master/doc/openfortivpn.1.in
- OpenSSH SFTP: https://man.openbsd.org/sftp
- AsyncSSH/SFTP: https://asyncssh.readthedocs.io/en/latest/api.html
- Arch Linux pacman: https://wiki.archlinux.org/title/Pacman
- Slurm (solo fase independiente de ejecución): https://slurm.schedmd.com/overview.html
