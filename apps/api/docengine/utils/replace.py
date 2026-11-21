"""Reemplazo de texto que cruza runs (python-docx y python-pptx).

Word y PowerPoint parten el texto en runs arbitrarios ("{{cli" + "ente}}").
Reemplazar run por run no encuentra esos tokens; acá se trabaja sobre el texto
concatenado del párrafo y se reescribe solo en los runs afectados, preservando
el formato del primer run de cada coincidencia.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

_WRAPPED = re.compile(r"^(\{\{.*\}\}|\{.*\}|\[\[.*\]\]|\[.*\]|<<.*>>|<.*>)$", re.S)


def replace_in_runs(runs: list[Any], find: str, repl: str) -> int:
    """Reemplaza todas las apariciones de `find` en la secuencia de runs. Devuelve la cantidad."""
    if not find or not runs:
        return 0
    count = 0
    search_from = 0
    while True:
        texts = [r.text or "" for r in runs]
        full = "".join(texts)
        start = full.find(find, search_from)
        if start == -1:
            return count
        end = start + len(find)
        bounds = []
        pos = 0
        for t in texts:
            bounds.append((pos, pos + len(t)))
            pos += len(t)
        first = next(i for i, (s, e) in enumerate(bounds) if s <= start < e)
        last = next(i for i, (s, e) in enumerate(bounds) if s < end <= e)
        f_start = bounds[first][0]
        if first == last:
            t = texts[first]
            runs[first].text = t[: start - f_start] + repl + t[end - f_start:]
        else:
            runs[first].text = texts[first][: start - f_start] + repl
            for j in range(first + 1, last):
                runs[j].text = ""
            l_start = bounds[last][0]
            runs[last].text = texts[last][end - l_start:]
        count += 1
        search_from = start + len(repl)


def placeholder_variants(key: str) -> list[str]:
    """Formas de buscar una clave de plantilla: tal cual si ya viene envuelta,
    si no `{{clave}}` y `{{ clave }}`."""
    k = str(key).strip()
    if _WRAPPED.match(k):
        return [k]
    return [f"{{{{{k}}}}}", f"{{{{ {k} }}}}"]


def apply_changes(paragraph_runs: Iterable[list[Any]], changes: dict) -> int:
    """Aplica `template` y `replace` de `changes` sobre cada lista de runs."""
    template = changes.get("template") or {}
    replaces = changes.get("replace") or []
    if isinstance(replaces, dict):
        replaces = [{"find": k, "replace": v} for k, v in replaces.items()]
    pairs: list[tuple[str, str]] = []
    if isinstance(template, dict):
        for key, value in template.items():
            text = "" if value is None else (", ".join(map(str, value)) if isinstance(value, (list, tuple)) else str(value))
            for variant in placeholder_variants(key):
                pairs.append((variant, text))
    if isinstance(replaces, list):
        for item in replaces:
            if isinstance(item, dict) and item.get("find"):
                pairs.append((str(item["find"]), "" if item.get("replace") is None else str(item.get("replace"))))
    total = 0
    for runs in paragraph_runs:
        if not runs:
            continue
        joined = "".join(r.text or "" for r in runs)
        for find, repl in pairs:
            if find in joined:
                n = replace_in_runs(runs, find, repl)
                if n:
                    total += n
                    joined = "".join(r.text or "" for r in runs)
    return total
