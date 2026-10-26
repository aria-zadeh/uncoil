"""Put train/ on the path so the modules import as top-level names, like the scripts do."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
