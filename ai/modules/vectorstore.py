"""Indice documentale facoltativo, separato dalla memoria PostgreSQL del tutor."""
from collections import defaultdict
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, FieldCondition, Filter, MatchValue, PointStruct, VectorParams
from sentence_transformers import SentenceTransformer


class VectorStore:
    def __init__(self, dataset_path: str):
        # Nel tutor le ricerche sono serializzate da search_lock, ma possono
        # essere eseguite da thread diversi del pool asyncio.to_thread.
        self.client = QdrantClient(path=dataset_path, force_disable_check_same_thread=True)
        self.embedder = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")

    def create_collection(self, collection_name: str):
        if not self.client.collection_exists(collection_name):
            self.client.create_collection(collection_name=collection_name,
                vectors_config=VectorParams(size=self.embedder.get_sentence_embedding_dimension(), distance=Distance.COSINE))

    def index_data(self, chunks: list, collection_name: str):
        # Sostituisce solo i documenti esplicitamente passati. Una seconda
        # indicizzazione non duplica i punti e rimuove anche i vecchi chunk finali.
        documents = defaultdict(list)
        for chunk in chunks:
            documents[chunk.get("source", chunk["file_name"])].append(chunk)
        for source, document_chunks in documents.items():
            points = []
            for start in range(0, len(document_chunks), 64):
                batch = document_chunks[start:start + 64]
                vectors = self.embedder.encode([c["payload"] for c in batch], show_progress_bar=False).tolist()
                points.extend(PointStruct(id=str(uuid5(NAMESPACE_URL, f"{source}#{chunk['index_chunk']}")),
                    vector=vector, payload={**chunk, "source": source, "text": chunk["payload"]})
                    for chunk, vector in zip(batch, vectors))
            # Calcola prima tutti gli embedding: un errore di estrazione o modello
            # non cancella l'indice precedente del documento.
            self.client.delete(collection_name, points_selector=Filter(must=[FieldCondition(key="source", match=MatchValue(value=source))]))
            for start in range(0, len(points), 64):
                self.client.upsert(collection_name=collection_name, points=points[start:start + 64])

    def search_chunks(self, query: str, collection_name: str):
        vector = self.embedder.encode(query, show_progress_bar=False)
        return self.client.query_points(collection_name=collection_name, query=vector.tolist(), limit=5)
