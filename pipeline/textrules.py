"""Text rules shared by collection and analysis.

Everything that decides what a post "is about" lives here, in plain regular
expressions, so the dashboard's methods section can describe them exactly.
"""

import re

# --- Masking -----------------------------------------------------------------

MENTION_FEATURE = "app.bsky.richtext.facet#mention"
LINK_FEATURE = "app.bsky.richtext.facet#link"

_URL = re.compile(r"https?://\S+", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_MENTION = re.compile(r"(?<![\w@])@[A-Za-z0-9][\w.-]*[A-Za-z0-9]")
_DOMAIN = re.compile(
    r"\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co|uk|ai|app|social|me|ly|"
    r"news|info|us|ca|au|de|xyz|blog|dev|tv|fm|link|page|site)\b(?:/\S*)?",
    re.I,
)
_SPACE = re.compile(r"\s+")


def _apply_facets(text, facets):
    """Replace mention and link facets (UTF-8 byte ranges) with placeholders."""
    if not facets:
        return text
    raw = text.encode("utf-8")
    spans = []
    for f in facets:
        idx = f.get("index") or {}
        start, end = idx.get("byteStart"), idx.get("byteEnd")
        if start is None or end is None or not (0 <= start < end <= len(raw)):
            continue
        types = {feat.get("$type") for feat in f.get("features") or []}
        if MENTION_FEATURE in types:
            spans.append((start, end, b"[user]"))
        elif LINK_FEATURE in types:
            spans.append((start, end, b"[link]"))
    for start, end, repl in sorted(spans, reverse=True):
        raw = raw[:start] + repl + raw[end:]
    return raw.decode("utf-8", errors="ignore")


def clean_text(text, facets=None):
    """Mask @mentions, links and emails; collapse whitespace."""
    text = _apply_facets(text, facets)
    text = _URL.sub("[link]", text)
    text = _EMAIL.sub("[email]", text)
    text = _MENTION.sub("[user]", text)
    text = _DOMAIN.sub("[link]", text)
    return _SPACE.sub(" ", text).strip()


# --- Relevance ---------------------------------------------------------------

AI_TERMS = (
    r"\b(?:ai|a\.i\.?|genai|gen ai|generative ai|artificial intelligence|"
    r"chat ?gpt|gpt-?\d*o?|llms?|large language models?|turnitin|gptzero)\b"
)
EDU_TERMS = (
    r"\b(?:students?|teach(?:er|ers|ing)|professors?|profs?|instructors?|"
    r"educators?|faculty|class(?:es|room|rooms)?|schools?|college|universit(?:y|ies)|"
    r"campus|essays?|homework|assignments?|exams?|grad(?:e|es|ed|ing)|"
    r"plagiari\w*|academi\w*|syllabus|syllabi|lectures?|undergrads?|"
    r"coursework|thesis|dissertations?|k-?12|pupils?|turnitin|gptzero|blue ?books?)\b"
)
_AI = re.compile(AI_TERMS, re.I)
_EDU = re.compile(EDU_TERMS, re.I)


def is_relevant(text):
    """A post is kept only if it mentions an AI term AND an education term."""
    return bool(_AI.search(text)) and bool(_EDU.search(text))


# --- Themes ------------------------------------------------------------------
# Multi-label: a post can belong to several themes, or none.

THEMES = {
    "detectors": (
        r"\b(?:turnitin|gptzero|zerogpt|originality\.?ai|copyleaks|"
        r"(?:ai|a\.i\.|chatgpt|gpt)[- ]?detect\w*|detect(?:or|ors|ion|ed|ing)|"
        r"false (?:positive|positives|accusations?)|flagged)\b"
    ),
    "cheating": (
        r"\b(?:cheat\w*|plagiari\w*|academic (?:dishonesty|integrity|misconduct)|"
        r"ghostwrit\w*|(?:used|using|use|uses) (?:chat ?gpt|ai|gpt) to (?:write|do|finish|complete))\b"
    ),
    "teachers": (
        r"\b(?:teachers?|professors?|instructors?|educators?|faculty|syllab(?:us|i)|"
        r"(?:ai|class|course|school) polic(?:y|ies)|blue ?books?|handwritten|hand-written|"
        r"in-class|in class (?:essays?|writing|exams?)|oral exams?|pen and paper|"
        r"assessments?|redesign\w*)\b"
    ),
}
THEME_LABELS = {
    "detectors": "AI detectors",
    "cheating": "Cheating & integrity",
    "teachers": "Teacher responses",
}
_THEMES = {k: re.compile(v, re.I) for k, v in THEMES.items()}


def themes_for(text):
    return [k for k, rx in _THEMES.items() if rx.search(text)]


# --- Excerpts ----------------------------------------------------------------

def excerpt(text, length=120):
    """A ~`length`-character window centred on the first theme or AI match."""
    if len(text) <= length:
        return text
    hits = [m.start() for rx in list(_THEMES.values()) + [_AI] for m in [rx.search(text)] if m]
    anchor = min(hits) if hits else 0
    start = max(0, anchor - length // 3)
    end = min(len(text), start + length)
    start = max(0, end - length)
    # Snap to word boundaries so the excerpt never starts or ends mid-word.
    if start > 0:
        sp = text.find(" ", start)
        start = sp + 1 if 0 <= sp < start + 20 else start
    if end < len(text):
        sp = text.rfind(" ", start, end)
        end = sp if sp > start + length // 2 else end
    out = text[start:end].strip()
    return ("…" if start > 0 else "") + out + ("…" if end < len(text) else "")
