from __future__ import annotations

import logging
import os
import time

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.features.runs.worker_service import process_one


def configure_logging() -> None:
    """Make worker correlation and failure logs visible in its container."""

    configured_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, configured_level, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        force=True,
    )


def run_forever() -> None:
    configure_logging()
    settings = get_settings()
    while True:
        with SessionLocal() as session:
            processed = process_one(session)
        if not processed:
            time.sleep(settings.worker_poll_interval_seconds)


if __name__ == "__main__":
    run_forever()
