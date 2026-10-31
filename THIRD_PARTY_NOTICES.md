# Third-party materials and distribution

KirchForge's own source code is licensed under [MIT](LICENSE). This does not
relicense dependencies, model weights or educational source material. Existing
copyright notices, including the project's historical contributor name in
`LICENSE`, are preserved. No affiliation or endorsement by upstream authors or
model providers is implied.

## Browser builds

`npm run build` copies the project license to `dist/LICENSE` and generates
`dist/THIRD_PARTY_NOTICES.txt` from the license and
notice files of packages whose code is retained in the browser chunks, including
lazy-loaded chunks. **Keep that file with any redistributed build.** The build
fails if a retained package provides no license file and has no explicit,
version-specific fallback text.
It does not fetch licenses over the network.

The current frontend uses React, React DOM, Zustand, Three.js, React Three Fiber,
Drei, KaTeX and their retained transitive dependencies under MIT licenses.
KaTeX's bundled fonts are also MIT, not SIL OFL. Their separate copyright notice
is included. Two upstream texts are retained in [`licenses/`](licenses/):

- React Three Fiber 9.6.1: the npm artifact omits its license file;
  [upstream license at the published commit](https://github.com/pmndrs/react-three-fiber/blob/2a528745e9aa7c9e6cca41e404b59d45cf0d0cc7/LICENSE).
- [KaTeX fonts license](https://github.com/KaTeX/katex-fonts/blob/master/LICENSE),
  additional to the KaTeX package license.

Both texts were retrieved on 2026-10-31. When updating these dependencies, verify
that the retained text still applies. The generated notice covers the browser
build, not an entire installed Node/Python environment or a future installer.
The relay uses `ws` (MIT), installed from npm with its own license file.
Development tools and unused dependency modules are not thereby relicensed.
In particular, the build toolchain includes `lightningcss` and its native platform
packages under MPL-2.0. They are installed tooling, not incorporated into this
frontend's JavaScript bundle; redistribution of the toolchain is a separate case.

## Python and native dependencies

`ai/pyproject.toml` and `ai/uv.lock` describe separately installed dependencies;
their source or binary distributions are not vendored in this repository.
Most use MIT, BSD or Apache-2.0. Notable additional terms include:

| Dependency | License / consideration |
| --- | --- |
| `psycopg`, `psycopg-binary`, `psycopg-pool` | LGPL-3.0-only; the binary package also bundles native libraries such as libpq |
| `certifi` | MPL-2.0 |
| `orjson` | MPL-2.0 AND (Apache-2.0 OR MIT), including native code |
| `tqdm` | MPL-2.0 AND MIT |
| `regex` | Apache-2.0 AND CNRI-Python |
| Optional PyTorch/CUDA dependencies of the RAG extra | Include NVIDIA components with their own proprietary terms; not all are MIT/Apache |

These licenses do not automatically change the license of this application's
own code. Installing dependencies locally is different from redistributing an
installed environment. Anyone distributing wheels, containers, native binaries
or an installer must retain the applicable notices and licenses and satisfy
corresponding-source / replacement or relinking requirements where applicable.
MPL obligations apply to covered files, not automatically every application
file. NVIDIA redistribution permissions must be checked for the actual native
artifacts and versions; this repository does not grant those permissions.

Authoritative references:
[Psycopg installation and bundled libraries](https://www.psycopg.org/psycopg3/docs/basic/install.html),
[Psycopg license](https://github.com/psycopg/psycopg/blob/master/LICENSE.txt),
[MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
[orjson licenses](https://github.com/ijl/orjson#license).

PyMuPDF is not a project dependency. RAG ingestion supports local Markdown and
text files. Separate optional textbook-verification commands invoke an existing
local `pdftotext` installation; Poppler and ngspice are not bundled here.

## Educational excerpts and evaluation data

The selected excerpts and adaptations under `ai/evals/textbook/` and
`ai/evals/baseline/` derive in part from **Tony R. Kuphaldt,
Lessons In Electric Circuits**:

- [Volume I — DC](https://www.ibiblio.org/kuphaldt/electricCircuits/DC/index.html)
- [Volume II — AC](https://www.ibiblio.org/kuphaldt/electricCircuits/AC/index.html)
- [Volume III — Semiconductors](https://www.ibiblio.org/kuphaldt/electricCircuits/SEMI/index.html)
- [Volume IV — Digital](https://www.ibiblio.org/kuphaldt/electricCircuits/DIGI/index.html)
- [Volume V — Reference](https://www.ibiblio.org/kuphaldt/electricCircuits/REF/index.html)

The consulted copies identify **[Creative Commons Attribution 4.0 International
(CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)** in their license
appendices. Preserve this attribution and the source metadata when reusing
excerpts or adaptations. The original PDFs remain local and are not distributed
through Git. They are excluded as a project data policy; CC BY is not a blanket
prohibition on redistribution.

Questions and reference answers were selected, translated or adapted into Italian
with AI assistance. Idealized circuit fixtures and computed ngspice results were
added for evaluation. The dataset files retain editions, sections, page ranges,
source URLs, hashes and adaptation descriptions; the MIT license does not replace
the source license. These adaptations and experimental results are not an
endorsement by Kuphaldt, and no expert human approval is claimed merely because
an example came from a book.

## AI model references

Model names identify third-party models; this project does not claim to own or
train them. No model weights are distributed in Git. Local inference and optional
downloads are separate from redistribution:

| Reference | Upstream license information |
| --- | --- |
| Gemma 4 (default local tutor configuration) | [Google's Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) and [Apache-2.0 license](https://ai.google.dev/gemma/apache_2); older Gemma families can have different terms |
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (optional RAG embeddings) | [Model card: Apache-2.0](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) |
| `MoritzLaurer/mDeBERTa-v3-base-mnli-xnli` (NLI verifier) | [Model card: MIT](https://huggingface.co/MoritzLaurer/mDeBERTa-v3-base-mnli-xnli); revision pinned by the preparation command |
| `MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli` (earlier NLI configuration) | [Model card: MIT](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli); also selectable by the preparation command |

For NLI research attribution: Moritz Laurer, Wouter van Atteveldt, Andreu Salleras
Casas and Kasper Welbers (2022), *Less Annotating, More Classifying — Addressing
the Data Scarcity Issue of Supervised Machine Learning with Deep Transfer
Learning and BERT-NLI*, [paper](https://osf.io/74b8k/).

Verify the model card, license and provenance of the **actual artifact** chosen
in LM Studio or another runtime, particularly community conversions or different
model families. An OpenAI-compatible endpoint describes a protocol, not ownership
or licensing. Cloud providers are optional and require explicit configuration;
their service terms and data handling are separate from the project MIT license.
