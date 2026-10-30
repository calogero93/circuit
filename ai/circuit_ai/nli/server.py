"""Servizio NLI dedicato su CPU/RAM: pesi locali caricati una volta, nessun LLM chat."""
import argparse
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from circuit_ai.evaluation.experiments import digest
from circuit_ai.nli.classifier import LocalNLI
from circuit_ai.contracts.verification import NliRequest, NliResponse, NliTokenCount


def create_app(model_dir=None, *, predictor=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.nli = predictor if predictor is not None else await asyncio.to_thread(LocalNLI, model_dir)
        app.state.identity = app.state.nli.identity
        app.state.model_id = digest(app.state.identity)
        app.state.lock = asyncio.Lock()
        yield

    app = FastAPI(title='Circuit NLI CPU', lifespan=lifespan)

    @app.get('/healthz')
    async def health():
        return {'ok': True, 'model_id': app.state.model_id, 'device': 'cpu'}

    @app.get('/v1/model')
    async def model(verify_files: bool = False):
        if verify_files:
            async with app.state.lock:
                await asyncio.to_thread(app.state.nli.assert_unchanged)
        return {'model_id': app.state.model_id, 'identity': app.state.identity, 'protocol_version': 2}

    @app.post('/v1/tokens', response_model=NliTokenCount)
    async def count_tokens(request: NliRequest):
        async with app.state.lock:
            count = await asyncio.to_thread(app.state.nli.count_tokens, request.premise, request.hypothesis)
        return NliTokenCount(model_id=app.state.model_id, tokens=count, max_tokens=app.state.nli.max_tokens)

    @app.post('/v1/nli', response_model=NliResponse)
    async def classify(request: NliRequest):
        try:
            async with app.state.lock:
                scores = await asyncio.to_thread(app.state.nli.predict, request.premise, request.hypothesis)
            return NliResponse(model_id=app.state.model_id, scores=scores, error=None)
        except Exception as exc:
            return NliResponse(model_id=app.state.model_id, scores=None,
                error=str(exc) if isinstance(exc, ValueError) else f'NLI non eseguito ({type(exc).__name__}).')

    return app


if __name__ == '__main__':
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8091)
    args = parser.parse_args()
    uvicorn.run(create_app(args.model_dir), host='127.0.0.1', port=args.port)
