"""Bird CLI client for X (Twitter) search."""

import json
import shutil
import subprocess
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# Depth configurations: number of results to request
DEPTH_CONFIG = {
    "quick": 12,
    "default": 30,
    "deep": 60,
}


def _log(msg: str):
    """Log to stderr."""
    sys.stderr.write(f"[Bird] {msg}\n")
    sys.stderr.flush()


def is_bird_installed() -> bool:
    """Check if Bird CLI is installed.

    Returns:
        True if 'bird' command is available in PATH, False otherwise.
    """
    return shutil.which("bird") is not None


def is_bird_authenticated() -> Optional[str]:
    """Check if Bird is authenticated by running 'bird whoami'.

    Returns:
        Username if authenticated, None otherwise.
    """
    if not is_bird_installed():
        return None

    try:
        result = subprocess.run(
            ["bird", "whoami"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            # Output is typically the username
            return result.stdout.strip().split('\n')[0]
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
        return None


def check_npm_available() -> bool:
    """Check if npm is available for installation.

    Returns:
        True if 'npm' command is available in PATH, False otherwise.
    """
    return shutil.which("npm") is not None


def install_bird() -> Tuple[bool, str]:
    """Install Bird CLI via npm.

    Returns:
        Tuple of (success, message).
    """
    if not check_npm_available():
        return False, "npm not found. Install Node.js first, or install Bird manually: https://github.com/steipete/bird"

    try:
        _log("Installing Bird CLI...")
        result = subprocess.run(
            ["npm", "install", "-g", "@steipete/bird"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0:
            return True, "Bird CLI installed successfully!"
        else:
            error = result.stderr.strip() or result.stdout.strip() or "Unknown error"
            return False, f"Installation failed: {error}"
    except subprocess.TimeoutExpired:
        return False, "Installation timed out"
    except Exception as e:
        return False, f"Installation error: {e}"


def get_bird_status() -> Dict[str, Any]:
    """Get comprehensive Bird status.

    Returns:
        Dict with keys: installed, authenticated, username, can_install
    """
    installed = is_bird_installed()
    username = is_bird_authenticated() if installed else None

    return {
        "installed": installed,
        "authenticated": username is not None,
        "username": username,
        "can_install": check_npm_available(),
    }


def search_x(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Search X using Bird CLI.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD) - unused but kept for API compatibility
        depth: Research depth - "quick", "default", or "deep"

    Returns:
        Raw Bird JSON response or error dict.
    """
    count = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])

    # Build query with date filter using X's search syntax
    # Bird doesn't support --since flag, but X search accepts since:YYYY-MM-DD in query
    query = f"{topic} since:{from_date}"

    # Build command
    cmd = [
        "bird", "search",
        query,
        "-n", str(count),
        "--json",
    ]

    # Adjust timeout based on depth
    timeout = 30 if depth == "quick" else 45 if depth == "default" else 60

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        if result.returncode != 0:
            error = result.stderr.strip() or "Bird search failed"
            return {"error": error, "items": []}

        # Parse JSON output
        output = result.stdout.strip()
        if not output:
            return {"items": []}

        return json.loads(output)

    except subprocess.TimeoutExpired:
        return {"error": "Search timed out", "items": []}
    except json.JSONDecodeError as e:
        return {"error": f"Invalid JSON response: {e}", "items": []}
    except Exception as e:
        return {"error": str(e), "items": []}


def parse_bird_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse Bird response to match xai_x output format.

    Args:
        response: Raw Bird JSON response

    Returns:
        List of normalized item dicts matching xai_x.parse_x_response() format.
    """
    items = []

    # Check for errors
    if "error" in response and response["error"]:
        _log(f"Bird error: {response['error']}")
        return items

    # Bird returns a list of tweets directly or under a key
    raw_items = response if isinstance(response, list) else response.get("items", response.get("tweets", []))

    if not isinstance(raw_items, list):
        return items

    for i, tweet in enumerate(raw_items):
        if not isinstance(tweet, dict):
            continue

        # Extract URL - Bird uses permanent_url or we construct from id
        url = tweet.get("permanent_url") or tweet.get("url", "")
        if not url and tweet.get("id"):
            screen_name = tweet.get("user", {}).get("screen_name", "")
            if screen_name:
                url = f"https://x.com/{screen_name}/status/{tweet['id']}"

        if not url:
            continue

        # Parse date from created_at (e.g., "Wed Jan 15 14:30:00 +0000 2026")
        date = None
        created_at = tweet.get("created_at", "")
        if created_at:
            try:
                # Try ISO format first
                if "T" in created_at:
                    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                else:
                    # Twitter format: "Wed Jan 15 14:30:00 +0000 2026"
                    dt = datetime.strptime(created_at, "%a %b %d %H:%M:%S %z %Y")
                date = dt.strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                pass

        # Extract user info
        user = tweet.get("user", {})
        author_handle = user.get("screen_name", "") or tweet.get("author_handle", "")

        # Build engagement dict
        engagement = {
            "likes": tweet.get("like_count") or tweet.get("favorite_count"),
            "reposts": tweet.get("retweet_count"),
            "replies": tweet.get("reply_count"),
            "quotes": tweet.get("quote_count"),
        }
        # Convert to int where possible
        for key in engagement:
            if engagement[key] is not None:
                try:
                    engagement[key] = int(engagement[key])
                except (ValueError, TypeError):
                    engagement[key] = None

        # Build normalized item
        item = {
            "id": f"X{i+1}",
            "text": str(tweet.get("text", tweet.get("full_text", ""))).strip()[:500],
            "url": url,
            "author_handle": author_handle.lstrip("@"),
            "date": date,
            "engagement": engagement if any(v is not None for v in engagement.values()) else None,
            "why_relevant": "",  # Bird doesn't provide relevance explanations
            "relevance": 0.7,  # Default relevance, let score.py re-rank
        }

        items.append(item)

    return items