"""Disposable copies of the migrated baseline; never seed personal state."""
from pathlib import Path
import shutil
import tempfile

from reviewboard.paths import APP_ROOT, DEFAULT_COURSE_ROOT, EXPERIMENTS_ROOT, KNOWLEDGE_TOOLS_ROOT


def copy_course(test_case):
    temporary = tempfile.TemporaryDirectory(prefix="review-course-")
    test_case.addCleanup(temporary.cleanup)
    root = Path(temporary.name) / "course"
    shutil.copytree(DEFAULT_COURSE_ROOT, root,
                    ignore=shutil.ignore_patterns(".review-board", "__pycache__", "*.pyc", ".DS_Store"))
    return root


def copy_runtime(repo):
    app = repo / "legacy/review-board"
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")
    shutil.copytree(APP_ROOT, app, ignore=ignore)
    shutil.copytree(KNOWLEDGE_TOOLS_ROOT, repo / "tools/digital-logic", ignore=ignore)
    for relative in ("content-depth-prototype", "style-math-prototype",
                     "mux-skill-comparison/excalidraw-runtime/fonts"):
        shutil.copytree(EXPERIMENTS_ROOT / relative, repo / "experiments" / relative,
                        ignore=ignore)
    return app
