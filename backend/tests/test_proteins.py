from app.features.proteins.models import Protein, ProteinIdentifier, ProteinProjectAccess
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


def test_projects_share_deduplicated_protein_and_aliases_without_global_listing(client, session):
    project_a = {"X-User-Id": "user-a", "X-Project-Id": "project-a"}
    project_b = {"X-User-Id": "user-b", "X-Project-Id": "project-b"}
    first = client.post(
        "/api/v1/proteins",
        headers=project_a,
        json={
            "sequence": "ACDEFG",
            "aliases": [{"source": "uniprot", "identifier": "P12345"}],
        },
    )
    private_to_a = client.post(
        "/api/v1/proteins", headers=project_a, json={"sequence": "ACDEFGHIK"}
    )
    assert first.status_code == private_to_a.status_code == 201

    second = client.post(
        "/api/v1/proteins",
        headers=project_b,
        json={
            "sequence": ">another fasta header\nacde fg",
            "aliases": [
                {"source": "uniprot", "identifier": "P12345"},
                {"source": "gene", "identifier": "GENE1"},
            ],
        },
    )

    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["created"] is False
    assert {tuple((item["source"], item["identifier"])) for item in second.json()["aliases"]} >= {
        ("uniprot", "P12345"),
        ("gene", "GENE1"),
    }
    assert session.query(Protein).count() == 2
    assert (
        session.query(ProteinIdentifier).filter_by(source="uniprot", identifier="P12345").count()
        == 1
    )
    assert session.query(ProteinProjectAccess).filter_by(protein_id=first.json()["id"]).count() == 2

    visible_to_b = client.get("/api/v1/proteins", headers=project_b)
    assert visible_to_b.status_code == 200
    assert {item["id"] for item in visible_to_b.json()} == {first.json()["id"]}
    assert (
        client.get(f"/api/v1/proteins/{first.json()['id']}", headers=project_b).status_code == 200
    )
    assert (
        client.get(f"/api/v1/proteins/{private_to_a.json()['id']}", headers=project_b).status_code
        == 403
    )


def test_missing_sequence_is_rejected(client):
    response = client.post("/api/v1/proteins", json={})

    assert response.status_code == 422
