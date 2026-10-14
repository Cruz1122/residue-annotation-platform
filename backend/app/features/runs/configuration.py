from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.config import Settings
from app.features.artifacts.storage import ArtifactIntegrityError, ArtifactPathError, ArtifactStore

if TYPE_CHECKING:
    from app.features.proteins.models import Protein
    from app.features.runs.models import Upload


class ConfigurationValidationError(ValueError):
    """The confirmed input cannot produce a reproducible run configuration."""


@dataclass(frozen=True, slots=True)
class StructureResidue:
    chain: str
    residue_number: str
    insertion_code: str
    amino_acid: str


@dataclass(frozen=True, slots=True)
class StructureInspection:
    chain: str
    sequence: str
    mapping: dict[str, object]


_THREE_TO_ONE = {
    "ALA": "A",
    "ARG": "R",
    "ASN": "N",
    "ASP": "D",
    "CYS": "C",
    "GLN": "Q",
    "GLU": "E",
    "GLY": "G",
    "HIS": "H",
    "ILE": "I",
    "LEU": "L",
    "LYS": "K",
    "MET": "M",
    "MSE": "M",
    "PHE": "F",
    "PRO": "P",
    "SER": "S",
    "THR": "T",
    "TRP": "W",
    "TYR": "Y",
    "VAL": "V",
}
_ACCESSION = re.compile(r"^[A-Z][A-Z0-9][A-Z0-9_-]{1,29}$")


def resolve_accession(protein: Protein, requested: str | None = None) -> str | None:
    """Resolve a stable scientific identity without guessing from a filename."""

    if requested:
        accession = requested.strip().upper()
        if not _ACCESSION.fullmatch(accession):
            raise ConfigurationValidationError(
                "scientific_accession is not a valid UniProt identifier"
            )
        return accession

    for identifier in protein.identifiers:
        source = identifier.source.strip().lower()
        value = identifier.identifier.strip()
        if source in {"uniprot", "uniprot_accession", "accession"}:
            accession = value.upper()
            if _ACCESSION.fullmatch(accession):
                return accession
        if source == "fasta_header":
            match = re.search(r"(?:sp|tr)\|([^|]+)\|", value, flags=re.IGNORECASE)
            if match and _ACCESSION.fullmatch(match.group(1).upper()):
                return match.group(1).upper()
    return None


def read_verified_upload(settings: Settings, upload: Upload) -> bytes:
    """Read an upload only after checking its persisted size and digest."""

    store = ArtifactStore(settings)
    try:
        stream = store.open_verified(
            upload.storage_key,
            size=upload.size,
            sha256=upload.sha256,
        )
        with stream:
            return stream.read()
    except (ArtifactPathError, ArtifactIntegrityError, FileNotFoundError, OSError) as exc:
        raise ConfigurationValidationError(
            f"{upload.input_type} upload content is unavailable or has changed"
        ) from exc


def _pdb_residues(text: str) -> dict[str, list[StructureResidue]]:
    chains: dict[str, list[StructureResidue]] = {}
    seen: set[tuple[str, str, str]] = set()
    for line_number, line in enumerate(text.splitlines(), start=1):
        record = line[:6].strip().upper()
        if record not in {"ATOM", "HETATM"} or line[12:16].strip().upper() != "CA":
            continue
        if len(line) < 27:
            raise ConfigurationValidationError(f"invalid PDB residue record at line {line_number}")
        amino_acid = _THREE_TO_ONE.get(line[17:20].strip().upper())
        if amino_acid is None:
            # Ligands and water are not canonical residues. They do not make
            # the selected protein chain invalid, but they are not mapped.
            continue
        chain = line[21:22].strip() or "_"
        residue_number = line[22:26].strip()
        insertion_code = line[26:27].strip()
        key = (chain, residue_number, insertion_code)
        if not residue_number or key in seen:
            continue
        seen.add(key)
        chains.setdefault(chain, []).append(
            StructureResidue(chain, residue_number, insertion_code, amino_acid)
        )
    return chains


def _first_index(indexes: dict[str, int], *names: str) -> int | None:
    for name in names:
        if name.lower() in indexes:
            return indexes[name.lower()]
    return None


def _mmcif_residues(text: str) -> dict[str, list[StructureResidue]]:
    lines = text.splitlines()
    fields: list[str] | None = None
    data_start = 0
    cursor = 0
    while cursor < len(lines):
        if lines[cursor].strip().lower() != "loop_":
            cursor += 1
            continue
        candidate: list[str] = []
        field_cursor = cursor + 1
        while field_cursor < len(lines):
            stripped = lines[field_cursor].strip()
            if not stripped or stripped.startswith("#"):
                field_cursor += 1
                continue
            if not stripped.startswith("_"):
                break
            candidate.append(stripped.split()[0])
            field_cursor += 1
        if any(field.lower().startswith("_atom_site.") for field in candidate):
            fields = candidate
            data_start = field_cursor
            break
        cursor = field_cursor
    if not fields:
        raise ConfigurationValidationError("mmCIF upload has no atom_site loop")

    indexes = {field.lower(): index for index, field in enumerate(fields)}
    atom_index = _first_index(indexes, "_atom_site.label_atom_id", "_atom_site.auth_atom_id")
    residue_index = _first_index(indexes, "_atom_site.label_comp_id", "_atom_site.auth_comp_id")
    chain_index = _first_index(indexes, "_atom_site.auth_asym_id", "_atom_site.label_asym_id")
    number_index = _first_index(indexes, "_atom_site.auth_seq_id", "_atom_site.label_seq_id")
    insertion_index = _first_index(indexes, "_atom_site.pdbx_pdb_ins_code")
    if atom_index is None or residue_index is None or chain_index is None or number_index is None:
        raise ConfigurationValidationError("mmCIF upload lacks required residue columns")

    tokens: list[str] = []
    for line in lines[data_start:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            if stripped.startswith("#"):
                break
            continue
        if stripped.lower() in {"loop_", "stop_"} or stripped.startswith("_"):
            break
        # mmCIF values used by the input contract are single-line tokens. The
        # upload validator has already rejected malformed quoting.
        import shlex

        try:
            tokens.extend(shlex.split(stripped, comments=False))
        except ValueError as exc:
            raise ConfigurationValidationError("mmCIF upload contains invalid quoting") from exc

    if len(tokens) < len(fields) or len(tokens) % len(fields):
        raise ConfigurationValidationError("mmCIF upload has no complete atom records")
    chains: dict[str, list[StructureResidue]] = {}
    seen: set[tuple[str, str, str]] = set()
    for offset in range(0, len(tokens), len(fields)):
        row = tokens[offset : offset + len(fields)]
        if row[atom_index].upper() != "CA":
            continue
        amino_acid = _THREE_TO_ONE.get(row[residue_index].upper())
        if amino_acid is None:
            continue
        chain = row[chain_index] not in {".", "?"} and row[chain_index] or "_"
        residue_number = row[number_index]
        if residue_number in {".", "?"}:
            continue
        insertion_code = (
            row[insertion_index]
            if insertion_index is not None and row[insertion_index] not in {".", "?"}
            else ""
        )
        key = (chain, residue_number, insertion_code)
        if key in seen:
            continue
        seen.add(key)
        chains.setdefault(chain, []).append(
            StructureResidue(chain, residue_number, insertion_code, amino_acid)
        )
    return chains


def _alignment_mapping(
    canonical_sequence: str,
    residues: list[StructureResidue],
) -> tuple[int, list[dict[str, object]]] | None:
    structure_sequence = "".join(residue.amino_acid for residue in residues)
    if not structure_sequence:
        return None
    matcher = SequenceMatcher(a=canonical_sequence, b=structure_sequence, autojunk=False)
    pairs: list[dict[str, object]] = []
    for (
        tag,
        canonical_start,
        canonical_end,
        structure_start,
        structure_end,
    ) in matcher.get_opcodes():
        if tag != "equal":
            # Insertions/deletions are valid mapping events. A replacement
            # means a residue substitution in the provided structure and is
            # rejected rather than silently redefining the canonical sequence.
            if tag == "replace":
                return None
            continue
        for canonical_index, structure_index in zip(
            range(canonical_start, canonical_end),
            range(structure_start, structure_end),
            strict=False,
        ):
            residue = residues[structure_index]
            pairs.append(
                {
                    "canonical_position": canonical_index + 1,
                    "chain": "" if residue.chain == "_" else residue.chain,
                    "residue_number": residue.residue_number,
                    "insertion_code": residue.insertion_code,
                    "aa": residue.amino_acid,
                }
            )
    coverage = len(pairs) / len(canonical_sequence)
    if coverage < 0.8:
        return None
    return len(pairs), pairs


def inspect_structure(
    content: bytes,
    canonical_sequence: str,
    *,
    filename: str,
    requested_chain: str | None = None,
) -> StructureInspection:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ConfigurationValidationError("structure upload is not valid UTF-8") from exc

    suffix = Path(filename).suffix.lower()
    chains = _pdb_residues(text) if suffix == ".pdb" else _mmcif_residues(text)
    if not chains:
        raise ConfigurationValidationError("structure upload has no canonical protein residues")
    requested = requested_chain.strip() if requested_chain else None
    candidates = [requested] if requested else list(chains)
    if requested and requested not in chains:
        raise ConfigurationValidationError(f"structure chain {requested!r} was not found")

    best: tuple[str, int, list[dict[str, object]]] | None = None
    for chain in candidates:
        if chain is None or chain not in chains:
            continue
        mapped = _alignment_mapping(canonical_sequence, chains[chain])
        if mapped is None:
            continue
        count, pairs = mapped
        if best is None or count > best[1]:
            best = (chain, count, pairs)
    if best is None:
        raise ConfigurationValidationError(
            "provided structure does not correspond to the canonical sequence"
        )
    selected_chain, mapped_count, pairs = best
    return StructureInspection(
        chain="" if selected_chain == "_" else selected_chain,
        sequence="".join(item["aa"] for item in pairs),
        mapping={
            "method": "canonical_sequence_alignment",
            "canonical_length": len(canonical_sequence),
            "structure_length": len(chains[selected_chain]),
            "mapped_residue_count": mapped_count,
            "canonical_to_structure": pairs,
        },
    )


def empty_structure_mapping(sequence_length: int) -> dict[str, object]:
    return {
        "method": "not_applicable",
        "canonical_length": sequence_length,
        "structure_length": 0,
        "mapped_residue_count": 0,
        "canonical_to_structure": [],
    }
