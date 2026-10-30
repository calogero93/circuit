"""Verifica offline degli estratti pubblicati; Poppler serve solo per audit dei PDF."""
from pathlib import Path
import re
import shutil
import subprocess

from circuit_ai.evaluation.experiments import file_digest


def local_source(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"Fonte non locale alla repository: {relative}")
    return path


def verify_publications(corpus, root):
    publications = [source for source in corpus.values() if source.publication]
    if not publications:
        return 0
    executable = shutil.which("pdftotext")
    if executable is None:
        raise ValueError("La verifica dei PDF richiede pdftotext (Poppler); il normale runner usa gli estratti locali")
    hashes, pages = {}, {}
    normalize = lambda text: re.sub(r"\s+", " ", text).strip()
    for source in publications:
        publication = source.publication
        path = local_source(root, publication.pdf_path)
        if path not in hashes:
            hashes[path] = file_digest(path)
        if hashes[path] != publication.pdf_sha256:
            raise ValueError(f"PDF modificato o edizione diversa: {source.id}")
        texts = []
        for page in publication.pdf_pages:
            key = (path, page)
            if key not in pages:
                try:
                    output = subprocess.run([executable, "-f", str(page), "-l", str(page), "-layout", str(path), "-"],
                        capture_output=True, text=True, check=True, timeout=30)
                except (subprocess.SubprocessError, OSError) as exc:
                    raise ValueError(f"Impossibile verificare pagina {page} di {source.id}") from exc
                pages[key] = output.stdout
            texts.append(pages[key])
        if normalize(source.excerpt) not in normalize("\n".join(texts)):
            raise ValueError(f"Estratto assente dalle pagine PDF dichiarate: {source.id}")
    return len(publications)
