from __future__ import annotations

import hashlib
import os
import shlex
from pathlib import Path
from uuid import uuid4

from app.core.config import Settings
from app.features.artifacts.storage import ArtifactPathError, ArtifactStore, safe_storage_path
from app.features.proteins.service import SequenceValidationError, normalize_sequence

ALLOWED_SUFFIXES = {
    "fasta": {".fa", ".fasta", ".faa", ".fas", ".fna"},
    "structure": {".pdb", ".cif", ".mmcif"},
}


class UploadValidationError(ValueError):
    pass


def _suffix(filename: str, input_type: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES[input_type]:
        raise UploadValidationError("file extension does not match the input type")
    return suffix


def _parse_float(value: str) -> float:
    parsed = float(value)
    if not parsed == parsed or parsed in {float("inf"), float("-inf")}:
        raise ValueError("coordinate must be finite")
    return parsed


def _validate_pdb(text: str) -> None:
    atom_records = 0
    for line_number, line in enumerate(text.splitlines(), start=1):
        record = line[:6].strip().upper()
        if record not in {"ATOM", "HETATM"}:
            continue
        if len(line) < 54:
            raise UploadValidationError(f"invalid PDB atom record at line {line_number}")
        try:
            int(line[6:11].strip())
            if not line[12:16].strip() or not line[17:20].strip():
                raise ValueError("missing atom or residue name")
            int(line[22:26].strip())
            _parse_float(line[30:38].strip())
            _parse_float(line[38:46].strip())
            _parse_float(line[46:54].strip())
        except (TypeError, ValueError) as exc:
            raise UploadValidationError(f"invalid PDB atom record at line {line_number}") from exc
        atom_records += 1
    if atom_records == 0:
        raise UploadValidationError("PDB upload has no valid ATOM or HETATM records")


def _validate_mmcif(text: str) -> None:
    lines = text.splitlines()
    try:
        loop_index = next(
            index for index, line in enumerate(lines) if line.strip().lower() == "loop_"
        )
    except StopIteration as exc:
        raise UploadValidationError("mmCIF upload has no atom_site loop") from exc

    fields: list[str] = []
    data_start = loop_index + 1
    for index in range(data_start, len(lines)):
        stripped = lines[index].strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("_"):
            fields.append(stripped.split()[0])
            continue
        data_start = index
        break
    required = {
        "_atom_site.label_atom_id",
        "_atom_site.label_comp_id",
        "_atom_site.label_seq_id",
        "_atom_site.Cartn_x",
        "_atom_site.Cartn_y",
        "_atom_site.Cartn_z",
    }
    if not required.issubset(fields):
        raise UploadValidationError("mmCIF upload lacks required atom_site columns")

    tokens: list[str] = []
    for line in lines[data_start:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            if stripped.startswith("#"):
                break
            continue
        if stripped.lower() in {"loop_", "stop_"} or stripped.startswith("_"):
            break
        try:
            tokens.extend(shlex.split(stripped, comments=False))
        except ValueError as exc:
            raise UploadValidationError("mmCIF upload contains invalid quoting") from exc

    field_count = len(fields)
    if field_count == 0 or len(tokens) < field_count:
        raise UploadValidationError("mmCIF upload has no atom records")
    indexes = {field: fields.index(field) for field in required}
    atom_records = 0
    for offset in range(0, len(tokens) - field_count + 1, field_count):
        row = tokens[offset : offset + field_count]
        try:
            if row[indexes["_atom_site.label_atom_id"]] in {".", "?"}:
                raise ValueError("missing atom name")
            if row[indexes["_atom_site.label_comp_id"]] in {".", "?"}:
                raise ValueError("missing residue name")
            int(row[indexes["_atom_site.label_seq_id"]])
            _parse_float(row[indexes["_atom_site.Cartn_x"]])
            _parse_float(row[indexes["_atom_site.Cartn_y"]])
            _parse_float(row[indexes["_atom_site.Cartn_z"]])
        except (IndexError, TypeError, ValueError) as exc:
            raise UploadValidationError("invalid mmCIF atom record") from exc
        atom_records += 1
    if atom_records == 0:
        raise UploadValidationError("mmCIF upload has no valid atom records")


def validate_upload_bytes(data: bytes, input_type: str, filename: str, settings: Settings) -> None:
    if input_type not in ALLOWED_SUFFIXES:
        raise UploadValidationError("unsupported input type")
    if not data:
        raise UploadValidationError("upload cannot be empty")
    if len(data) > settings.max_upload_bytes:
        raise UploadValidationError("upload exceeds the configured size limit")
    _suffix(filename, input_type)
    if b"\x00" in data:
        raise UploadValidationError("binary content is not allowed for this input")
    if input_type == "fasta":
        try:
            normalize_sequence(data.decode("utf-8"), max_length=settings.max_sequence_length)
        except (UnicodeDecodeError, SequenceValidationError) as exc:
            raise UploadValidationError("invalid FASTA upload") from exc
    else:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise UploadValidationError("invalid structure upload") from exc
        suffix = _suffix(filename, input_type)
        try:
            if suffix == ".pdb":
                _validate_pdb(text)
            else:
                _validate_mmcif(text)
        except UploadValidationError:
            raise
        except (TypeError, ValueError) as exc:
            raise UploadValidationError("invalid structure upload") from exc


def write_upload(
    settings: Settings, data: bytes, filename: str, input_type: str
) -> tuple[str, int, str]:
    validate_upload_bytes(data, input_type, filename, settings)
    suffix = _suffix(filename, input_type)
    key = f"uploads/{uuid4()}{suffix}"
    store = ArtifactStore(settings)
    try:
        target = safe_storage_path(store.root, key)
    except ArtifactPathError as exc:
        raise UploadValidationError("could not allocate upload storage") from exc
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"upload-{uuid4().hex}.tmp")
    try:
        file_descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(file_descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        os.chmod(target, 0o600)
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise UploadValidationError("could not store upload") from exc
    return key, len(data), hashlib.sha256(data).hexdigest()
