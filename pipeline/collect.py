"""Collect a one-time sample of Bluesky posts about AI in education.

Runs inside GitHub Actions. Logs in with BSKY_HANDLE / BSKY_APP_PASSWORD,
searches week by week over the last 12 months, keeps posts that pass the
relevance filter, then draws an evenly spread random sample.

Privacy: the output file holds only what analysis needs - post text with
@mentions and links already masked, the post date, and whether it is a reply.
No handles, DIDs, display names or post URIs are written anywhere. The output
lives in the runner's temp directory and is never committed.
"""

import argparse
import datetime as dt
import json
import os
import random
import sys
import time

import requests

from textrules import clean_text, is_relevant

SERVICE = os.environ.get("BSKY_SERVICE", "https://bsky.social")

# Search terms, grouped by the theme they were written for. Themes shown on the
# dashboard are assigned from each post's own text (see textrules.THEMES), not
# from the query that happened to find it.
QUERIES = [
    # detectors
    "turnitin",
    '"AI detector"',
    '"AI detection"',
    "gptzero",
    # cheating
    "cheating chatgpt",
    "cheating AI",
    '"AI essay"',
    '"academic integrity" AI',
    '"students using chatgpt"',
    # teacher response
    "teachers AI",
    "professor chatgpt",
    '"AI policy" class',
    '"blue books"',
    "handwritten exam AI",
]

PAGE_LIMIT = 100          # max allowed by searchPosts
MAX_PAGES_PER_QUERY = 5   # per query per week: up to 500 posts
PAUSE = 0.25              # seconds between requests
OPT_OUT_LABEL = "!no-unauthenticated"


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def login(handle, password):
    r = requests.post(
        f"{SERVICE}/xrpc/com.atproto.server.createSession",
        json={"identifier": handle, "password": password},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["accessJwt"]


def search(session, token, q, since, until, cursor=None):
    params = {
        "q": q,
        "sort": "latest",
        "since": since,
        "until": until,
        "lang": "en",
        "limit": PAGE_LIMIT,
    }
    if cursor:
        params["cursor"] = cursor
    for attempt in range(6):
        r = session.get(
            f"{SERVICE}/xrpc/app.bsky.feed.searchPosts",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        if r.status_code in (429, 500, 502, 503, 504):
            wait = 2 ** attempt * 5
            log(f"  HTTP {r.status_code}; waiting {wait}s")
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def opted_out(post):
    labels = (post.get("author") or {}).get("labels") or []
    return any(l.get("val") == OPT_OUT_LABEL for l in labels)


def week_windows(end, weeks):
    """Consecutive 7-day windows covering the `weeks` weeks before `end`."""
    start = end - dt.timedelta(weeks=weeks)
    out = []
    cur = start
    while cur < end:
        nxt = min(cur + dt.timedelta(weeks=1), end)
        out.append((cur, nxt))
        cur = nxt
    return out


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def collect_week(session, token, since, until):
    """Return {opaque_key: record} of relevant posts found in one week.

    The key is only used for de-duplication inside this process and is
    discarded before anything is written.
    """
    found = {}
    stats = {"seen": 0, "opted_out": 0, "irrelevant": 0, "non_english": 0}
    for q in QUERIES:
        cursor = None
        for _ in range(MAX_PAGES_PER_QUERY):
            data = search(session, token, q, iso(since), iso(until), cursor)
            time.sleep(PAUSE)
            posts = data.get("posts") or []
            for p in posts:
                key = p.get("uri")
                if not key or key in found:
                    continue
                stats["seen"] += 1
                rec = p.get("record") or {}
                if opted_out(p):
                    stats["opted_out"] += 1
                    continue
                langs = rec.get("langs") or []
                if langs and not any(l.lower().startswith("en") for l in langs):
                    stats["non_english"] += 1
                    continue
                text = clean_text(rec.get("text") or "", rec.get("facets"))
                if not is_relevant(text):
                    stats["irrelevant"] += 1
                    continue
                created = rec.get("createdAt") or p.get("indexedAt")
                found[key] = {
                    "created": created,
                    "text": text,
                    "is_reply": bool(rec.get("reply")),
                }
            cursor = data.get("cursor")
            if not cursor or len(posts) < PAGE_LIMIT:
                break
    return found, stats


def allocate(pool_sizes, total):
    """Spread `total` as evenly as possible across weeks (water-filling)."""
    alloc = [0] * len(pool_sizes)
    remaining = total
    open_idx = [i for i, n in enumerate(pool_sizes) if n > 0]
    while remaining > 0 and open_idx:
        share = max(1, remaining // len(open_idx))
        nxt = []
        for i in open_idx:
            take = min(share, pool_sizes[i] - alloc[i], remaining)
            alloc[i] += take
            remaining -= take
            if alloc[i] < pool_sizes[i]:
                nxt.append(i)
            if remaining == 0:
                break
        open_idx = nxt
    return alloc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-posts", type=int, default=2000)
    ap.add_argument("--weeks", type=int, default=52)
    ap.add_argument("--seed", type=int, default=20261123)
    args = ap.parse_args()

    handle = os.environ.get("BSKY_HANDLE")
    password = os.environ.get("BSKY_APP_PASSWORD")
    if not handle or not password:
        sys.exit("BSKY_HANDLE and BSKY_APP_PASSWORD must be set")

    token = login(handle, password)
    session = requests.Session()
    log("Logged in.")

    end = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    windows = week_windows(end, args.weeks)
    pools = []
    totals = {"seen": 0, "opted_out": 0, "irrelevant": 0, "non_english": 0}
    for i, (since, until) in enumerate(windows):
        # Tokens expire after ~2h; refresh by logging in again every 10 weeks.
        if i and i % 10 == 0:
            token = login(handle, password)
        found, stats = collect_week(session, token, since, until)
        for k in totals:
            totals[k] += stats[k]
        pools.append(list(found.values()))
        log(f"{since:%Y-%m-%d}: {len(found)} relevant posts ({stats})")

    rng = random.Random(args.seed)
    alloc = allocate([len(p) for p in pools], args.max_posts)
    sample = []
    for pool, n in zip(pools, alloc):
        sample.extend(rng.sample(pool, n))
    rng.shuffle(sample)

    meta = {
        "collected_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "window_start": windows[0][0].strftime("%Y-%m-%d"),
        "window_end": windows[-1][1].strftime("%Y-%m-%d"),
        "queries": QUERIES,
        "relevant_found": sum(len(p) for p in pools),
        "weekly_found": [
            {"week": s.strftime("%Y-%m-%d"), "found": len(p), "sampled": n}
            for (s, _), p, n in zip(windows, pools, alloc)
        ],
        "filter_counts": totals,
        "sampled": len(sample),
        "max_pages_per_query_week": MAX_PAGES_PER_QUERY,
    }
    with open(args.out, "w") as f:
        json.dump({"meta": meta, "posts": sample}, f)
    log(f"Wrote {len(sample)} posts.")


if __name__ == "__main__":
    main()
