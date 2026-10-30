"""Contratto del servizio CPU; i punteggi finti testano il trasporto, non NLI."""
import json
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

from circuit_ai.evaluation.experiments import digest
from circuit_ai.nli.client import HttpNLI
from circuit_ai.nli.server import create_app
from circuit_ai.contracts.verification import NliScores


class Predictor:
    identity={'backend':'test-classifier','provider':'CPUExecutionProvider','weights':'pinned','max_tokens':512}
    calls=0
    max_tokens=512
    def count_tokens(self,p,h):return len(p.split())+len(h.split())+4
    def predict(self,p,h):
        self.calls+=1
        if h=='too-long':raise ValueError('Nessuna troncatura')
        return NliScores(entailment=.9,neutral=.05,contradiction=.05)
    def assert_unchanged(self):pass


class NliServiceTests(unittest.TestCase):
    def test_load_once_and_predict_multiple_requests_without_chat(self):
        predictor=Predictor()
        with patch('circuit_ai.nli.server.LocalNLI',return_value=predictor) as load:
            with TestClient(create_app('local-model')) as client:
                identity=client.get('/v1/model').json()
                for _ in range(2):
                    response=client.post('/v1/nli',json={'premise':'p','hypothesis':'h'})
                    self.assertEqual(response.status_code,200)
                    self.assertEqual(response.json()['model_id'],identity['model_id'])
                    self.assertEqual(response.json()['scores']['entailment'],.9)
                self.assertEqual(client.get('/healthz').json()['device'],'cpu')
                count=client.post('/v1/tokens',json={'premise':'two words','hypothesis':'one'}).json()
                self.assertEqual(count,{'model_id':identity['model_id'],'tokens':7,'max_tokens':512})
                self.assertEqual(client.post('/v1/nli',json={'premise':'p','hypothesis':'too-long'}).json()['scores'],None)
                self.assertEqual(client.post('/v1/nli',json={'premise':'','hypothesis':'h'}).status_code,422)
            self.assertEqual(load.call_count,1)
        self.assertEqual(predictor.calls,3)

    def test_client_uses_loopback_and_detects_model_changes(self):
        identity=Predictor.identity;model_id=digest(identity);calls=[];changed=False
        def handler(request):
            calls.append(request)
            if request.url.path=='/v1/model':return httpx.Response(200,json={'model_id':model_id,'identity':identity})
            if request.url.path=='/v1/tokens':return httpx.Response(200,json={
                'model_id':'changed' if changed else model_id,'tokens':12,'max_tokens':512})
            return httpx.Response(200,json={'model_id':'changed' if changed else model_id,
                'scores':{'entailment':.9,'neutral':.05,'contradiction':.05},'error':None})
        client=httpx.Client(base_url='http://127.0.0.1:8091',transport=httpx.MockTransport(handler))
        with patch('circuit_ai.nli.client.httpx.Client',return_value=client):nli=HttpNLI()
        self.assertEqual(nli.check('premise','hypothesis','faithfulness').status,'pass')
        self.assertEqual(json.loads(calls[-1].content),{'premise':'premise','hypothesis':'hypothesis'})
        self.assertEqual(nli.count_tokens('p','h'),12)
        nli.assert_unchanged();changed=True
        self.assertEqual(nli.check('p','h','faithfulness').status,'review')
        with self.assertRaises(ValueError):nli.count_tokens('p','h')
        nli.close()

    def test_cloud_urls_credentials_and_paths_rejected(self):
        for url in ['https://example.com','http://u:p@localhost:8091','http://localhost:8091/other','http://localhost:8091?x=y']:
            with self.assertRaises(ValueError):HttpNLI(url)


if __name__=='__main__':unittest.main()
