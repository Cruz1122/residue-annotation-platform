"""Conservative, reproducible comparison of per-residue annotation tables.

The comparator is deliberately narrower than a scientific equivalence review:
it reports structural and cell-level differences and never decides whether a
scientific change is acceptable.  Operators must provide tolerances explicitly
for numeric columns; ``NA`` remains distinct from a numeric zero.
"""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

CANONICAL_COLUMNS = ("protein_id", "aa_position", "aa_ref")
_NA_VALUES = frozenset({"", "NA", "N/A", "NULL"})
_DEFAULT_MAX_BYTES = 256 * 1024 * 1024
_DEFAULT_MAX_DIFFERENCES = 10_000


class ScienceDiffError(ValueError):
    """Raised when an annotation table cannot be compared safely."""


@dataclass(frozen=True, slots=True)
class _AnnotationTable:
    columns: tuple[str, ...]
    rows: dict[tuple[str, int, str], dict[str, str]]


@dataclass(frozen=True, slots=True)
class CellDifference:
    key: tuple[str, int, str]
    column: str
    before: str
    after: str
    reason: str

    def as_dict(self) -> dict[str, Any]:
        protein_id, aa_position, aa_ref = self.key
        return {
            "protein_id": protein_id,
            "aa_position": aa_position,
            "aa_ref": aa_ref,
            "column": self.column,
            "before": self.before,
            "after": self.after,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class ScienceDiffReport:
    before_columns: tuple[str, ...]
    after_columns: tuple[str, ...]
    rows_before: int
    rows_after: int
    compared_rows: int
    unchanged_cells: int
    changed_cells: int
    added_keys: tuple[tuple[str, int, str], ...]
    removed_keys: tuple[tuple[str, int, str], ...]
    identity_mismatches: tuple[dict[str, Any], ...]
    differences: tuple[CellDifference, ...]
    differences_truncated: bool
    absolute_tolerance: Decimal
    relative_tolerance: Decimal

    @property
    def equivalent(self) -> bool:
        return not (
            self.before_columns != self.after_columns
            or self.added_keys
            or self.removed_keys
            or self.identity_mismatches
            or self.changed_cells
        )

    def as_dict(self) -> dict[str, Any]:
        before_set = set(self.before_columns)
        after_set = set(self.after_columns)
        return {
            "equivalent": self.equivalent,
            "before_columns": list(self.before_columns),
            "after_columns": list(self.after_columns),
            "added_columns": sorted(after_set - before_set),
            "removed_columns": sorted(before_set - after_set),
            "rows_before": self.rows_before,
            "rows_after": self.rows_after,
            "compared_rows": self.compared_rows,
            "unchanged_cells": self.unchanged_cells,
            "changed_cells": self.changed_cells,
            "added_keys": [_key_as_dict(key) for key in self.added_keys],
            "removed_keys": [_key_as_dict(key) for key in self.removed_keys],
            "identity_mismatches": list(self.identity_mismatches),
            "differences": [difference.as_dict() for difference in self.differences],
            "differences_truncated": self.differences_truncated,
            "absolute_tolerance": str(self.absolute_tolerance),
            "relative_tolerance": str(self.relative_tolerance),
        }


def compare_annotation_tables(
    before_path: Path,
    after_path: Path,
    *,
    absolute_tolerance: Decimal = Decimal("0"),
    relative_tolerance: Decimal = Decimal("0"),
    max_bytes: int = _DEFAULT_MAX_BYTES,
    max_differences: int = _DEFAULT_MAX_DIFFERENCES,
) -> ScienceDiffReport:
    """Compare two bounded TSV annotation tables without inferring biology.

    Rows are keyed by the canonical identity ``(protein_id, aa_position,
    aa_ref)``.  A changed reference therefore appears as a removed and an
    added row, and is also reported as an identity mismatch.  Numeric cells
    use the explicitly supplied absolute/relative tolerances; all other
    values are compared exactly after whitespace normalization.
    """

    _validate_nonnegative_decimal(absolute_tolerance, "absolute_tolerance")
    _validate_nonnegative_decimal(relative_tolerance, "relative_tolerance")
    if max_bytes < 1:
        raise ScienceDiffError("max_bytes must be positive")
    if max_differences < 1:
        raise ScienceDiffError("max_differences must be positive")

    before = _read_annotation_table(before_path, max_bytes=max_bytes)
    after = _read_annotation_table(after_path, max_bytes=max_bytes)
    before_keys = set(before.rows)
    after_keys = set(after.rows)
    common_keys = before_keys & after_keys
    added_keys = tuple(sorted(after_keys - before_keys))
    removed_keys = tuple(sorted(before_keys - after_keys))
    identity_mismatches = _identity_mismatches(before, after)

    shared_columns = set(before.columns) & set(after.columns) - set(CANONICAL_COLUMNS)
    differences: list[CellDifference] = []
    changed_cells = 0
    unchanged_cells = 0
    for key in sorted(common_keys):
        before_row = before.rows[key]
        after_row = after.rows[key]
        for column in sorted(shared_columns):
            before_value = before_row[column]
            after_value = after_row[column]
            if _values_equivalent(
                before_value,
                after_value,
                absolute_tolerance=absolute_tolerance,
                relative_tolerance=relative_tolerance,
            ):
                unchanged_cells += 1
                continue
            changed_cells += 1
            if len(differences) < max_differences:
                differences.append(
                    CellDifference(
                        key=key,
                        column=column,
                        before=before_value,
                        after=after_value,
                        reason=_difference_reason(before_value, after_value),
                    )
                )

    return ScienceDiffReport(
        before_columns=before.columns,
        after_columns=after.columns,
        rows_before=len(before.rows),
        rows_after=len(after.rows),
        compared_rows=len(common_keys),
        unchanged_cells=unchanged_cells,
        changed_cells=changed_cells,
        added_keys=added_keys,
        removed_keys=removed_keys,
        identity_mismatches=identity_mismatches,
        differences=tuple(differences),
        differences_truncated=changed_cells > len(differences),
        absolute_tolerance=absolute_tolerance,
        relative_tolerance=relative_tolerance,
    )


def _read_annotation_table(path: Path, *, max_bytes: int) -> _AnnotationTable:
    if not path.is_file():
        raise ScienceDiffError(f"annotation table is not a regular file: {path}")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ScienceDiffError("annotation table metadata is unavailable") from exc
    if size > max_bytes:
        raise ScienceDiffError("annotation table exceeds the configured byte limit")

    try:
        stream = path.open("r", encoding="utf-8", newline="")
    except OSError as exc:
        raise ScienceDiffError("annotation table cannot be opened") from exc
    with stream:
        reader = csv.DictReader(stream, delimiter="\t")
        columns = tuple(reader.fieldnames or ())
        if not columns or any(not column for column in columns):
            raise ScienceDiffError("annotation table has no valid header")
        if len(set(columns)) != len(columns):
            raise ScienceDiffError("annotation table contains duplicate columns")
        missing = set(CANONICAL_COLUMNS).difference(columns)
        if missing:
            raise ScienceDiffError(
                "annotation table is missing canonical columns: " + ", ".join(sorted(missing))
            )

        rows: dict[tuple[str, int, str], dict[str, str]] = {}
        positions: dict[tuple[str, int], str] = {}
        for line_number, row in enumerate(reader, start=2):
            if None in row:
                raise ScienceDiffError(f"annotation table has extra fields on line {line_number}")
            key = _canonical_key(row, line_number)
            position_key = key[:2]
            if position_key in positions:
                if positions[position_key] == key[2]:
                    raise ScienceDiffError(f"duplicate canonical row on line {line_number}")
                raise ScienceDiffError(f"duplicate canonical position on line {line_number}")
            if key in rows:
                raise ScienceDiffError(f"duplicate canonical row on line {line_number}")
            positions[position_key] = key[2]
            rows[key] = {
                column: _normalize_value(row.get(column))
                for column in columns
                if column not in CANONICAL_COLUMNS
            }
    return _AnnotationTable(columns=columns, rows=rows)


def _canonical_key(row: dict[str | None, str | None], line_number: int) -> tuple[str, int, str]:
    protein_id = (row.get("protein_id") or "").strip()
    if not protein_id:
        raise ScienceDiffError(f"missing protein_id on line {line_number}")
    raw_position = (row.get("aa_position") or "").strip()
    try:
        aa_position = int(raw_position)
    except ValueError as exc:
        raise ScienceDiffError(f"invalid aa_position on line {line_number}") from exc
    if aa_position < 1:
        raise ScienceDiffError(f"aa_position must be 1-based on line {line_number}")
    aa_ref = (row.get("aa_ref") or "").strip().upper()
    if len(aa_ref) != 1:
        raise ScienceDiffError(f"aa_ref must contain one residue on line {line_number}")
    return protein_id, aa_position, aa_ref


def _identity_mismatches(
    before: _AnnotationTable, after: _AnnotationTable
) -> tuple[dict[str, Any], ...]:
    def references(table: _AnnotationTable) -> dict[tuple[str, int], str]:
        return {(protein_id, position): aa_ref for protein_id, position, aa_ref in table.rows}

    before_references = references(before)
    after_references = references(after)
    mismatches: list[dict[str, Any]] = []
    for protein_id, position in sorted(set(before_references) & set(after_references)):
        before_ref = before_references[(protein_id, position)]
        after_ref = after_references[(protein_id, position)]
        if before_ref != after_ref:
            mismatches.append(
                {
                    "protein_id": protein_id,
                    "aa_position": position,
                    "before_aa_ref": before_ref,
                    "after_aa_ref": after_ref,
                }
            )
    return tuple(mismatches)


def _normalize_value(value: str | None) -> str:
    normalized = (value or "").strip()
    return "NA" if normalized.upper() in _NA_VALUES else normalized


def _numeric_value(value: str) -> Decimal | None:
    if value == "NA":
        return None
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        return None
    return parsed if parsed.is_finite() else None


def _values_equivalent(
    before: str,
    after: str,
    *,
    absolute_tolerance: Decimal,
    relative_tolerance: Decimal,
) -> bool:
    if before == after:
        return True
    before_number = _numeric_value(before)
    after_number = _numeric_value(after)
    if before_number is None or after_number is None:
        return False
    difference = abs(before_number - after_number)
    allowed = max(
        absolute_tolerance,
        max(abs(before_number), abs(after_number)) * relative_tolerance,
    )
    return difference <= allowed


def _difference_reason(before: str, after: str) -> str:
    if _numeric_value(before) is not None and _numeric_value(after) is not None:
        return "numeric_outside_tolerance"
    return "value_changed"


def _validate_nonnegative_decimal(value: Decimal, name: str) -> None:
    if not isinstance(value, Decimal) or not value.is_finite() or value < 0:
        raise ScienceDiffError(f"{name} must be a finite non-negative Decimal")


def _key_as_dict(key: tuple[str, int, str]) -> dict[str, Any]:
    protein_id, aa_position, aa_ref = key
    return {"protein_id": protein_id, "aa_position": aa_position, "aa_ref": aa_ref}


def _decimal_argument(value: str) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise argparse.ArgumentTypeError("must be a finite decimal") from exc
    if not parsed.is_finite() or parsed < 0:
        raise argparse.ArgumentTypeError("must be a finite non-negative decimal")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path, help="baseline annotation TSV")
    parser.add_argument("after", type=Path, help="candidate annotation TSV")
    parser.add_argument("--absolute-tolerance", type=_decimal_argument, default=Decimal("0"))
    parser.add_argument("--relative-tolerance", type=_decimal_argument, default=Decimal("0"))
    parser.add_argument("--max-bytes", type=int, default=_DEFAULT_MAX_BYTES)
    parser.add_argument("--max-differences", type=int, default=_DEFAULT_MAX_DIFFERENCES)
    args = parser.parse_args()
    try:
        report = compare_annotation_tables(
            args.before,
            args.after,
            absolute_tolerance=args.absolute_tolerance,
            relative_tolerance=args.relative_tolerance,
            max_bytes=args.max_bytes,
            max_differences=args.max_differences,
        )
    except ScienceDiffError as exc:
        parser.error(str(exc))
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report.equivalent else 1


if __name__ == "__main__":
    raise SystemExit(main())
