from __future__ import annotations

import time

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.features.runs.worker_service import process_one


def run_forever() -> None:
    settings = get_settings()
    while True:
        with SessionLocal() as session:
            processed = process_one(session)
        if not processed:
            time.sleep(settings.worker_poll_interval_seconds)


if __name__ == "__main__":
    run_forever()
