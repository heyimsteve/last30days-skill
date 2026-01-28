"""Claude-powered synthesis for research results via OpenRouter."""

import json
import sys
from typing import Any, Dict, List, Optional

from . import http
from .env import OPENROUTER_BASE_URL

# OpenRouter Chat Completions endpoint (for synthesis, not web search)
OPENROUTER_CHAT_URL = f"{OPENROUTER_BASE_URL}/chat/completions"

# Default Claude model for synthesis
DEFAULT_SYNTH_MODEL = "anthropic/claude-sonnet-4.5"

SYNTHESIS_SYSTEM_PROMPT = """You are a research synthesis expert. You analyze research results from Reddit and X (Twitter) and extract actionable patterns.

Your job:
1. Identify the KEY PATTERNS from the research - what techniques, formats, or approaches appear repeatedly
2. Note which patterns have the highest engagement (upvotes, likes)
3. Identify any caveats or warnings mentioned
4. Determine the recommended PROMPT FORMAT (JSON, structured, natural language, etc.)

Be specific and cite actual sources. Don't make up patterns - only report what's in the research."""

SYNTHESIS_USER_TEMPLATE = """Analyze this research about "{topic}" and extract the key patterns.

## Reddit Threads Found:
{reddit_summary}

## X Posts Found:
{x_summary}

Provide your synthesis in this format:

**What I learned:**
[2-4 sentences synthesizing the main insights]

**KEY PATTERNS discovered:**
1. [Pattern 1 - be specific]
2. [Pattern 2]
3. [Pattern 3]
4. [Pattern 4 if applicable]
5. [Pattern 5 if applicable]

**Recommended prompt format:** [JSON/structured/natural language/etc based on what the research shows works]

**Caveats:** [Any warnings or limitations mentioned in the research]"""

PROMPT_GEN_SYSTEM = """You are an expert prompt engineer. Based on research patterns provided, you craft perfect prompts that follow what actually works.

CRITICAL RULES:
1. Use the EXACT FORMAT the research recommends (if JSON, output JSON; if structured, use structure)
2. Apply the specific patterns discovered in the research
3. Tailor the prompt to the user's specific vision
4. Make it copy-paste ready with minimal placeholders"""

PROMPT_GEN_USER_TEMPLATE = """Based on this research synthesis:

{synthesis}

The user wants to create:
"{user_vision}"

Write ONE perfect prompt that:
1. Uses the format the research recommends
2. Applies the key patterns discovered
3. Is tailored to their specific vision
4. Is ready to copy-paste

Output ONLY the prompt (with a brief 1-line note at the end about which pattern you applied)."""


def _format_reddit_summary(reddit_items: List[Dict]) -> str:
    """Format Reddit items for synthesis."""
    if not reddit_items:
        return "No Reddit threads found."
    
    lines = []
    for item in reddit_items[:15]:  # Limit to top 15
        score = item.get("score", 0)
        title = item.get("title", "")[:100]
        subreddit = item.get("subreddit", "unknown")
        why = item.get("why_relevant", "")[:150]
        url = item.get("url", "")
        
        lines.append(f"- r/{subreddit} (score:{score}): {title}")
        if why:
            lines.append(f"  *{why}*")
    
    return "\n".join(lines)


def _format_x_summary(x_items: List[Dict]) -> str:
    """Format X items for synthesis."""
    if not x_items:
        return "No X posts found."
    
    lines = []
    for item in x_items[:15]:  # Limit to top 15
        score = item.get("score", 0)
        text = item.get("text", "")[:200]
        author = item.get("author_handle", "unknown")
        engagement = item.get("engagement") or {}
        likes = engagement.get("likes", 0) or 0
        reposts = engagement.get("reposts", 0) or 0
        why = item.get("why_relevant", "")[:150]
        
        lines.append(f"- @{author} (score:{score}, {likes}likes, {reposts}rt): {text}")
        if why:
            lines.append(f"  *{why}*")
    
    return "\n".join(lines)


def synthesize_research(
    api_key: str,
    topic: str,
    reddit_items: List[Dict],
    x_items: List[Dict],
    model: str = None,
) -> str:
    """Send research to Claude for synthesis.
    
    Args:
        api_key: OpenRouter API key
        topic: Research topic
        reddit_items: List of Reddit items
        x_items: List of X items
        model: Claude model to use (default: claude-sonnet-4)
    
    Returns:
        Synthesis text from Claude
    """
    model = model or DEFAULT_SYNTH_MODEL
    
    reddit_summary = _format_reddit_summary(reddit_items)
    x_summary = _format_x_summary(x_items)
    
    user_message = SYNTHESIS_USER_TEMPLATE.format(
        topic=topic,
        reddit_summary=reddit_summary,
        x_summary=x_summary,
    )
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/last30days-skill",
        "X-Title": "last30days-skill",
    }
    
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYNTHESIS_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "max_tokens": 2000,
    }
    
    response = http.post(OPENROUTER_CHAT_URL, payload, headers=headers, timeout=60)
    
    # Extract response text
    if "choices" in response and response["choices"]:
        return response["choices"][0]["message"]["content"]
    elif "error" in response:
        error = response["error"]
        msg = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        raise Exception(f"Synthesis failed: {msg}")
    
    return "Synthesis failed - no response from Claude."


def generate_prompt(
    api_key: str,
    synthesis: str,
    user_vision: str,
    model: str = None,
) -> str:
    """Generate a prompt based on synthesis and user vision.
    
    Args:
        api_key: OpenRouter API key
        synthesis: The synthesis text from synthesize_research()
        user_vision: What the user wants to create
        model: Claude model to use
    
    Returns:
        Generated prompt
    """
    model = model or DEFAULT_SYNTH_MODEL
    
    user_message = PROMPT_GEN_USER_TEMPLATE.format(
        synthesis=synthesis,
        user_vision=user_vision,
    )
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/last30days-skill",
        "X-Title": "last30days-skill",
    }
    
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": PROMPT_GEN_SYSTEM},
            {"role": "user", "content": user_message},
        ],
        "max_tokens": 3000,
    }
    
    response = http.post(OPENROUTER_CHAT_URL, payload, headers=headers, timeout=60)
    
    # Extract response text
    if "choices" in response and response["choices"]:
        return response["choices"][0]["message"]["content"]
    elif "error" in response:
        error = response["error"]
        msg = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        raise Exception(f"Prompt generation failed: {msg}")
    
    return "Prompt generation failed - no response from Claude."


def run_interactive_session(
    api_key: str,
    topic: str,
    reddit_items: List[Dict],
    x_items: List[Dict],
    model: str = None,
    vision: str = None,
) -> None:
    """Run a synthesis and prompt generation session.
    
    Args:
        api_key: OpenRouter API key
        topic: Research topic
        reddit_items: List of Reddit items
        x_items: List of X items
        model: Claude model to use
        vision: User's vision (if provided, skips interactive input)
    """
    model = model or DEFAULT_SYNTH_MODEL
    
    print(f"\n{'='*60}")
    print(f"🧠 Synthesizing research with Claude ({model})...")
    print(f"{'='*60}\n")
    
    try:
        synthesis = synthesize_research(api_key, topic, reddit_items, x_items, model)
        print(synthesis)
        print(f"\n{'='*60}")
        print("📊 Research Stats:")
        print(f"   Reddit: {len(reddit_items)} threads")
        print(f"   X: {len(x_items)} posts")
        print(f"{'='*60}\n")
        
        # Use provided vision or ask for it
        if vision:
            user_vision = vision
            print(f"💭 Vision provided: {user_vision}\n")
        else:
            # Interactive mode - ask for user vision
            print("💭 What do you want to create? Describe your vision:")
            print("   (Type your idea and press Enter)\n")
            
            try:
                user_vision = input("> ").strip()
            except EOFError:
                print("\n[No input received - exiting]")
                return
            
            if not user_vision:
                print("\n[No vision provided - exiting]")
                return
        
        print(f"{'='*60}")
        print("✨ Generating your prompt...")
        print(f"{'='*60}\n")
        
        prompt = generate_prompt(api_key, synthesis, user_vision, model)
        print(prompt)
        
        print(f"\n{'='*60}")
        print("✅ Done! Copy the prompt above and use it with your tool.")
        print(f"{'='*60}\n")
        
        # Only offer to generate more in interactive mode
        if not vision:
            while True:
                print("Want another prompt? Describe what you want to create (or 'q' to quit):\n")
                try:
                    user_vision = input("> ").strip()
                except EOFError:
                    break
                
                if not user_vision or user_vision.lower() in ('q', 'quit', 'exit'):
                    break
                
                print(f"\n{'='*60}")
                print("✨ Generating your prompt...")
                print(f"{'='*60}\n")
                
                prompt = generate_prompt(api_key, synthesis, user_vision, model)
                print(prompt)
                print(f"\n{'='*60}\n")
    
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)
