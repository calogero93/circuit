"""Errori pubblici del tutor, senza esporre credenziali o payload del modello."""
from openai import APIConnectionError, APIStatusError, APITimeoutError
from psycopg import Error as PostgresError
from psycopg_pool import PoolTimeout


def tutor_error(exc):
    """Stesso stato e messaggio per HTTP e stream; i dettagli restano nei log."""
    if isinstance(exc, (TimeoutError, APITimeoutError)):
        return 504, "timeout", "Il tutor ha superato il tempo di risposta"
    if isinstance(exc, APIConnectionError):
        return 502, "model_unavailable", (
            "Il server LLM non è raggiungibile. Verifica che LM Studio sia avviato "
            "e che LLM_BASE_URL corrisponda alla sua porta (predefinita: 1235). "
            "Dopo una modifica alla configurazione riavvia il servizio AI.")
    if isinstance(exc, APIStatusError):
        return 502, "model_request_rejected", (
            "Il server LLM ha rifiutato la richiesta. Verifica modello caricato, "
            "supporto tool calling e limite di contesto. Consulta il log del servizio AI.")
    if isinstance(exc, (PostgresError, PoolTimeout)):
        return 503, "memory_unavailable", (
            "La memoria PostgreSQL non è disponibile. Verifica che il database "
            "sia avviato e che DATABASE_URL sia corretta.")
    return 502, "invalid_response", (
        "Il servizio AI non ha completato una risposta valida. "
        "Consulta il log del servizio AI per il dettaglio dell'errore.")
