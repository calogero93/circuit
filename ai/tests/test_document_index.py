"""Verifica la sostituzione dei documenti senza scaricare il modello embedding."""
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


class Vector(list):
    def tolist(self): return list(self)


class Embedder:
    def __init__(self, *_): pass
    def get_sentence_embedding_dimension(self): return 2
    def encode(self, values, **kwargs):
        return Vector([[1., 0.] for _ in values]) if isinstance(values, list) else Vector([1., 0.])


class Client:
    def __init__(self, **kwargs): self.points = {}; self.created = 0
    def collection_exists(self, name): return self.created > 0
    def create_collection(self, **kwargs): self.created += 1
    def delete(self, collection, points_selector):
        source = points_selector.must[0].match.value
        self.points = {k: v for k, v in self.points.items() if v.payload["source"] != source}
    def upsert(self, collection_name, points): self.points.update({p.id: p for p in points})


class DocumentIndexTests(unittest.TestCase):
    def test_reindex_replaces_old_chunks_without_duplicates_or_other_document_loss(self):
        qdrant = ModuleType("qdrant_client")
        qdrant.QdrantClient = Client
        models = ModuleType("qdrant_client.models")
        for name in ["FieldCondition", "Filter", "MatchValue", "PointStruct", "VectorParams"]:
            setattr(models, name, SimpleNamespace)
        models.Distance = SimpleNamespace(COSINE="cosine")
        sentence = ModuleType("sentence_transformers")
        sentence.SentenceTransformer = Embedder
        path = Path(__file__).resolve().parents[1] / "circuit_ai/rag/vectorstore.py"
        spec = importlib.util.spec_from_file_location("index_under_test", path)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"qdrant_client": qdrant, "qdrant_client.models": models, "sentence_transformers": sentence}):
            spec.loader.exec_module(module)
            store = module.VectorStore("unused")
            store.create_collection("electronics")
            store.create_collection("electronics")
            self.assertEqual(store.client.created, 1)
            def chunk(source, index, text):
                return {"source": source, "file_name": "same-name.md", "index_chunk": index, "payload": text}
            store.index_data([chunk("a", 0, "old"), chunk("a", 1, "old tail"), chunk("b", 0, "other")], "electronics")
            store.index_data([chunk("a", 0, "new")], "electronics")
            self.assertEqual(len(store.client.points), 2)
            payloads = {p.payload["source"]: p.payload["text"] for p in store.client.points.values()}
            self.assertEqual(payloads, {"a": "new", "b": "other"})


@unittest.skipUnless(all(importlib.util.find_spec(name) for name in
    ["markdown", "bs4", "langchain_text_splitters"]), "requires rag text dependencies")
class DocumentIngestionTests(unittest.TestCase):
    def test_text_ingestion_preserves_sources_and_ignores_pdf_without_backend(self):
        with patch.dict(sys.modules, {"fitz": None, "pymupdf": None}):
            from circuit_ai.rag.chunking import prepare_docs, chunk_data
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "nested").mkdir()
                (root / "notes.MD").write_text("# Capacità\n\n**Carica** del condensatore.", encoding="utf-8")
                text = "Resistenza e corrente: Ω e µA. " * 100
                (root / "nested/notes.txt").write_text(text, encoding="utf-8")
                (root / "book.PDF").write_bytes(b"not a readable PDF")
                docs = prepare_docs(directory)
                self.assertEqual({d["file_name"] for d in docs}, {"notes.MD", "notes.txt"})
                by_name = {d["file_name"]: d for d in docs}
                self.assertEqual(by_name["notes.txt"]["payload"], text)
                self.assertIn("Capacità", by_name["notes.MD"]["payload"])
                self.assertIn("Carica", by_name["notes.MD"]["payload"])
                self.assertNotIn("**", by_name["notes.MD"]["payload"])
                chunks = chunk_data(docs)
                self.assertGreater(len(chunks), len(docs))
                for doc in docs:
                    selected = [c for c in chunks if c["source"] == doc["source"]]
                    self.assertEqual(Path(doc["source"]), (root / ("nested/notes.txt" if doc["file_name"] == "notes.txt" else "notes.MD")).resolve())
                    self.assertEqual([c["index_chunk"] for c in selected], list(range(len(selected))))
                    for chunk in selected:
                        self.assertEqual(chunk["file_name"], doc["file_name"])
                        self.assertTrue(0 < len(chunk["payload"]) <= 1000)
                        self.assertIn(chunk["payload"], doc["payload"])

    def test_pdf_only_directory_stops_before_loading_embedding_model(self):
        from circuit_ai.rag.index import main
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "book.pdf").write_bytes(b"unused PDF")
            with patch.object(sys, "argv", ["index", directory]), patch.dict(sys.modules,
                {"circuit_ai.rag.vectorstore": None, "fitz": None, "pymupdf": None}):
                with self.assertRaisesRegex(SystemExit, "Nessun contenuto MD o TXT"):
                    main()


@unittest.skipUnless(importlib.util.find_spec("qdrant_client"), "requires rag Qdrant dependency")
class LocalRetrievalTests(unittest.TestCase):
    def test_real_local_index_reindex_and_retrieval_with_fixed_embeddings(self):
        sentence = ModuleType("sentence_transformers")
        sentence.SentenceTransformer = Embedder
        path = Path(__file__).resolve().parents[1] / "circuit_ai/rag/vectorstore.py"
        spec = importlib.util.spec_from_file_location("local_index_under_test", path)
        module = importlib.util.module_from_spec(spec)
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, {"sentence_transformers": sentence}):
            spec.loader.exec_module(module)
            store = module.VectorStore(directory)
            try:
                store.create_collection("electronics")
                def chunk(source, index, text):
                    return {"source": source, "file_name": source, "index_chunk": index, "payload": text}
                store.index_data([chunk("a.md", 0, "old"), chunk("a.md", 1, "tail"), chunk("b.txt", 0, "other")], "electronics")
                store.index_data([chunk("a.md", 0, "updated")], "electronics")
                points = store.search_chunks("capacitor", "electronics").points
                self.assertEqual({p.payload["source"]: p.payload["text"] for p in points},
                    {"a.md": "updated", "b.txt": "other"})
                self.assertEqual(len(points), 2)
            finally:
                store.client.close()
