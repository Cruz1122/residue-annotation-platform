from app.features.proteins.models import Protein
from app.features.proteins.service import normalize_sequence


def test_normalization_ignores_fasta_formatting_but_not_residues():
    first = normalize_sequence(">sp|A|Example\nacde fg\n")
    second = normalize_sequence("ACDEFG")

    assert first.sequence == second.sequence == "ACDEFG"
    assert first.sequence_sha256 == second.sequence_sha256
    assert first.fasta_header == "sp|A|Example"


def test_invalid_sequence_does_not_write(client, session):
    response = client.post("/api/v1/proteins", json={"sequence": "ACD-X"})

    assert response.status_code == 422
    assert session.query(Protein).count() == 0


def test_identical_sequences_resolve_to_one_protein(client):
    first = client.post(
        "/api/v1/proteins",
        json={
            "fasta": ">sp|P1|Example\nACDEFG",
            "aliases": [{"source": "uniprot", "identifier": "P1"}],
        },
    )
    second = client.post(
        "/api/v1/proteins",
        json={"sequence": "acde\nfg", "aliases": [{"source": "gene", "identifier": "EXAMPLE"}]},
    )

    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert {alias["source"] for alias in second.json()["aliases"]} == {
        "uniprot",
        "fasta_header",
        "gene",
    }


def test_missing_sequence_is_rejected(client):
    response = client.post("/api/v1/proteins", json={})

    assert response.status_code == 422
