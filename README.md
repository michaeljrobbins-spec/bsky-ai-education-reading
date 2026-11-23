# AI in education on Bluesky

A one-time sample of up to 2,000 English-language Bluesky posts from the last 12 months about AI detectors (Turnitin, GPTZero…), students cheating with AI, and how teachers are responding. The posts are scored with VADER sentiment and grouped with LDA topic models, and the results are published as an interactive D3 dashboard on GitHub Pages.

The dashboard is for **exploring** the conversation. It has filters, linked charts and random excerpts. It makes no claims of its own.

## How it works

| Step | Where | What |
|---|---|---|
| `pipeline/collect.py` | GitHub Actions | Logs in with `BSKY_HANDLE` / `BSKY_APP_PASSWORD`. Searches each of the last 52 weeks with the terms in `QUERIES`. Keeps English posts that mention both an AI term and an education term. Draws a random sample spread evenly across the weeks. |
| `pipeline/analyze.py` | GitHub Actions | Scores VADER sentiment on each post's full text. Fits LDA with 6, 8 and 10 topics. Assigns themes by keyword. Cuts excerpts. Writes `site/data/data.json`. |
| `site/` | GitHub Pages | Static dashboard (D3 7.9.0, bundled in `site/vendor/`). |
| `pipeline/textrules.py` | both | Every keyword rule: masking, relevance, themes, excerpts. |

## Privacy

- Handles, display names, DIDs and post URIs are never written to disk.
- `@mentions`, links and emails inside the text are masked before analysis.
- Full post text exists only in the Actions runner's temp directory during the run, and is deleted at the end. Only `data.json` is committed. It holds excerpts (at most 120 characters, and never more than 60% of a post), the week, a sentiment score, themes and topic numbers.
- Authors who ask Bluesky not to show their posts to logged-out viewers (`!no-unauthenticated`) are skipped.

## Running it (once)

1. Make the repository public; GitHub Pages needs that on free plans. Then go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Check that the repository secrets `BSKY_HANDLE` and `BSKY_APP_PASSWORD` exist.
3. Go to **Actions → Collect and publish → Run workflow**. It takes roughly 15–60 minutes. It commits `site/data/data.json` and deploys the site.

If data already exists, the workflow refuses to run unless you tick **overwrite**, so the sample isn't replaced by accident. Changes to `site/` on `main` redeploy the dashboard without collecting again.
