"""Local-only transport regressions: controlled proxy, no external endpoints."""
import asyncio
import os
import unittest
from unittest.mock import patch

import websockets
from circuit_ai.integrations.bridge import ToolBridge


class BridgeSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_environment_never_intercepts_local_bridge(self):
        hits = []
        async def proxy(reader, writer):
            hits.append(True)
            try:
                await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2)
                writer.write(b'HTTP/1.1 502 Controlled test proxy\r\nConnection: close\r\n\r\n')
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()
        async def relay(ws):
            self.assertEqual(ws.request.headers.get('Authorization'), 'Bearer test-capability')
            await ws.wait_closed()
        async with await asyncio.start_server(proxy, '127.0.0.1', 0) as proxy_server, \
                   websockets.serve(relay, '127.0.0.1', 0) as relay_server:
            proxy_url = f'http://127.0.0.1:{proxy_server.sockets[0].getsockname()[1]}'
            relay_url = f'ws://127.0.0.1:{relay_server.sockets[0].getsockname()[1]}'
            for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'WS_PROXY', 'ALL_PROXY']:
                hits.clear()
                with self.subTest(key=key), patch.dict(os.environ, {key: proxy_url}, clear=True):
                    failure = None
                    try:
                        async with ToolBridge(relay_url, token='test-capability'):
                            pass
                    except Exception as error:
                        failure = type(error).__name__
                    self.assertEqual(len(hits), 0, 'local connection reached the controlled proxy')
                    self.assertIsNone(failure, 'local relay did not connect directly')

    async def test_websockets_14_signature_remains_supported(self):
        seen = []
        async def legacy_connect(uri, *, open_timeout, max_size, additional_headers):
            seen.append((uri, additional_headers.get('Authorization') == 'Bearer test-capability'))
            return object()
        with patch('circuit_ai.integrations.bridge.websockets.connect', new=legacy_connect):
            await ToolBridge(token='test-capability').connect()
        self.assertEqual(seen, [('ws://127.0.0.1:8787', True)])

    async def test_new_proxy_capable_signature_gets_explicit_none(self):
        seen = []
        async def modern_connect(uri, *, proxy=True, **kwargs):
            seen.append(proxy)
            return object()
        with patch('circuit_ai.integrations.bridge.websockets.connect', new=modern_connect):
            await ToolBridge(token='test-capability').connect()
        self.assertEqual(seen, [None])

    async def test_runtime_rejects_stale_records_and_insecure_permissions(self):
        import json
        from pathlib import Path
        import tempfile
        from circuit_ai.integrations.bridge_runtime import capability_path, read_tutor_capability
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'XDG_RUNTIME_DIR': directory}):
            path = capability_path(8787)
            path.parent.parent.mkdir(mode=0o700)
            path.parent.mkdir(mode=0o700)
            record = {'version': 1, 'port': 8787, 'pid': os.getpid(), 'token': 'a' * 64}
            path.write_text(json.dumps(record))
            path.chmod(0o600)
            self.assertEqual(len(read_tutor_capability(8787)), 64)
            with patch('circuit_ai.integrations.bridge_runtime.os.kill', side_effect=ProcessLookupError):
                with self.assertRaisesRegex(RuntimeError, 'scaduta'):
                    read_tutor_capability(8787)
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, 'scaduta'):
                read_tutor_capability(8787)
            path.unlink()
            target = Path(directory) / 'target'
            target.write_text(json.dumps(record))
            target.chmod(0o600)
            path.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, 'scaduta'):
                read_tutor_capability(8787)
