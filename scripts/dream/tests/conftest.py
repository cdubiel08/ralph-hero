"""Make the dream-loop package importable from tests without installing."""
from __future__ import annotations

import sys
from pathlib import Path

# Tests live under ``scripts/dream/tests/``; the source lives one dir up.
_DREAM_ROOT = Path(__file__).resolve().parent.parent
if str(_DREAM_ROOT) not in sys.path:
    sys.path.insert(0, str(_DREAM_ROOT))
