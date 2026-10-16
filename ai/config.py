"""Configurazione solo server-side. Nessun fallback automatico al cloud."""
from dataclasses import dataclass
from pathlib import Path
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
                   rag_enabled=os.getenv("RAG_ENABLED", "false").lower() == "true")


def create_model(settings: Settings):
    common = dict(model=settings.model, api_key=settings.api_key, temperature=0,
                  timeout=settings.request_timeout, max_retries=2)
    if settings.provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        if settings.base_url:
            common["base_url"] = settings.base_url
        return ChatAnthropic(**common, max_tokens=4096)
    from langchain_openai import ChatOpenAI
    if settings.base_url:
        common["base_url"] = settings.base_url
    return ChatOpenAI(**common)
