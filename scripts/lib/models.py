"""Model selection for last30days skill via OpenRouter."""

import re
from typing import Dict, List, Optional, Tuple

from . import cache, http
from .env import OPENROUTER_BASE_URL

# OpenRouter models with :online suffix for web/X search capabilities
OPENROUTER_MODELS_URL = f"{OPENROUTER_BASE_URL}/models"

# Reddit search models (OpenAI via OpenRouter) - ordered by preference
REDDIT_MODEL_CHAIN = [
    "openai/gpt-5.2:online",
    "openai/gpt-5.1:online",
    "openai/gpt-5:online",
    "openai/gpt-4o:online",
]

# X search model (xAI via OpenRouter)
X_MODEL_DEFAULT = "x-ai/grok-4.1-fast:online"


def select_reddit_model(
    api_key: str,
    config_model: Optional[str] = None,
) -> str:
    """Select the best Reddit search model.

    Args:
        api_key: OpenRouter API key
        config_model: Model override from config

    Returns:
        Selected model ID
    """
    if config_model:
        return config_model

    # Check cache first
    cached = cache.get_cached_model("openrouter_reddit")
    if cached:
        return cached

    # Try to find available model from chain
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://github.com/last30days-skill",
            "X-Title": "last30days-skill",
        }
        response = http.get(OPENROUTER_MODELS_URL, headers=headers)
        available_ids = {m.get("id", "") for m in response.get("data", [])}

        # Find first available model from our chain
        for model in REDDIT_MODEL_CHAIN:
            # Check both with and without :online suffix
            base_model = model.replace(":online", "")
            if model in available_ids or base_model in available_ids:
                cache.set_cached_model("openrouter_reddit", model)
                return model
    except http.HTTPError:
        pass

    # Default to first in chain
    selected = REDDIT_MODEL_CHAIN[0]
    cache.set_cached_model("openrouter_reddit", selected)
    return selected


def select_x_model(
    api_key: str,
    config_model: Optional[str] = None,
) -> str:
    """Select the X search model.

    Args:
        api_key: OpenRouter API key
        config_model: Model override from config

    Returns:
        Selected model ID
    """
    if config_model:
        return config_model

    # Check cache first
    cached = cache.get_cached_model("openrouter_x")
    if cached:
        return cached

    # Use default X model
    cache.set_cached_model("openrouter_x", X_MODEL_DEFAULT)
    return X_MODEL_DEFAULT


def get_models(
    config: Dict,
    mock_openai_models: Optional[List[Dict]] = None,
    mock_xai_models: Optional[List[Dict]] = None,
) -> Dict[str, Optional[str]]:
    """Get selected models for OpenRouter.

    Returns:
        Dict with 'openai' (for Reddit) and 'xai' (for X) keys
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
