"""Repository resources stay separate from the selected course's content/state."""
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_ROOT.parent.parent
DEFAULT_COURSE_ROOT = REPO_ROOT / "courses/digital-logic"
EXPERIMENTS_ROOT = REPO_ROOT / "experiments"
KNOWLEDGE_TOOLS_ROOT = REPO_ROOT / "tools/digital-logic"
