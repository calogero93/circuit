"""Percorsi stabili, indipendenti dalla profondità dei moduli e dalla cwd."""
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1]
AI_DIR = PACKAGE_DIR.parent
REPO_ROOT = AI_DIR.parent
EVALS_DIR = AI_DIR / "evals"
