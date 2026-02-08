"""Environment and API key management for last30days skill."""

import os
from pathlib import Path
from typing import Optional, Dict, Any

# OpenRouter base URL for Open Responses API
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Allow override via environment variable for testing
# Set LAST30DAYS_CONFIG_DIR="" for clean/no-config mode
# Set LAST30DAYS_CONFIG_DIR="/path/to/dir" for custom config location
_config_override = os.environ.get('LAST30DAYS_CONFIG_DIR')
if _config_override == "":
    # Empty string = no config file (clean mode)
    CONFIG_DIR = None
    CONFIG_FILE = None
elif _config_override:
    CONFIG_DIR = Path(_config_override)
    CONFIG_FILE = CONFIG_DIR / ".env"
else:
    # Default: project-root .env (OpenRouter mode)
    PROJECT_ROOT = Path(__file__).parent.parent.parent.resolve()
    CONFIG_DIR = PROJECT_ROOT
    CONFIG_FILE = PROJECT_ROOT / ".env"


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
    """Load configuration from .env and environment."""
    # Load from config file first (if configured)
    file_env = load_env_file(CONFIG_FILE) if CONFIG_FILE else {}

    # Environment variables override file - single OpenRouter key setup
    config = {
        'OPENROUTER_API_KEY': os.environ.get('OPENROUTER_API_KEY') or file_env.get('OPENROUTER_API_KEY'),
        'OPENROUTER_MODEL_REDDIT': os.environ.get('OPENROUTER_MODEL_REDDIT') or file_env.get('OPENROUTER_MODEL_REDDIT'),
        'OPENROUTER_MODEL_X': os.environ.get('OPENROUTER_MODEL_X') or file_env.get('OPENROUTER_MODEL_X'),
    }

    return config


def config_exists() -> bool:
    """Check if configuration file exists."""
    return bool(CONFIG_FILE and CONFIG_FILE.exists())


def get_available_sources(config: Dict[str, Any]) -> str:
    """Determine which sources are available based on API keys.

    Returns: 'both' or 'web' (fallback when no key)
    """
    has_openrouter = bool(config.get('OPENROUTER_API_KEY'))

    if has_openrouter:
        return 'both'  # OpenRouter provides access to both Reddit and X
    return 'web'  # Fallback: WebSearch only (no API key)


def get_missing_keys(config: Dict[str, Any]) -> str:
    """Determine which sources are missing.

    Returns: 'both' or 'none'
    """
    has_openrouter = bool(config.get('OPENROUTER_API_KEY'))
    return 'none' if has_openrouter else 'both'


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
        if requested == 'web':
            return 'web', None
        return 'web', "No OPENROUTER_API_KEY configured. Using WebSearch fallback. Add key to .env in project root."

    if requested == 'auto':
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


def get_x_source(config: Dict[str, Any]) -> Optional[str]:
    """Determine the best available X/Twitter source.

    Priority: Bird (free) → OpenRouter (paid API)
    """
    from . import bird_x

    if bird_x.is_bird_installed():
        username = bird_x.is_bird_authenticated()
        if username:
            return 'bird'

    if config.get('OPENROUTER_API_KEY'):
        return 'xai'

    return None


def get_x_source_status(config: Dict[str, Any]) -> Dict[str, Any]:
    """Get detailed X source status for UI decisions."""
    from . import bird_x

    bird_status = bird_x.get_bird_status()
    openrouter_available = bool(config.get('OPENROUTER_API_KEY'))

    if bird_status["authenticated"]:
        source = 'bird'
    elif openrouter_available:
        source = 'xai'
    else:
        source = None

    return {
        "source": source,
        "bird_installed": bird_status["installed"],
        "bird_authenticated": bird_status["authenticated"],
        "bird_username": bird_status["username"],
        "xai_available": openrouter_available,
        "can_install_bird": bird_status["can_install"],
    }
