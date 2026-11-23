"""Score sentiment (VADER), fit topic models (LDA), and write the dashboard data.

Input: the temporary file from collect.py (masked full text, never committed).
Output: site/data/data.json, which holds only short excerpts, weekly dates,
scores and topic assignments. No identifiers of any kind.
"""

import argparse
import datetime as dt
import json
import random
import re

import numpy as np
from sklearn.decomposition import LatentDirichletAllocation
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, CountVectorizer
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from textrules import AI_TERMS, EDU_TERMS, THEME_LABELS, THEMES, excerpt, themes_for

TOPIC_COUNTS = [6, 8, 10]
TOP_WORDS = 10
EXCERPT_CHARS = 120
EXCERPT_MAX_SHARE = 0.6   # an excerpt never shows more than 60% of its post
EXCERPT_MIN_CHARS = 25    # shorter than this -> no excerpt shown for that post
VADER_CUTOFF = 0.05       # standard VADER cut-offs for negative / positive

# Words removed before topic modelling, on top of scikit-learn's English list.
# Generic AI words appear in almost every post and would dominate every topic.
EXTRA_STOPWORDS = {
    "ai", "chatgpt", "gpt", "llm", "llms", "genai", "generative", "artificial",
    "intelligence", "user", "link", "email", "amp", "just", "like", "really",
    "dont", "doesnt", "didnt", "cant", "wont", "isnt", "arent", "wasnt", "im",
    "ive", "id", "youre", "youve", "theyre", "thats", "theres", "lets", "whats",
    "going", "got", "get", "gets", "thing", "things", "yeah", "lol", "oh",
    "know", "think", "way", "make", "people", "say", "said", "use", "using", "used",
}

_PLACEHOLDER = re.compile(r"\[(?:user|link|email)\]")


def monday(iso_ts):
    d = dt.datetime.fromisoformat(iso_ts.replace("Z", "+00:00")).date()
    return d - dt.timedelta(days=d.weekday())


def preprocess(text):
    text = _PLACEHOLDER.sub(" ", text.lower())
    return text.replace("’", "").replace("'", "")


def short_excerpt(text):
    limit = min(EXCERPT_CHARS, int(len(text) * EXCERPT_MAX_SHARE))
    if limit < EXCERPT_MIN_CHARS:
        return None
    return excerpt(text, limit)


def fit_topics(texts, seed):
    n = len(texts)
    vec = CountVectorizer(
        preprocessor=preprocess,
        stop_words=list(ENGLISH_STOP_WORDS | EXTRA_STOPWORDS),
        token_pattern=r"(?u)\b[a-z][a-z-]{2,}\b",
        min_df=5 if n >= 500 else 2,
        max_df=0.5,
    )
    X = vec.fit_transform(texts)
    vocab = np.array(vec.get_feature_names_out())
    models = {}
    for k in TOPIC_COUNTS:
        lda = LatentDirichletAllocation(
            n_components=k, learning_method="batch", max_iter=50, random_state=seed
        )
        doc_topic = lda.fit_transform(X)
        comp = lda.components_ / lda.components_.sum(axis=1, keepdims=True)
        topics = []
        for t in range(k):
            top = comp[t].argsort()[::-1][:TOP_WORDS]
            topics.append({
                "id": t,
                "words": vocab[top].tolist(),
                "weights": [round(float(w), 4) for w in comp[t][top]],
            })
        # Posts with no vocabulary words get a uniform row; mark them -1.
        empty = np.asarray(X.sum(axis=1)).ravel() == 0
        dominant = doc_topic.argmax(axis=1)
        dominant[empty] = -1
        models[k] = {"topics": topics, "dominant": dominant.tolist()}
    return models, int(X.shape[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    with open(args.inp) as f:
        raw = json.load(f)
    meta_in, posts = raw["meta"], raw["posts"]
    start = dt.date.fromisoformat(meta_in["window_start"])
    end = dt.date.fromisoformat(meta_in["window_end"])

    # Bluesky dates are set by the posting app and can be wrong; keep only
    # posts whose date falls inside the collection window.
    kept = []
    for p in posts:
        try:
            created = dt.datetime.fromisoformat(p["created"].replace("Z", "+00:00")).date()
        except (KeyError, ValueError, AttributeError):
            continue
        if start <= created < end:
            kept.append(p)

    vader = SentimentIntensityAnalyzer()
    texts = [p["text"] for p in kept]
    models, vocab_size = fit_topics(texts, args.seed)

    out_posts = []
    for i, p in enumerate(kept):
        s = vader.polarity_scores(_PLACEHOLDER.sub(" ", p["text"]))["compound"]
        out_posts.append({
            "w": monday(p["created"]).isoformat(),
            "x": short_excerpt(p["text"]),
            "s": round(s, 3),
            "r": 1 if p["is_reply"] else 0,
            "th": themes_for(p["text"]),
            "t": [models[k]["dominant"][i] for k in TOPIC_COUNTS],
        })
    random.Random(args.seed).shuffle(out_posts)

    meta = {
        "collected_at": meta_in["collected_at"],
        "window_start": meta_in["window_start"],
        "window_end": meta_in["window_end"],
        "queries": meta_in["queries"],
        "relevant_found": meta_in["relevant_found"],
        "filter_counts": meta_in["filter_counts"],
        "weekly_found": meta_in["weekly_found"],
        "max_pages_per_query_week": meta_in["max_pages_per_query_week"],
        "n_posts": len(out_posts),
        "dropped_bad_dates": len(posts) - len(kept),
        "themes": [{"key": k, "label": THEME_LABELS[k], "pattern": THEMES[k]} for k in THEMES],
        "relevance": {"ai": AI_TERMS, "edu": EDU_TERMS},
        "topic_counts": TOPIC_COUNTS,
        "vocab_size": vocab_size,
        "extra_stopwords": sorted(EXTRA_STOPWORDS),
        "vader_cutoff": VADER_CUTOFF,
        "excerpt_chars": EXCERPT_CHARS,
        "excerpt_max_share": EXCERPT_MAX_SHARE,
        "excerpt_min_chars": EXCERPT_MIN_CHARS,
    }
    data = {
        "meta": meta,
        "topics": {str(k): models[k]["topics"] for k in TOPIC_COUNTS},
        "posts": out_posts,
    }
    with open(args.out, "w") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(out_posts)} posts to {args.out}")


if __name__ == "__main__":
    main()
