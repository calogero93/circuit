from qdrant_client.models import PointStruct, VectorParams, Distance, HnswConfigDiff
from uuid import uuid4
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient


class VectorStore:
    def __init__(self, dataset_path: str):
        self.client = QdrantClient(path=dataset_path)
        self.embdedder = SentenceTransformer("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")

    def create_collection(self, collection_name:str):
        self.client.recreate_collection(
            collection_name=collection_name,
            vectors_config=VectorParams(
                size=384,
                distance=Distance.COSINE,
                hnsw_config=HnswConfigDiff(
                    m=32,
                    ef_construct=100
                )
            )
        )
    
    def index_data(self, chunks:list, collection_name:str):
        batch = 64
        for start in range(0, len(chunks), batch):
            chunks_batch = chunks[start:start+batch]
            payload_batch = [chunk["payload"] for chunk in chunks_batch]
            embeddings = self.embdedder.encode(payload_batch, show_progress_bar=True)

            vectors = embeddings.tolist()
            points = [PointStruct(
                    id=uuid4(),
                    vector=vector,
                    payload=chunk
                ) for chunk, vector in zip(chunks_batch, vectors)
            ]

            self.client.upsert(collection_name=collection_name, points=points)



