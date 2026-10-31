"""Private local runtime convention shared with server/bridge-runtime.mjs."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _outside(path):
    return not path.is_relative_to(PROJECT_ROOT)


def _private_directory(path):
    try:
        info = path.lstat()
        return stat.S_ISDIR(info.st_mode) and not path.is_symlink() and (
            os.name == 'nt' or info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700)
    except OSError:
        return False


def capability_path(port):
    xdg = Path(os.environ['XDG_RUNTIME_DIR']) if os.environ.get('XDG_RUNTIME_DIR') else None
    base = xdg if xdg and _private_directory(xdg) and _outside(xdg.resolve()) else Path(tempfile.gettempdir())
    user_id = os.getuid() if hasattr(os, 'getuid') else hashlib.sha256(str(Path.home()).encode()).hexdigest()[:16]
    project_id = hashlib.sha256(str(PROJECT_ROOT).encode()).hexdigest()[:16]
    directory = base.resolve() / f'circuit-studio-{user_id}' / project_id
    if not _outside(directory):
        raise RuntimeError('La directory runtime privata deve essere esterna al progetto')
    return directory / f'tool-bridge-{port}.token'


def read_tutor_capability(port):
    try:
        path = capability_path(port)
        if not _private_directory(path.parent) or not _private_directory(path.parent.parent):
            raise ValueError('directory non privata')
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or path.is_symlink() or os.name != 'nt' and (
            info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600):
            raise ValueError('file non privato')
        record = json.loads(path.read_text())
        if record.get('version') != 1 or record.get('port') != port or type(record.get('pid')) is not int or record['pid'] < 1 or not re.fullmatch(r'[a-f0-9]{64}', record.get('token', '')):
            raise ValueError('capability non valida')
        os.kill(record['pid'], 0)  # Reject files left by a relay that has exited.
        return record['token']
    except (OSError, ValueError, TypeError, AttributeError):
        raise RuntimeError('Capability del bridge non disponibile o scaduta: avvia npm run tool-bridge dalla stessa copia del progetto') from None
