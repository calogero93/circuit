"""Avvio del package e copertura ricorsiva dei manifesti dopo il refactoring."""
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

from circuit_ai.evaluation.experiments import source_snapshot


class PackageEntrypointTests(unittest.TestCase):
    def test_module_entrypoint_starts_the_existing_api(self):
        with patch("circuit_ai.api.server.main") as start:
            runpy.run_module("circuit_ai", run_name="__main__")
        start.assert_called_once_with()

    def test_manifest_tracks_new_nested_modules_and_detects_their_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            nested = root / "ai/circuit_ai/nli/extensions/new_backend.py"
            nested.parent.mkdir(parents=True)
            nested.write_text("before")
            tests = root / "ai/tests/test_example.py"
            tests.parent.mkdir()
            tests.write_text("test")
            data = root / "ai/evals/example.json"
            data.parent.mkdir()
            data.write_text("{}")
            relative = nested.relative_to(root).as_posix()
            before = source_snapshot(root)
            self.assertEqual(set(before), {relative})
            nested.write_text("after")
            self.assertNotEqual(before[relative], source_snapshot(root)[relative])
