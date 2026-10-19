"""Configurazione solo server-side. Nessun fallback automatico al cloud."""
from dataclasses import dataclass
from pathlib import Path
import math
import os

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")


@dataclass(frozen=True)
class Settings:
    provider: str = "local"
    model: str = "google/gemma-4-e4b"
    base_url: str = "http://127.0.0.1:1234/v1"
    api_key: str = "local"
    bridge_url: str = "ws://127.0.0.1:8787"
    data_dir: Path = ROOT / "data"
    rag_enabled: bool = False
    request_timeout: float = 120.0
    max_tool_rounds: int = 8
    database_url: str = "postgresql://circuit:circuit@127.0.0.1:5433/circuit"
    summary_threshold_tokens: int = 6000
    context_max_tokens: int = 12000
    keep_recent_turns: int = 3
    max_schema_retries: int = 2
    temperature: float = 0.0
    seed: int | None = None
    max_output_tokens: int | None = None
    reasoning_effort: str | None = None
    model_revision: str | None = None
    model_quantization: str | None = None
    model_sha256: str | None = None
    model_file: Path | None = None
    runtime_name: str | None = None
    runtime_version: str | None = None
    hardware_id: str | None = None
    rag_corpus_revision: str | None = None

    @classmethod
    def from_env(cls):
        provider = os.getenv("LLM_PROVIDER", "local").lower()
        if provider not in {"local", "openai", "anthropic"}:
            raise ValueError("LLM_PROVIDER deve essere local, openai o anthropic")
        if provider == "local":
            model = os.getenv("LLM_MODEL", "google/gemma-4-e4b")
            base_url = os.getenv("LLM_BASE_URL", "http://127.0.0.1:1234/v1")
            key = os.getenv("LLM_API_KEY", "local")
        else:
            model = os.getenv("LLM_MODEL", "")
            key = os.getenv(f"{provider.upper()}_API_KEY", "")
            base_url = os.getenv("LLM_BASE_URL", "")
            if not model or not key:
                raise ValueError("Per un provider esterno servono LLM_MODEL e la relativa API key")
        return cls(provider=provider, model=model, base_url=base_url, api_key=key,
                   bridge_url=os.getenv("TOOL_BRIDGE_URL", "ws://127.0.0.1:8787"),
                   data_dir=Path(os.getenv("AI_DATA_DIR", str(ROOT / "data"))).resolve(),
                   rag_enabled=os.getenv("RAG_ENABLED", "false").lower() == "true",
                   database_url=os.getenv("DATABASE_URL", cls.database_url),
                   summary_threshold_tokens=int(os.getenv("AI_SUMMARY_THRESHOLD_TOKENS", "6000")),
                   context_max_tokens=int(os.getenv("AI_CONTEXT_MAX_TOKENS", "12000")),
                   keep_recent_turns=int(os.getenv("AI_KEEP_RECENT_TURNS", "3")),
                   request_timeout=float(os.getenv("AI_REQUEST_TIMEOUT", "120")),
                   max_tool_rounds=int(os.getenv("AI_MAX_TOOL_ROUNDS", "8")),
                   temperature=float(os.getenv("LLM_TEMPERATURE", "0")),
                   seed=int(os.environ["LLM_SEED"]) if os.getenv("LLM_SEED") else None,
                   max_output_tokens=int(os.environ["LLM_MAX_OUTPUT_TOKENS"]) if os.getenv("LLM_MAX_OUTPUT_TOKENS") else None,
                   reasoning_effort=os.getenv("LLM_REASONING_EFFORT") or None,
                   model_revision=os.getenv("LLM_MODEL_REVISION") or None,
                   model_quantization=os.getenv("LLM_MODEL_QUANTIZATION") or None,
                   model_sha256=os.getenv("LLM_MODEL_SHA256") or None,
                   model_file=Path(os.environ["LLM_MODEL_FILE"]).expanduser() if os.getenv("LLM_MODEL_FILE") else None,
                   runtime_name=os.getenv("LLM_RUNTIME_NAME") or None,
                   runtime_version=os.getenv("LLM_RUNTIME_VERSION") or None,
                   hardware_id=os.getenv("LLM_HARDWARE_ID") or None,
                   rag_corpus_revision=os.getenv("RAG_CORPUS_REVISION") or None)

    def __post_init__(self):
        if not 0 < self.summary_threshold_tokens < self.context_max_tokens:
            raise ValueError("La soglia riassunti deve essere positiva e inferiore al limite di contesto")
        if self.keep_recent_turns < 1 or self.max_tool_rounds < 1 or self.request_timeout <= 0:
            raise ValueError("Numero di turni, round e timeout devono essere positivi")
        if not math.isfinite(self.temperature) or not 0 <= self.temperature <= 2:
            raise ValueError("LLM_TEMPERATURE deve essere fra 0 e 2")
        if self.max_output_tokens is not None and self.max_output_tokens < 1:
            raise ValueError("LLM_MAX_OUTPUT_TOKENS deve essere positivo")
        if self.reasoning_effort is not None:
            if self.reasoning_effort not in {"none", "minimal", "low", "medium", "high", "xhigh"}:
                raise ValueError("LLM_REASONING_EFFORT deve essere none, minimal, low, medium, high o xhigh")
            if self.provider == "anthropic":
                raise ValueError("LLM_REASONING_EFFORT non è supportato dall'adattatore Anthropic")
        if self.model_sha256 and (len(self.model_sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in self.model_sha256)):
            raise ValueError("LLM_MODEL_SHA256 deve essere un hash SHA-256 esadecimale")


def create_model(settings: Settings):
    common = dict(model=settings.model, api_key=settings.api_key, temperature=settings.temperature,
                  timeout=settings.request_timeout, max_retries=2)
    if settings.provider == "anthropic":
        if settings.seed is not None:
            raise ValueError("LLM_SEED non è supportato dall'adattatore Anthropic")
        from langchain_anthropic import ChatAnthropic
        if settings.base_url:
            common["base_url"] = settings.base_url
        return ChatAnthropic(**common, max_tokens=settings.max_output_tokens or 4096)
    from langchain_openai import ChatOpenAI
    if settings.base_url:
        common["base_url"] = settings.base_url
    if settings.seed is not None:
        common["seed"] = settings.seed
    if settings.max_output_tokens is not None:
        common["max_tokens"] = settings.max_output_tokens
    if settings.reasoning_effort is not None:
        common["reasoning_effort"] = settings.reasoning_effort
    return ChatOpenAI(**common)
