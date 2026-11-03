---
name: pi-plans
description: Create and manage structured plans using the plan tool. Plans are Markdown files stored in .pi-workflow/plans/ and are available in all modes including plan mode. Typically produced by the planner agent.
---

# Pi Plans Skill

The `plan` tool lets any agent create, read, edit, list, and delete Markdown plans stored in `.pi-workflow/plans/`. It works in **all modes** — including plan mode where `write`/`edit` are blocked.

> **Typical producer:** the `planner` agent — it investigates the codebase and writes the
> implementation plan here so other agents and the human can read it.
> **Any agent** can read plans. Any agent can create one if needed, but plans are most naturally
> a planner artefact.
>
> **When to create a plan:** create one any time you are asked to plan a task, about to break a
> complex task into steps, or when the human asks you to record your approach before acting. Skip
> it for one-off lookup tasks where there is nothing to track.

## Quick Reference

```
plan(action: "list")                          # see all plans
plan(action: "create", name: "...", content: "...markdown...")
plan(action: "get", id: "my-plan-id")
plan(action: "edit", id: "my-plan-id", oldText: "...", newText: "...")
plan(action: "delete", id: "my-plan-id")
```

## Actions

| Action | Required params | Description |
|--------|----------------|-------------|
| `list` | — | List all plans with id, name, last updated |
| `create` | `name`, `content` | Create a new plan; returns the assigned `id` |
| `get` | `id` | Read full plan content |
| `edit` | `id`, `oldText`, `newText` | Precision find-and-replace — `oldText` must match exactly once |
| `delete` | `id` | Permanently remove a plan |

## Plan Format

Plans are plain Markdown. Start with an `# H1` heading as the title — the tool reads it as the plan name in listings.

```markdown
# Refactor Authentication Module

## Goal
Replace the legacy session cookie approach with JWT tokens.

## Steps
1. Audit current session handling in `auth/session.ts` — files: auth/session.ts
2. Design the JWT payload schema — files: auth/types.ts
3. Implement token issuing and validation — files: auth/jwt.ts
4. Update all protected routes — files: middleware/auth.ts

## Risks
- Token expiry strategy not yet decided (sliding window vs fixed TTL)

## Open Questions
- Where to store the refresh token?
```

> This example is written by the **planner** agent — it investigates the codebase, identifies the files, and records the ordered steps here before any implementation begins.

## Edit Precision

`edit` behaves like pi's built-in `edit` tool — `oldText` must be an exact match that appears **once only** in the plan. If it matches zero times you get an error; if it matches multiple times you must provide more context. This makes edits safe and predictable.

## Plan IDs

The id is auto-derived from the name as a URL slug (e.g. `"Refactor Auth"` → `refactor-auth`). If a collision occurs, a timestamp suffix is added. Always use `list` to get the exact id before calling `get`/`edit`/`delete`.

## Asking the Human About a Plan

Keep detailed rationale, findings, and alternatives **in the plan**, not in a question dialog.
`ask_user_question` and workflow `human()` enforce: question/expanded prompt **240 characters**,
tab header **12**, option label **60** (prefer 1–5 words), and option description **160**.
Overlong text is rejected, not silently shortened. Document contents and Markdown previews are not
subject to these question-text caps; neither are user answers or `ask_supervisor` coordination.

For a workflow review gate, show the plan as an artifact instead of interpolating its contents:

```js
g.node('approve', human('Approve the implementation plan?', {
  options: ['approve', 'revise'], default: 'revise', artifacts: ['plan']
}));
```

For an in-flight question, use a short topic header and concise options, and put any lengthy comparison
in an option's `preview`. See `pi-workflow` → **Human-facing text limits** for the full rules.

## /plans Command

Type `/plans` in the TUI to open the interactive plan navigator — browse all plans, read content,
scroll with ↑/↓. This is a **read-only TUI panel** only available in interactive sessions;
agents running headless cannot open it, but can always use `plan(action: "list")` and
`plan(action: "get", id: "...")` instead.
