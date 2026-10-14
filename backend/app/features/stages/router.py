from fastapi import APIRouter

from app.features.stages.registry import STAGE_DEFINITIONS

router = APIRouter(prefix="/stages", tags=["stages"])


@router.get("")
def list_stage_definitions() -> list[dict[str, object]]:
    return [stage.to_dict() for stage in STAGE_DEFINITIONS]
