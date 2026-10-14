FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        iproute2 \
        netcat-openbsd \
        openfortivpn \
        ppp \
    && rm -rf /var/lib/apt/lists/*

COPY pinentry.py /usr/local/libexec/rap-vpn-pinentry
COPY entrypoint.py /usr/local/bin/rap-vpn

RUN chmod 0555 /usr/local/libexec/rap-vpn-pinentry /usr/local/bin/rap-vpn

ENTRYPOINT ["/usr/local/bin/rap-vpn"]
