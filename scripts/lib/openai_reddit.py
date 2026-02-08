"""OpenRouter API client for Reddit discovery via OpenAI models."""

import json
import re
import sys
from typing import Any, Dict, List, Optional

from . import http
from .env import OPENROUTER_BASE_URL

OPENROUTER_RESPONSES_URL = f"{OPENROUTER_BASE_URL}/responses"



# Fallback model family order (kept for compatibility with tests and error handling)
MODEL_FALLBACK_ORDER = ["gpt-4o", "gpt-4.1", "gpt-4o-mini"]


def _is_model_access_error(error: http.HTTPError) -> bool:
    """Check if error is due to model access/verification issues."""
    if error.status_code not in (400, 403):
        return False
    if not error.body:
        return False
    body_lower = error.body.lower()
    return any(phrase in body_lower for phrase in [
        "verified",
        "organization must be",
        "does not have access",
        "not available",
        "not found",
    ])

def _log_error(msg: str):
    """Log error to stderr."""
    sys.stderr.write(f"[REDDIT ERROR] {msg}\n")
    sys.stderr.flush()


def _log_info(msg: str):
    """Log info to stderr."""
    sys.stderr.write(f"[REDDIT] {msg}\n")
    sys.stderr.flush()


# Depth configurations: (min, max) threads to request
# Request MORE than needed since many get filtered by date
DEPTH_CONFIG = {
    "quick": (15, 25),
    "default": (30, 50),
    "deep": (70, 100),
}

REDDIT_SEARCH_PROMPT = """Find Reddit discussion threads about: {topic}

STEP 1: EXTRACT THE CORE SUBJECT
Get the MAIN NOUN/PRODUCT/TOPIC:
- "best nano banana prompting practices" → "nano banana"
- "killer features of clawdbot" → "clawdbot"
- "top Claude Code skills" → "Claude Code"
DO NOT include "best", "top", "tips", "practices", "features" in your search.

STEP 2: SEARCH BROADLY
Search for the core subject:
1. "[core subject] site:reddit.com"
2. "reddit [core subject]"
3. "[core subject] reddit"

Return as many relevant threads as you find. We filter by date server-side.

STEP 3: INCLUDE ALL MATCHES
- Include ALL threads about the core subject
- Set date to "YYYY-MM-DD" if you can determine it, otherwise null
- We verify dates and filter old content server-side
- DO NOT pre-filter aggressively - include anything relevant

REQUIRED: URLs must contain "/r/" AND "/comments/"
REJECT: developers.reddit.com, business.reddit.com

Find {min_items}-{max_items} threads. Return MORE rather than fewer.

Return JSON:
{{
  "items": [
    {{
      "title": "Thread title",
      "url": "https://www.reddit.com/r/sub/comments/xyz/title/",
      "subreddit": "subreddit_name",
      "date": "YYYY-MM-DD or null",
      "why_relevant": "Why relevant",
      "relevance": 0.85
    }}
  ]
}}"""


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for retry."""
    noise = ['best', 'top', 'how to', 'tips for', 'practices', 'features',
             'killer', 'guide', 'tutorial', 'recommendations', 'advice',
             'prompting', 'using', 'for', 'with', 'the', 'of', 'in', 'on']
    words = topic.lower().split()
    result = [w for w in words if w not in noise]
    return ' '.join(result[:3]) or topic


def _build_subreddit_query(topic: str) -> str:
    """Build a subreddit-targeted search query for fallback."""
    core = _extract_core_subject(topic)
    sub_name = core.replace('.', '').replace(' ', '').lower()
    return f"r/{sub_name} site:reddit.com"


def search_reddit(
    api_key: str,
    model: str,
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    mock_response: Optional[Dict] = None,
    _retry: bool = False,
) -> Dict[str, Any]:
    """Search Reddit for relevant threads using OpenRouter with OpenAI models."""
    if mock_response is not None:
        return mock_response

    min_items, max_items = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/last30days-skill",
        "X-Title": "last30days-skill",
    }

    timeout = 90 if depth == "quick" else 120 if depth == "default" else 180

    payload = {
        "model": model,
        "tools": [
            {
                "type": "web_search",
                "filters": {
                    "allowed_domains": ["reddit.com"]
                }
            }
        ],
        "include": ["web_search_call.action.sources"],
        "input": REDDIT_SEARCH_PROMPT.format(
            topic=topic,
            from_date=from_date,
            to_date=to_date,
            min_items=min_items,
            max_items=max_items,
        ),
    }

    return http.post(OPENROUTER_RESPONSES_URL, payload, headers=headers, timeout=timeout)


def search_subreddits(
    subreddits: List[str],
    topic: str,
    from_date: str,
    to_date: str,
    count_per: int = 5,
) -> List[Dict[str, Any]]:
    """Search specific subreddits via Reddit's free JSON endpoint."""
    all_items = []
    core = _extract_core_subject(topic)

    for sub in subreddits:
        sub = sub.lstrip("r/")
        try:
            url = f"https://www.reddit.com/r/{sub}/search/.json"
            params = f"q={_url_encode(core)}&restrict_sr=on&sort=new&limit={count_per}&raw_json=1"
            full_url = f"{url}?{params}"

            headers = {
                "User-Agent": http.USER_AGENT,
                "Accept": "application/json",
            }

            data = http.get(full_url, headers=headers, timeout=15)
            children = data.get("data", {}).get("children", [])
            for child in children:
                if child.get("kind") != "t3":
                    continue
                post = child.get("data", {})
                permalink = post.get("permalink", "")
                if not permalink:
                    continue

                item = {
                    "id": f"RS{len(all_items)+1}",
                    "title": str(post.get("title", "")).strip(),
                    "url": f"https://www.reddit.com{permalink}",
                    "subreddit": str(post.get("subreddit", sub)).strip(),
                    "date": None,
                    "why_relevant": f"Found in r/{sub} supplemental search",
                    "relevance": 0.65,
                }

                created_utc = post.get("created_utc")
                if created_utc:
                    from . import dates as dates_mod
                    item["date"] = dates_mod.timestamp_to_date(created_utc)

                all_items.append(item)

        except http.HTTPError as e:
            _log_info(f"Subreddit search failed for r/{sub}: {e}")
        except Exception as e:
            _log_info(f"Subreddit search error for r/{sub}: {e}")

    return all_items


def _url_encode(text: str) -> str:
    """Simple URL encoding for query parameters."""
    import urllib.parse
    return urllib.parse.quote_plus(text)


def parse_reddit_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse OpenRouter response to extract Reddit items."""
    items = []

    if "error" in response and response["error"]:
        error = response["error"]
        err_msg = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        _log_error(f"OpenRouter API error: {err_msg}")
        if http.DEBUG:
            _log_error(f"Full error response: {json.dumps(response, indent=2)[:1000]}")
        return items

    output_text = ""
    if "output" in response:
        output = response["output"]
        if isinstance(output, str):
            output_text = output
        elif isinstance(output, list):
            for item in output:
                if isinstance(item, dict):
                    if item.get("type") == "message":
                        content = item.get("content", [])
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "output_text":
                                output_text = c.get("text", "")
                                break
                    elif "text" in item:
                        output_text = item["text"]
                elif isinstance(item, str):
                    output_text = item
                if output_text:
                    break

    if not output_text and "choices" in response:
        for choice in response["choices"]:
            if "message" in choice:
                output_text = choice["message"].get("content", "")
                break

    if not output_text:
        print(f"[REDDIT WARNING] No output text found in OpenRouter response. Keys present: {list(response.keys())}", flush=True)
        return items

    json_match = re.search(r'\{[\s\S]*"items"[\s\S]*\}', output_text)
    if json_match:
        try:
            data = json.loads(json_match.group())
            items = data.get("items", [])
        except json.JSONDecodeError:
            pass

    clean_items = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue

        url = item.get("url", "")
        if not url or "reddit.com" not in url:
            continue

        clean_item = {
            "id": f"R{i+1}",
            "title": str(item.get("title", "")).strip(),
            "url": url,
            "subreddit": str(item.get("subreddit", "")).strip().lstrip("r/"),
            "date": item.get("date"),
            "why_relevant": str(item.get("why_relevant", "")).strip(),
            "relevance": min(1.0, max(0.0, float(item.get("relevance", 0.5)))),
        }

        if clean_item["date"]:
            if not re.match(r'^\d{4}-\d{2}-\d{2}$', str(clean_item["date"])):
                clean_item["date"] = None

        clean_items.append(clean_item)

    return clean_items
