"""Shared router helpers."""
from __future__ import annotations

from typing import Any


def bool_param(v: Any) -> bool:
    """Mirror the Node boolParam: true iff 'true' | '1' | True."""
    return v == "true" or v == "1" or v is True
