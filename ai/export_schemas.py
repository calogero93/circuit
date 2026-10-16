"""Rigenera il catalogo browser dagli stessi schemi Pydantic usati dal modello."""
import json
from pathlib import Path
from tools import BROWSER_TOOLS


def export():
    definitions = [{"name": name, "description": description, "input_schema": schema.model_json_schema()}
                   for name, description, schema, _ in BROWSER_TOOLS]
    path = Path(__file__).resolve().parents[1] / "src/ai/tool-schemas.json"
    path.write_text(json.dumps(definitions, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    export()
