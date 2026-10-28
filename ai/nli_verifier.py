"""Classificatore NLI ONNX su CPU: solo file locali, nessun download implicito."""
import json
from importlib.metadata import version
import math
from pathlib import Path
import re

from experiments import file_digest
from verification_schemas import NliCheck, NliScores


def sentences(text):
    """Frammenti originali; non spezza punti decimali o acronimi fra lettere."""
    output, start = [], 0
    for match in re.finditer(r"[!?\n]+|\.(?=\s|$)", text):
        end = match.end()
        if text[start:end].strip():
            output.append(text[start:end].strip())
        start = end
    if text[start:].strip():
        output.append(text[start:].strip())
    return output


class LocalNLI:
    def __init__(self, directory, *, confidence=0.8, margin=0.15, threads=2):
        if not 0.5 < confidence <= 1 or not 0 <= margin <= 1 or not 1 <= threads <= 32:
            raise ValueError("Soglie NLI o numero thread non validi")
        self.directory = Path(directory).resolve()
        if not self.directory.is_dir():
            raise ValueError("Modello NLI locale assente: fornire una directory ONNX già scaricata")
        config = json.loads((self.directory / "config.json").read_text())
        labels = {int(i): label.lower() for i, label in config.get("id2label", {}).items()}
        if set(labels) != {0, 1, 2} or set(labels.values()) != {"entailment", "neutral", "contradiction"}:
            raise ValueError("config.json deve dichiarare esplicitamente le tre etichette NLI: nessun ordine presunto")
        # Dipendenze opzionali: importare il modulo non carica pesi o apre la rete.
        import onnxruntime as ort
        from tokenizers import Tokenizer
        ort.disable_telemetry_events()
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(self.directory / "model.onnx"), sess_options=options,
            providers=["CPUExecutionProvider"])
        self.tokenizer = Tokenizer.from_file(str(self.directory / "tokenizer.json"))
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.labels = labels
        self.confidence, self.margin = confidence, margin
        self.max_tokens = min(512, int(config.get("max_position_embeddings", 512)))
        self.files = self._hashes()
        self.identity = {"backend": "onnxruntime", "version": ort.__version__, "provider": "CPUExecutionProvider",
            "directory": str(self.directory), "files_sha256": self.files, "labels": labels,
            "confidence": confidence, "margin": margin, "max_tokens": self.max_tokens, "threads": threads,
            "dependency_versions": {name: version(name) for name in ("onnxruntime", "tokenizers", "numpy")},
            "calibrated": False}

    def _hashes(self):
        files = [p for p in self.directory.rglob("*") if p.is_file()]
        if any(not p.resolve().is_relative_to(self.directory) for p in files):
            raise ValueError("Il modello NLI deve contenere soltanto file locali alla propria directory")
        return {p.relative_to(self.directory).as_posix(): file_digest(p) for p in sorted(files)}

    def assert_unchanged(self):
        if self.files != self._hashes():
            raise ValueError("File del modello NLI cambiati durante la verifica")

    def predict(self, premise, hypothesis):
        import numpy as np
        encoded = self.tokenizer.encode(premise, hypothesis)
        if len(encoded.ids) > self.max_tokens:
            raise ValueError("Coppia NLI oltre il limite del modello: nessuna troncatura silenziosa")
        available = {"input_ids": encoded.ids, "attention_mask": encoded.attention_mask,
            "token_type_ids": encoded.type_ids}
        inputs = {}
        for item in self.session.get_inputs():
            if item.name not in available or item.type != "tensor(int64)":
                raise ValueError("Firma degli input ONNX non supportata")
            inputs[item.name] = np.asarray([available[item.name]], dtype=np.int64)
        raw = self.session.run(None, inputs)[0]
        if raw.shape != (1, 3) or not np.isfinite(raw).all():
            raise ValueError("Logit NLI non validi")
        values = [float(v) for v in raw[0]]
        weights = [math.exp(v - max(values)) for v in values]
        return NliScores(**{self.labels[i]: value / sum(weights) for i, value in enumerate(weights)})

    def check(self, premise, hypothesis, direction):
        try:
            scores = self.predict(premise, hypothesis)
            ranked = sorted(scores.model_dump().items(), key=lambda item: item[1], reverse=True)
            label, confidence = ranked[0]
            clear = confidence >= self.confidence and confidence - ranked[1][1] >= self.margin
            status = "pass" if clear and label == "entailment" else "fail" if clear and label == "contradiction" else "review"
            detail = "Supporto/contraddizione secondo soglie provvisorie, non calibrate." if status != "review" else "Rapporto neutro o classificazione incerta: non equivale a falso né a successo."
            return NliCheck(direction=direction, premise=premise, hypothesis=hypothesis,
                scores=scores, status=status, detail=detail)
        except (ValueError, RuntimeError) as exc:
            return NliCheck(direction=direction, premise=premise, hypothesis=hypothesis,
                scores=None, status="review", detail=str(exc) if isinstance(exc, ValueError) else "Errore operativo NLI; nessun supporto attribuito.")


def explanation_checks(payload, nli, references):
    if not references or not any(r.required for r in references):
        raise ValueError("Servono riferimenti fattuali NLI, distinti dagli obiettivi della rubric")
    sources = {s.id for s in payload.reference_sources}
    evidence = {t.call_id for t in payload.tool_outputs if t.result.ok}
    if any(set(r.source_ids) - sources or set(r.evidence_ids) - evidence for r in references):
        raise ValueError("Riferimento NLI associato a fonti o evidenze non disponibili")
    # Le domande non sono fatti: non si usano come premessa né si convertono
    # automaticamente gli obiettivi della rubric in affermazioni vere.
    premise = "\n".join(ref.statement for ref in references)
    forward = [nli.check(premise, sentence, "faithfulness") for sentence in sentences(payload.response.response)]
    backward = [nli.check(payload.response.response, ref.statement, "completeness") for ref in references if ref.required]
    return forward + backward


def semantic_status(checks, direction):
    from numeric_verification import aggregate
    grouped = {}
    for check in checks:
        if check.direction == direction:
            grouped.setdefault(check.hypothesis, []).append(check)
    if not grouped:
        return 'review'
    decisions = []
    for group in grouped.values():
        statuses = {c.status for c in group}
        if any(c.scores is None for c in group) or {'pass','fail'} <= statuses:
            decisions.append('review')  # Evidenze discordanti: nessuna compensazione.
        elif 'fail' in statuses:
            decisions.append('fail')
        elif 'pass' in statuses:
            decisions.append('pass')
        else:
            decisions.append('review')
    return aggregate(decisions)
