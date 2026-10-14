FROM ghcr.io/astral-sh/uv:0.12.20 AS uv

FROM python:3.12-slim-bookworm

COPY --from=uv /uv /uvx /bin/

WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --home-dir /app --no-create-home app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
COPY alembic.ini ./alembic.ini
COPY alembic ./alembic

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN mkdir -p /app/data/artifacts
RUN chown -R app:app /app
USER app

EXPOSE 8742

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8742"]
