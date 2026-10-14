from app.core.config import Settings
from app.infrastructure.hpc.base import HPCClient
from app.infrastructure.hpc.disabled import DisabledHPCClient
from app.infrastructure.hpc.native import NativeSlurmClient
from app.infrastructure.hpc.offline import OfflineHPCClient
from app.infrastructure.hpc.ssh import SSHSlurmClient


def build_hpc_client(settings: Settings) -> HPCClient:
    if settings.hpc_execution_mode == "mock":
        return OfflineHPCClient()
    if settings.hpc_execution_mode == "native":
        return NativeSlurmClient()
    if settings.hpc_execution_mode == "ssh":
        return SSHSlurmClient(settings)
    return DisabledHPCClient()
