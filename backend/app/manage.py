from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.db import SessionLocal
from app.features.auth.service import AdminBootstrapError, bootstrap_first_admin
from app.features.runs.mn5_import import Mn5ImportError, import_mn5_results

SessionFactory = Callable[[], Session]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Residue annotation platform management")
    commands = parser.add_subparsers(dest="command", required=True)
    bootstrap = commands.add_parser(
        "bootstrap-admin",
        help="promote one existing verified account when no administrator exists",
    )
    bootstrap.add_argument("--email", required=True, help="email of the account to promote")
    mn5_import = commands.add_parser(
        "import-mn5",
        help="import one verified historical MN5 publication into the durable run model",
    )
    mn5_import.add_argument("--source-root", required=True, type=Path)
    mn5_import.add_argument("--direct-root", required=True, type=Path)
    mn5_import.add_argument("--email", required=True, help="owner account for imported runs")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    session_factory: SessionFactory | None = None,
) -> int:
    args = _parser().parse_args(argv)
    factory = session_factory or SessionLocal
    with factory() as session:
        if args.command == "import-mn5":
            try:
                result = import_mn5_results(
                    session,
                    source_root=args.source_root,
                    direct_root=args.direct_root,
                    email=args.email,
                )
            except Mn5ImportError as exc:
                session.rollback()
                print(f"MN5 import failed: {exc}", file=sys.stderr)
                return 1
            print(result)
            return 0
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
