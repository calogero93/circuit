"""Indicizza documenti locali PDF, Markdown e TXT per search_info (extra rag)."""
import argparse
from pathlib import Path

from config import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if not args.directory.is_dir(): parser.error("directory documenti non trovata")
    from modules.chunking import prepare_docs, chunk_data
    from modules.vectorstore import VectorStore
    settings = Settings.from_env()
    chunks = chunk_data(prepare_docs(str(args.directory)))
    if not chunks: raise SystemExit("Nessun contenuto PDF, MD o TXT da indicizzare")
    path = settings.data_dir / "qdrant"
    path.mkdir(parents=True, exist_ok=True)
    store = VectorStore(str(path))
    try:
        store.create_collection("electronics")
        store.index_data(chunks, "electronics")
    finally:
        store.client.close()
    print(f"Indicizzati {len(chunks)} chunk con fonte in {path}")


if __name__ == "__main__": main()
