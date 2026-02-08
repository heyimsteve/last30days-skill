"""Model selection for last30days skill via OpenRouter."""

import re
from typing import Dict, List, Optional, Tuple

from . import cache, http
from .env import OPENROUTER_BASE_URL

OPENROUTER_MODELS_URL = f"{OPENROUTER_BASE_URL}/models"
OPENAI_FALLBACK_MODELS = ["gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"]
XAI_ALIASES = {
    "latest": "grok-4-latest",
    "stable": "grok-4",
}

# OpenRouter models (runtime)
REDDIT_MODEL_CHAIN = [
    "openai/gpt-5.2:online",
    "openai/gpt-5.1:online",
    "openai/gpt-5:online",
    "openai/gpt-4o:online",
]
X_MODEL_DEFAULT = "x-ai/grok-4.1-fast:online"


def parse_version(model_id: str) -> Optional[Tuple[int, ...]]:
    match = re.search(r'(\d+(?:\.\d+)*)', model_id)
    if match:
        return tuple(int(x) for x in match.group(1).split('.'))
    return None


def is_mainline_openai_model(model_id: str) -> bool:
    model_lower = model_id.lower()
    if not re.match(r'^gpt-(?:4o|4\.1|5)(\.\d+)*$', model_lower):
        return False
    return not any(exc in model_lower for exc in ['mini', 'nano', 'chat', 'codex', 'pro', 'preview', 'turbo'])


def select_openai_model(
    api_key: str,
    policy: str = "auto",
    pin: Optional[str] = None,
    mock_models: Optional[List[Dict]] = None,
) -> str:
    """Compatibility helper for tests; returns plain OpenAI model IDs."""
    if policy == "pinned" and pin:
        return pin

    if mock_models is not None:
        candidates = [m for m in mock_models if is_mainline_openai_model(m.get("id", ""))]
        if not candidates:
            return OPENAI_FALLBACK_MODELS[0]
        candidates.sort(key=lambda m: (parse_version(m.get("id", "")) or (0,), m.get("created", 0)), reverse=True)
        return candidates[0]["id"]

    return OPENAI_FALLBACK_MODELS[0]


def select_xai_model(
    api_key: str,
    policy: str = "latest",
    pin: Optional[str] = None,
    mock_models: Optional[List[Dict]] = None,
) -> str:
    """Compatibility helper for tests; returns xAI alias/pin."""
    if policy == "pinned" and pin:
        return pin
    return XAI_ALIASES.get(policy, XAI_ALIASES["latest"])


def select_reddit_model(api_key: str, config_model: Optional[str] = None) -> str:
    if config_model:
        return config_model
    cached = cache.get_cached_model("openrouter_reddit")
    if cached:
        return cached
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://github.com/last30days-skill",
            "X-Title": "last30days-skill",
        }
        response = http.get(OPENROUTER_MODELS_URL, headers=headers)
        available_ids = {m.get("id", "") for m in response.get("data", [])}
        for model in REDDIT_MODEL_CHAIN:
            base_model = model.replace(":online", "")
            if model in available_ids or base_model in available_ids:
                cache.set_cached_model("openrouter_reddit", model)
                return model
    except http.HTTPError:
        pass
    selected = REDDIT_MODEL_CHAIN[0]
    cache.set_cached_model("openrouter_reddit", selected)
    return selected


def select_x_model(api_key: str, config_model: Optional[str] = None) -> str:
    if config_model:
        return config_model
    cached = cache.get_cached_model("openrouter_x")
    if cached:
        return cached
    cache.set_cached_model("openrouter_x", X_MODEL_DEFAULT)
    return X_MODEL_DEFAULT


def get_models(
    config: Dict,
    mock_openai_models: Optional[List[Dict]] = None,
    mock_xai_models: Optional[List[Dict]] = None,
) -> Dict[str, Optional[str]]:
    """Get selected models.

    Runtime prefers OpenRouter key; compatibility supports OPENAI/XAI test keys.
    """
    result = {"openai": None, "xai": None}

    if config.get("OPENROUTER_API_KEY"):
        result["openai"] = select_reddit_model(
            config["OPENROUTER_API_KEY"],
            config.get("OPENROUTER_MODEL_REDDIT"),
        )
        result["xai"] = select_x_model(
            config["OPENROUTER_API_KEY"],
            config.get("OPENROUTER_MODEL_X"),
        )
        return result

    # Compatibility path used by existing tests
    if config.get("OPENAI_API_KEY"):
        result["openai"] = select_openai_model(
            config["OPENAI_API_KEY"],
            config.get("OPENAI_MODEL_POLICY", "auto"),
            config.get("OPENAI_MODEL_PIN"),
            mock_openai_models,
        )
    if config.get("XAI_API_KEY"):
        result["xai"] = select_xai_model(
            config["XAI_API_KEY"],
            config.get("XAI_MODEL_POLICY", "latest"),
            config.get("XAI_MODEL_PIN"),
            mock_xai_models,
        )
    return result
