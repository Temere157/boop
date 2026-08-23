# AGENTS.md

Conventions for agents and humans editing this repository.

## Writing style: one sentence per line

Docs, comments, and agent-facing instruction strings use one sentence per line.

Each sentence is a complete line; paragraphs are separated by a blank line.
Lines are not hard-wrapped at a fixed column — a sentence runs as long as it needs to, then the next sentence starts on a new line.

This applies to:

- **Markdown** (`README.md`, `docs/*.md`): prose is one sentence per line.
  List items keep their `- `/`1.` marker on the first line; a second sentence in the same item goes on its own indented line.
- **Comments** (`//` and `/** */` in `.ts`, `#` in `flake.nix`): each sentence is its own line within the block.
  Structured spec blocks (`Tool:` / `args:` / `->`, route tables, `Environment variables:` lists, code samples, field labels) keep their existing line structure.
- **Agent instructions** (string literals the LLM reads, e.g. the session system prompt in `src/session.ts` and the memory-injection message in `plugins/memory.ts`): each sentence is its own array entry or string fragment, so the rendered text is unchanged while each sentence is individually editable.

The goal is diff readability: a sentence edit touches only its own line, and a diff reads as a list of sentence changes rather than a re-wrapped paragraph.

### What counts as a sentence

A sentence ends at `.`, `?`, or `!` followed by whitespace or end-of-string, unless the punctuation is inside a code span, path, or identifier (e.g. `index.{ts,js}`, `config.json`).
Abbreviations like `e.g.` and `i.e.` do not end a sentence; the sentence continues on the same line.

## Typechecking

Before committing, run the checks the flake defines:

```sh
nix flake check   # typecheck, typecheck-plugins, typecheck-webui
```

A change that touches `.ts` should keep all three passing.
