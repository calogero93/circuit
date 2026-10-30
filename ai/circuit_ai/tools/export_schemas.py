"""Rigenera il catalogo browser dagli stessi schemi Pydantic usati dal modello."""
import json
from circuit_ai.tools.catalog import BROWSER_TOOLS
from circuit_ai.core.paths import REPO_ROOT


def export():
    definitions = [{"name": name, "description": description, "input_schema": schema.model_json_schema()}
                   for name, description, schema, _ in BROWSER_TOOLS]
    path = REPO_ROOT / "src/ai/tool-schemas.json"
    path.write_text(json.dumps(definitions, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    export()
