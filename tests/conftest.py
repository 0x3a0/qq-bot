"""Shared pytest configuration.

The package lives under ``src/`` without an installed distribution, so tests
add it to ``sys.path`` explicitly. This keeps the test suite runnable with a
bare ``pytest`` invocation and no packaging step.
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
