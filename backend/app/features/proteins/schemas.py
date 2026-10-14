from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProteinAliasInput(BaseModel):
    source: str = Field(min_length=1, max_length=64)
    identifier: str = Field(min_length=1, max_length=256)


class ProteinCreate(BaseModel):
    sequence: str | None = None
    fasta: str | None = None
    aliases: list[ProteinAliasInput] = Field(default_factory=list, max_length=32)

    @field_validator("sequence", "fasta")
    @classmethod
    def reject_oversized_input(cls, value: str | None) -> str | None:
        if value is not None and len(value) > 200_000:
            raise ValueError("sequence input is too large")
        return value


class ProteinAliasRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source: str
    identifier: str


class ProteinRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    sequence_sha256: str
    sequence: str
    length: int
    aliases: list[ProteinAliasRead]
    created_at: datetime | None = None


class ProteinCreateResponse(ProteinRead):
    created: bool
