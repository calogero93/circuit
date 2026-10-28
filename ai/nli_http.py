"""Stesso classificatore e soglie NLI via loopback; nessun download o fallback."""
import ipaddress
from urllib.parse import urlsplit

import httpx

from experiments import digest
from verification_schemas import NliRequest, NliResponse
from nli_verifier import LocalNLI


class HttpNLI(LocalNLI):
    def __init__(self, base_url='http://127.0.0.1:8091', *, confidence=.8, margin=.15, timeout=120):
        parsed = urlsplit(base_url)
        try:
            loopback = parsed.hostname == 'localhost' or ipaddress.ip_address(parsed.hostname or '').is_loopback
        except ValueError:
            loopback = False
        if parsed.scheme not in {'http','https'} or not loopback or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'','/'}:
            raise ValueError('Il classificatore NLI deve essere un servizio loopback senza credenziali o path')
        if not .5 < confidence <= 1 or not 0 <= margin <= 1 or timeout <= 0:
            raise ValueError('Soglie o timeout NLI non validi')
        self.client = httpx.Client(base_url=base_url.rstrip('/'), timeout=timeout, trust_env=False, follow_redirects=False)
        self.confidence, self.margin = confidence, margin
        try:
            response = self.client.get('/v1/model')
            response.raise_for_status()
            self.remote = response.json()
            if digest(self.remote['identity']) != self.remote['model_id']:
                raise ValueError('Identità NLI non coerente')
            self.identity = {'transport':'loopback-http', 'origin':base_url.rstrip('/'),
                'model_id':self.remote['model_id'], 'model':self.remote['identity'],
                'confidence':confidence, 'margin':margin, 'calibrated':False}
        except Exception:
            self.client.close()
            raise

    def predict(self, premise, hypothesis):
        request = NliRequest(premise=premise, hypothesis=hypothesis)
        response = self.client.post('/v1/nli', json=request.model_dump(mode='json'))
        response.raise_for_status()
        result = NliResponse.model_validate(response.json())
        if result.model_id != self.remote['model_id']:
            raise ValueError('Il modello NLI è cambiato durante la prova')
        if result.scores is None or result.error:
            raise ValueError(result.error or 'NLI non disponibile')
        return result.scores

    def assert_unchanged(self):
        response = self.client.get('/v1/model', params={'verify_files':'true'})
        response.raise_for_status()
        if response.json() != self.remote:
            raise ValueError('Identità o file NLI cambiati durante la prova')

    def close(self):
        self.client.close()
