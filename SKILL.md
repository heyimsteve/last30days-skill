---
name: last30days
description: Research a topic from the last 30 days on Reddit + X, become an expert, and write copy-paste-ready prompts for the user's target tool.
argument-hint: "[topic] for [tool]" or "[topic]"
context: fork
agent: Explore
disable-model-invocation: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# last30days: Become Expert → Write Prompts

Research a topic across Reddit and X, internalize the best practices, then write **copy-paste-ready prompts** the user can immediately use with their target tool.

## CRITICAL: Parse User Intent

Before doing anything, parse the user's input for TWO things:

1. **TOPIC**: What they want to learn about (e.g., "web app mockups", "Claude Code skills", "image generation")
2. **TARGET TOOL**: Where they'll use the prompts (e.g., "Nano Banana Pro", "ChatGPT", "Claude", "Midjourney")

Common patterns:
- `[topic] for [tool]` → "web mockups for Nano Banana Pro"
- `[topic] prompts for [tool]` → "UI design prompts for Midjourney"
- `[tool] [topic]` → "Nano Banana Pro dashboard mockups"
- Just `[topic]` → Ask follow-up

**If TARGET TOOL is unclear**, use AskUserQuestion:
```
What tool will you use these prompts with?

Options:
1. Nano Banana Pro (image generation)
2. ChatGPT / Claude (text/code)
3. Midjourney / DALL-E (image generation)
4. Other (tell me)
```

**Store these values mentally** - you'll need them for the entire conversation:
- `TOPIC = [extracted topic]`
- `TARGET_TOOL = [extracted tool]`

---

## Setup Check

Verify API key configuration exists:

```bash
if [ ! -f ~/.config/last30days/.env ]; then
  echo "SETUP_NEEDED"
else
  echo "CONFIGURED"
fi
```

### If SETUP_NEEDED

Run NUX flow to configure API keys. Use AskUserQuestion to collect:

1. **OpenAI API Key** (optional but recommended for Reddit research)
2. **xAI API Key** (optional but recommended for X research)

Then create the config:

```bash
mkdir -p ~/.config/last30days
cat > ~/.config/last30days/.env << 'ENVEOF'
# last30days API Configuration
# At least one key is required

OPENAI_API_KEY=
XAI_API_KEY=
ENVEOF

chmod 600 ~/.config/last30days/.env
echo "Config created at ~/.config/last30days/.env"
echo "Please edit it to add your API keys, then run the skill again."
```

**STOP HERE if setup was needed.**

---

## Research Execution

Run the research orchestrator with the TOPIC:

```bash
python3 ~/.claude/skills/last30days/scripts/last30days.py "$ARGUMENTS" --emit=compact 2>&1
```

---

## FIRST: Show the Work (Stats Summary)

**Before anything else**, aggregate the metrics from the research and display an impressive summary. Parse the output above and calculate:

- Count of Reddit threads
- Sum of all Reddit upvotes (pts)
- Sum of all Reddit comments (cmt)
- Count of X posts
- Sum of all X likes
- Sum of all X reposts (rt)
- List unique subreddits
- List unique X authors

Display it in this format:

```
📊 Research Complete

Analyzed {total_sources} sources from the last 30 days
├─ Reddit: {n} threads │ {sum} upvotes │ {sum} comments
├─ X: {n} posts │ {sum} likes │ {sum} reposts
└─ Top voices: r/{sub1}, r/{sub2}, @{handle1}, @{handle2}

Now synthesizing into expert knowledge...
```

**Use real numbers from the research output.** This shows the user the skill actually did work.

---

## THEN: Internalize the Research

Read the research output above. You are now becoming an **expert** in this topic.

Your job is NOT to dump the research back at the user. Your job is to:
1. **Absorb** all the patterns, techniques, and insights
2. **Synthesize** them into expertise
3. **Apply** that expertise to write prompts for the user's TARGET_TOOL

---

## PRIMARY OUTPUT: Copy-Paste Prompts for TARGET_TOOL

**This is the main deliverable.** Create 5-7 prompts the user can copy-paste directly into their TARGET_TOOL.

### Format Each Prompt:

```
### [Use Case Name]

**When to use:** [1-line description]

**Prompt:**
```
[The actual prompt they copy-paste - ready to use, no placeholders unless clearly marked with [brackets]]
```

**Why this works:** [1-line explaining what research insight this is based on, cite source ID]
```

### Prompt Quality Checklist:
- [ ] Can be pasted directly into TARGET_TOOL with zero edits
- [ ] Uses specific patterns/keywords discovered in research
- [ ] Appropriate length and style for TARGET_TOOL
- [ ] Covers the most common use cases for TOPIC

---

## SECONDARY: Brief Best Practices (Optional)

Only include if the user seems to want background. Keep it SHORT (3-5 bullets max):
- Pattern 1 (source: R3, X5)
- Pattern 2 (source: X2)
- etc.

---

## FOLLOW-UP OFFER

After delivering prompts, ALWAYS ask:

> **Want me to write a custom prompt?** Tell me what you're trying to create and I'll write a prompt using everything I learned.

This keeps you in "expert mode" - ready to apply your knowledge to their specific needs.

---

## CONTEXT MEMORY

For the rest of this conversation, remember:
- **TOPIC**: {topic}
- **TARGET_TOOL**: {tool}
- **KEY PATTERNS**: {list the top 3-5 patterns you learned}

When the user asks for another prompt later, you don't need to re-research. Apply what you learned.

---

## Output Summary Footer

End with a compact reminder of what you learned:

```
---
📚 Expert in: {TOPIC} for {TARGET_TOOL}
📊 Based on: {n} Reddit threads ({sum} upvotes) + {n} X posts ({sum} likes)
🎯 Ready for custom prompts - just tell me what you want to create.
```
