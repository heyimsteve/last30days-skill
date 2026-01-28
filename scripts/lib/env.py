"""Environment and API key management for last30days skill."""

import os
from pathlib import Path
from typing import Optional, Dict, Any

# Config file is at project root (.env)
PROJECT_ROOT = Path(__file__).parent.parent.parent.resolve()
CONFIG_FILE = PROJECT_ROOT / ".env"

# OpenRouter base URL for Open Responses API
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def load_env_file(path: Path) -> Dict[str, str]:
    """Load environment variables from a file."""
    env = {}
    if not path.exists():
        return env

    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip()
                # Remove quotes if present
                if value and value[0] in ('"', "'") and value[-1] == value[0]:
                    value = value[1:-1]
                if key and value:
                    env[key] = value
    return env


def get_config() -> Dict[str, Any]:
    """Load configuration from ~/.config/last30days/.env and environment."""
    # Load from config file first
    file_env = load_env_file(CONFIG_FILE)

    # Environment variables override file - now uses single OpenRouter key
    config = {
        'OPENROUTER_API_KEY': os.environ.get('OPENROUTER_API_KEY') or file_env.get('OPENROUTER_API_KEY'),
        'OPENROUTER_MODEL_REDDIT': os.environ.get('OPENROUTER_MODEL_REDDIT') or file_env.get('OPENROUTER_MODEL_REDDIT'),
        'OPENROUTER_MODEL_X': os.environ.get('OPENROUTER_MODEL_X') or file_env.get('OPENROUTER_MODEL_X'),
    }

    return config


def config_exists() -> bool:
    """Check if configuration file exists."""
    return CONFIG_FILE.exists()


def get_available_sources(config: Dict[str, Any]) -> str:
    """Determine which sources are available based on API keys.

    Returns: 'both' or 'web' (fallback when no key)
    """
    has_openrouter = bool(config.get('OPENROUTER_API_KEY'))

    if has_openrouter:
        return 'both'  # OpenRouter provides access to both Reddit and X
    else:
        return 'web'  # Fallback: WebSearch only (no API key)


def get_missing_keys(config: Dict[str, Any]) -> str:
    """Determine which API keys are missing.

    Returns: 'both' or 'none'
    """
    has_openrouter = bool(config.get('OPENROUTER_API_KEY'))

    if has_openrouter:
        return 'none'
    else:
        return 'both'  # Missing OpenRouter key


def validate_sources(requested: str, available: str, include_web: bool = False) -> tuple[str, Optional[str]]:
    """Validate requested sources against available keys.

    Args:
        requested: 'auto', 'reddit', 'x', 'both', or 'web'
        available: Result from get_available_sources()
        include_web: If True, add WebSearch to available sources

    Returns:
        Tuple of (effective_sources, error_message)
    """
    # WebSearch-only mode (no API key)
    if available == 'web':
        if requested == 'auto':
            return 'web', None
        elif requested == 'web':
            return 'web', None
        else:
            return 'web', f"No OPENROUTER_API_KEY configured. Using WebSearch fallback. Add key to .env in project root."

    if requested == 'auto':
        # Add web to sources if include_web is set
        if include_web:
            return 'all', None  # reddit + x + web
        return available, None

    if requested == 'web':
        return 'web', None

    if requested == 'both':
        if include_web:
            return 'all', None
        return 'both', None

    if requested == 'reddit':
        if include_web:
            return 'reddit-web', None
        return 'reddit', None

    if requested == 'x':
        if include_web:
            return 'x-web', None
        return 'x', None

    return requested, None
