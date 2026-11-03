---
name: pi-contracts
description: "Document formal agreements between agents using the contract tool. Contracts are versioned Markdown files with frontmatter stored in .pi-workflow/contracts/. Types: api, interface, task, data, other. Lifecycle: draft → proposed → superseded. Typically produced by the architect agent."
---

# Pi Contracts Skill

The `contract` tool lets agents formally document agreements — what one party will produce and what another will consume. Contracts are stored in `.pi-workflow/contracts/` and available to all agents automatically.

> **Typical producer:** the `architect` agent — it designs interfaces, types, and contracts before implementation begins, and owns them when implementers raise blockers.
> **Any agent** can read contracts. Any agent can create one if needed, but contracts are most naturally an architect artefact.

## ⚠️ Core Discipline Rules

These rules prevent coordination failures:

**If you are the producer (writing the contract):**
1. `create` the contract as a draft
2. `edit` it until it is complete and accurate
3. **Always call `propose` when you are done** — this is the signal to all other agents that the contract is final and ready to act on
4. Never leave a contract in `draft` if other agents are waiting to use it

**If you are the consumer (reading the contract):**
1. Always check `status` before acting on a contract
2. **Only rely on `proposed` contracts** — a `draft` may still be changing
3. If the contract you need is still `draft`: call `ask_supervisor` to ask the producer to
   propose it, or emit `STATUS: blocked / BLOCKED_ON: contract` so the graph routes the problem
   to the architect. **Do not start implementing against a draft.**
4. If you find an error in a `proposed` contract, tell the producer to `supersede` it — do not act on a spec you know is wrong

**Why this matters:** a `draft` contract is work in progress. Another agent acting on a draft may build the wrong thing because the spec was not finished. `proposed` is the explicit signal: "this is final."

---

## Quick Reference

```
contract(action: "list")
contract(action: "create", name: "...", type: "api", producer: "architect", consumer: "worker", content: "...")
contract(action: "get", id: "auth-api")
contract(action: "edit", id: "auth-api", oldText: "...", newText: "...")
contract(action: "propose", id: "auth-api")
contract(action: "supersede", id: "auth-api", name: "Auth API v2", content: "...")
```

---

## Actions

| Action | Required params | Who calls it | Description |
|--------|----------------|--------------|-------------|
| `list` | — | anyone | List all contracts with type, status, id, title |
| `create` | `name`, `type`, `producer`, `consumer`, `content` | producer | Create a new `draft` contract |
| `get` | `id` | anyone | Read full contract content including frontmatter |
| `edit` | `id`, `oldText`, `newText` | producer | Precision find-and-replace — **draft only** |
| `propose` | `id` | producer | Move `draft` → `proposed` — **call this when done writing** |
| `supersede` | `id`, `name`, `content` | producer | Create v+1 draft, mark old as `superseded` |

---

## Contract Types

| Type | Use for |
|------|---------|
| `api` | REST/RPC endpoints, request/response schemas, auth |
| `interface` | Function signatures, TypeScript types, return values |
| `task` | What a subagent will deliver, acceptance criteria |
| `data` | Shape of data passed between agents or services |
| `other` | Anything that doesn't fit above |

---

## Lifecycle

```
create → draft → edit (repeat) → propose → proposed
                                                ↓
                                           supersede
                                                ↓
                                  superseded (old) + new draft (v+1)
```

- **draft**: work in progress — editable, not yet reliable for consumers
- **proposed**: final and ready — consumers can safely act on this
- **superseded**: replaced by a newer version — kept on disk for audit history

---

## Full Coordination Example

This is the typical pattern in a workflow where architect designs before implementation:

### Step 1 — Architect creates and proposes the contract

```
# Architect agent — designs the interface before implementation

contract(action: "create",
  name: "Auth API",
  type: "api",
  producer: "architect",
  consumer: "worker",
  content: """
# Auth API Contract

## Endpoints

### POST /auth/login
- Request: { email: string, password: string }
- Response 200: { token: string, expiresAt: string }
- Response 401: { error: "invalid_credentials" }

## Invariants
- Tokens use JWT HS256, 1-hour TTL
- Passwords must never appear in logs

## Error cases
- Missing fields → 400 Bad Request
- Unknown email → 401 (do not distinguish from wrong password)
""")
→ id: auth-api

# Done designing — signal it is final so worker can start
contract(action: "propose", id: "auth-api")
→ Contract "auth-api" is now proposed.
```

### Step 2 — Worker reads the contract before implementing

```
# Worker agent — reads the proposed contract before writing any code

contract(action: "list")
→ [api] [proposed] auth-api — Auth API Contract

# Status is proposed — safe to act on
contract(action: "get", id: "auth-api")
→ full spec including invariants and error cases

# Now implement exactly what the contract says
```

### Step 3 — Reviewer / Green verifies against the same contract

```
# Reviewer or green agent — checks implementation against the contract

contract(action: "get", id: "auth-api")
→ same spec the worker implemented against

# Verify: does the implementation satisfy the invariants and error cases?
```

### Step 4 — Worker hits a blocker and routes back to architect

This step is triggered automatically by the graph edge routing on `BLOCKED_ON: contract`:

```js
// Workflow script edge that routes the blocker back to architect
g.edge('worker', (state, result) => {
  if (result.status === 'blocked' && result.blockedOn === 'contract') return 'architect';
  return 'reviewer';
});
```

```
# Worker discovers the contract can't be satisfied as written
# It emits BLOCKED_ON: contract in its output

# Architect is re-invoked and sees the blocker in state
contract(action: "supersede",
  id: "auth-api",
  name: "Auth API v2",
  content: "# Auth API v2\n\n...revised spec...")
→ Contract "auth-api" superseded. New contract: auth-api-v2.md (v2)

# auth-api.md is now superseded (kept for audit history)
# auth-api-v2.md is a fresh draft at version 2

contract(action: "edit", id: "auth-api-v2", oldText: "...", newText: "...")
contract(action: "propose", id: "auth-api-v2")
# Worker retries against the revised contract
```

---

## Versioning

`supersede` is the only way to revise a `proposed` contract:
1. Creates a new contract at v+1 with `status: draft`
2. Marks the old contract as `superseded`
3. Inherits `type`, `producer`, `consumer` from the old contract automatically
4. Records `supersedes: <oldId>` in the new contract's frontmatter
5. Both files stay on disk — complete audit trail of what was agreed and when

---

## Asking the Human About a Contract

Keep the specification and trade-offs **in the contract**, not in a question dialog.
`ask_user_question` and workflow `human()` enforce: question/expanded prompt **240 characters**,
tab header **12**, option label **60** (prefer 1–5 words), and option description **160**.
Overlong text is rejected, not silently shortened. Contract contents and Markdown previews are not
subject to these question-text caps; neither are user answers or `ask_supervisor` coordination.

For a workflow review gate, show the contract as an artifact instead of interpolating the full spec:

```js
g.node('review_spec', human('Accept the proposed contract?', {
  options: ['accept', 'revise'], default: 'revise', artifacts: ['contract']
}));
```

This human decision does not replace the contract lifecycle: the producer must still call `propose`
when the draft is final, and consumers must check its status. See `pi-workflow` → **Human-facing text limits**.

## /contracts Command

Type `/contracts` in the TUI to open the interactive navigator:
- List view: type (colour-coded) · status · id · title · updated date
- Reader: full Markdown + frontmatter with scroll
- Keys: ↑↓/jk navigate · enter open · esc back · r refresh · q quit
