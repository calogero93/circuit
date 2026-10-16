"""Verifica la sostituzione dei documenti senza scaricare il modello embedding."""
import importlib.util
from pathlib import Path
import sys
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
        path = Path(__file__).resolve().parents[1] / "modules/vectorstore.py"
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
