"""Download esplicito, una tantum, dei soli artefatti ONNX NLI a revisione fissata."""
import argparse
import json
from pathlib import Path
import re
from urllib.request import urlopen

from experiments import file_digest

MODEL = "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli"
REVISION = "0a71e92a985b6e1ad1828cf67ce9c459639c1dca"
FILES = ("config.json", "model.onnx", "tokenizer.json", "tokenizer_config.json",
    "special_tokens_map.json", "sentencepiece.bpe.model")
MODELS = {
    'minilm': (MODEL, REVISION, {name: 'onnx/' + name for name in FILES}),
    'mdeberta': ('MoritzLaurer/mDeBERTa-v3-base-mnli-xnli',
        '8adb042d524ecd5c26d3e3ba0e3fbcf7e2d0864c',
        {name: 'onnx/' + name if name == 'model.onnx' else name for name in
            ('config.json', 'model.onnx', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'spm.model', 'added_tokens.json')}),
}


def prepare(output, *, revision=None, model='minilm'):
    repo, default_revision, files = MODELS[model]
    revision = revision or default_revision
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Usare il commit SHA immutabile del modello, non main")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    metadata = output / "source.json"
    if metadata.exists():
        previous = json.loads(metadata.read_text())
        if previous.get("model") != repo or previous.get("revision") != revision:
            raise ValueError("Directory già associata a un altro modello/revisione")
        if all((output / name).is_file() and file_digest(output / name) == digest for name, digest in previous['files_sha256'].items()) and set(previous['files_sha256']) == set(files):
            print("Modello già presente e hash verificati: nessun download.")
            return output
        raise ValueError("Artefatti locali modificati: usare una nuova directory per conservare la provenienza")
    for name, remote in files.items():
        path = output / name
        temporary = path.with_suffix(path.suffix + ".part")
        url = f"https://huggingface.co/{repo}/resolve/{revision}/{remote}"
        print(f"Download esplicito: {name}", flush=True)
        with urlopen(url, timeout=120) as response, temporary.open('wb') as stream:
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
        temporary.replace(path)
    metadata.write_text(json.dumps({"model": repo, "revision": revision,
        "model_card": f"https://huggingface.co/{repo}/blob/{revision}/README.md",
        "files_sha256": {name: file_digest(output / name) for name in files}}, indent=2) + '\n')
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="Directory dei pesi, preferibilmente in .local-notes/models (ignorata da Git)")
    parser.add_argument("--model", choices=sorted(MODELS), default='minilm')
    parser.add_argument("--revision")
    args = parser.parse_args()
    print(prepare(args.output, revision=args.revision, model=args.model))
