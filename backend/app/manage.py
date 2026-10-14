from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence

from sqlalchemy.orm import Session

from app.core.db import SessionLocal
from app.features.auth.service import AdminBootstrapError, bootstrap_first_admin

SessionFactory = Callable[[], Session]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Residue annotation platform management")
    commands = parser.add_subparsers(dest="command", required=True)
    bootstrap = commands.add_parser(
        "bootstrap-admin",
        help="promote one existing verified account when no administrator exists",
    )
    bootstrap.add_argument("--email", required=True, help="email of the account to promote")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    session_factory: SessionFactory | None = None,
) -> int:
    args = _parser().parse_args(argv)
    if args.command != "bootstrap-admin":  # pragma: no cover - argparse enforces this branch.
        return 2

    factory = session_factory or SessionLocal
    with factory() as session:
        try:
            user = bootstrap_first_admin(session, args.email)
            session.commit()
        except AdminBootstrapError as exc:
            session.rollback()
            print(f"Admin bootstrap failed: {exc}", file=sys.stderr)
            return 1
    print(f"Administrator bootstrapped: {user.email}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
