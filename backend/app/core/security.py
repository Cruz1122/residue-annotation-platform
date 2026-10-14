"""Small security helpers shared by API and worker trust boundaries."""

from __future__ import annotations

import re
from collections.abc import Iterable

# Error text can originate in Slurm, SFTP, scientific tools, or an operating
# system exception.  Treat every standalone POSIX absolute path as sensitive;
# the negative lookbehind avoids consuming URL schemes such as ``https://``.
# The remote root is replaced separately because deployments may use a
# project-specific prefix.
_ABSOLUTE_FILESYSTEM_PATH = re.compile(r"(?<![A-Za-z0-9_:/])/(?!/)[^\s\"'<>]+")
_WINDOWS_FILESYSTEM_PATH = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z]:\\[^\s\"'<>]*")
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(password|passphrase|token|secret|api[_-]?key|private[_-]?key)\b"
    r"\s*[:=]\s*[^\s,;]+"
)


def sanitize_error_message(
    message: str,
    *,
    roots: Iterable[str] = (),
    max_length: int = 1_000,
) -> str:
    """Return bounded error text safe to persist and expose through the API.

    Worker failures cross from operating-system and remote-tool trust
    boundaries into durable database fields and then into API responses.  The
    useful diagnostic state is retained, while absolute paths and obvious
    ``key=value`` secret material are replaced before either persistence or
    logging can occur.
    """

    if max_length < 1:
        raise ValueError("max_length must be positive")
    sanitized = str(message).replace("\x00", "")
    for root in roots:
        normalized_root = str(root).strip()
        if normalized_root:
            sanitized = sanitized.replace(normalized_root, "<remote-root>")
    sanitized = _ABSOLUTE_FILESYSTEM_PATH.sub("<path>", sanitized)
    sanitized = _WINDOWS_FILESYSTEM_PATH.sub("<path>", sanitized)
    sanitized = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=<redacted>", sanitized)
    return " ".join(sanitized.split())[:max_length]
