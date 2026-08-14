# pi-workflow

Multi-agent coordination for [pi](https://github.com/badlogic/pi-mono), built around a graph:
**agents are nodes, edges decide where each result goes next.**

## The problem it solves

Agent pipelines break in a specific way. You plan the work, hand step 3 to an implementer, and it
hits something the plan did not anticipate — an interface that cannot express what the task needs,
a test that contradicts the spec. The agent has no legitimate way to say *"this is impossible as
specified"*, and it is under pressure to produce something. So it mocks the thing it was asked to
build, or weakens the test until it passes, or reports done while the suite is red.

The plan did not survive contact with reality, and nobody found out.

Telling agents to behave better does not fix this, because the shortcut is the *rational* move when
escalating is not an option. The fix has to be structural: give the agent somewhere to escalate
**to**, and make that cheaper than faking.

That is what the graph is for. An agent reports:

```
STATUS: blocked
BLOCKED_ON: contract
REASON: UserRepo has no way to express a soft-deleted row
```

An edge routes that back to whoever owns the contract. The architect revises it, and the
implementer — on its next attempt — sees the *revised* contract in the state it receives. No
message bus, no dispatcher. Routing plus shared state is the entire mechanism.

## Install

From NPM (stable release):

```bash
pi install npm:pi-workflow
```

From GitHub (latest main branch):

```bash
pi install git:github.com/bejorock/pi-workflow
```

Nine agents ship with it and are available immediately — no scaffolding step.

## Quick start

Ask the main agent to coordinate work, and it composes a graph:

```js
export const meta = { name: "tdd_feature", description: "Design, test, implement, review" };

const g = graph();

g.node("architect", agent("architect", (s) => `Design the contract for: ${args.task}`));
g.node("red",       agent("red",       (s) => `Write failing tests for:\n${s.architect}`));
g.node("green",     agent("green",     (s) => `Implement until these pass:\n${s.red}\n\nContract:\n${s.architect}`));
g.node("reviewer",  agent("reviewer",  (s) => `Review:\n${s.green}`));

g.edge("architect", "red");
g.edge("red", "green");

// The routing decision this whole design exists for.
g.edge("green", (state, result) => {
  if (result.status === "blocked") {
    return result.blockedOn === "contract" ? "architect" : "red";
  }
  return "reviewer";
});

g.edge("reviewer", END);
g.run({ task: args.task });
```

When `green` blocks, the walk becomes:

```
architect → red → green → architect → red → green → reviewer
```

The repeat *is* the coordination.

## The DSL

A graph script is constrained JavaScript, validated and sandboxed before anything runs.

### Structure

```text
export const meta = { name: "snake_case", description: "what it does", whenToUse: "optional" };

const g = graph();          // exactly one per script
g.node(id, nodeDef);        // define nodes
g.edge(from, target);       // route between them
g.start(id);                // optional; defaults to the first node declared
g.run(initialState);        // required, once
```

### Node types

| Constructor | Purpose |
|---|---|
| `agent(name, promptFn)` | Spawn a subagent. `promptFn(state) => string` |
| `human(prompt \| promptFn, opts?)` | Ask the user. `opts: { options?, default? }` |
| `(state) => string` | Plain function node — pure JS, no LLM, instant |
| `command(cmdString, opts?)` | Fixed shell command, no LLM. `opts: { timeoutMs?, cwd?, env?, allowFailure? }` |

### Interactive Gates vs. In-Flight Tools

Workflows support two ways to bring external judgment/preferences into a run:
- **Interactive Nodes (`human(...)`)**: Structural gates defined explicitly in the graph script. The workflow walk pauses at this node and prompts the user.
- **In-Flight Tools (`ask_user_question`, `ask_supervisor`)**: Tools called by subagents during their execution. `ask_user_question` prompts the user directly (blocks the subagent indefinitely until the user answers — no timeout). `ask_supervisor` lets child subagents ask the main agent for a decision (10-minute timeout, then proceeds autonomously). Subagents must not use these tools to debug errors; those must be escalated via `STATUS: blocked`.

### Edges

```text
g.edge("a", "b");                                       // direct
g.edge("a", END);                                       // terminate
g.edge("a", (state, result) => result.status === "ok" ? "b" : "c");  // conditional
```

A node normally has **one** outgoing edge, and a conditional edge is how you choose between
targets. Give a node **several** outgoing edges and those branches run **in parallel** instead.

Cycles are legal — the escalation loop *is* a cycle. A run stops at `maxIterations` (default 35)
if a loop never resolves.

### Parallel branches

```text
g.edge("scout", "researcherA");
g.edge("scout", "researcherB");       // fan-out: both run concurrently
g.edge("researcherA", "summarizer");
g.edge("researcherB", "summarizer");  // fan-in: waits for both
```

Every graph runs in rounds; a node with one outgoing edge simply gets a round to itself, which is
an ordinary sequential walk. Three rules follow:

- **A fan-in node waits for every incoming edge.** `summarizer` runs once, after both researchers,
  and never sees partial work — even if the branches are different lengths. Conditional edges count toward that wait too.
- **Nodes in the same round cannot see each other's results.** Results are committed at the end of
  a round, so a branch cannot read its sibling. Anything that needs both belongs downstream.
- **Escalating from a branch re-runs its siblings.** Routing back to an earlier node restarts
  everything downstream of it on the next pass, so each pass stays consistent. Re-runs are cheap
  because an agent resumes its own session.

Each node's result is keyed by its own id (`s.researcherA`, `s.researcherB`), so branches never
clobber each other. Writing a *custom* shared key from two parallel edge conditions is
last-write-wins and will silently drop one — use distinct keys and combine them downstream.

A parallel run reports two numbers, e.g. *"6 node executions across 3 rounds"*: rounds measure how
deep the coordination went, node executions how much work happened. `maxIterations` caps rounds.

### Node types

Four kinds of node, one API:

```js
g.node('worker',   agent('worker', (state) => `Implement: ${state.plan}`)); // LLM agent
g.node('approve',  human('Ship it?', { options: ['yes', 'no'], default: 'yes' })); // human gate
g.node('dispatch', (state) => 'ready'); // fn node — pure JS, no LLM, instant
g.node('test',     command('npm test')); // command node — fixed shell command, no LLM
```

**Function nodes** are the new addition. Pass a plain arrow function as the second argument: it
receives the current graph state and returns a string that becomes the node's result text —
identical in shape to an agent result. No subprocess, no API call, runs in microseconds.

The primary use case is a **zero-cost fan-out hub**. A conditional edge can only return one
target. Put a function node at that target, then fan out to many via direct edges:

```js
// Without fn node: no way to conditionally fan-out
// With fn node: conditional edge → fn hub → direct fan-out

g.node('plan', agent('planner', () => 'plan...'));
g.node('dispatch', () => 'ready');  // fn hub — free
g.node('scout1', agent('scout', (s) => `check auth:\n${s.dispatch}`));
g.node('scout2', agent('scout', (s) => `check db:\n${s.dispatch}`));
g.node('scout3', agent('scout', (s) => `check api:\n${s.dispatch}`));
g.node('combine', agent('worker', (s) => `${s.scout1}\n${s.scout2}\n${s.scout3}`));

// Conditional gate: loop plan until the plan file exists, then fan out
g.edge('plan', (state, result) =>
  plan.get('sprint-plan').ok ? 'dispatch' : 'plan');
g.edge('dispatch', 'scout1');
g.edge('dispatch', 'scout2');
g.edge('dispatch', 'scout3');
g.edge('scout1', 'combine');
g.edge('scout2', 'combine');
g.edge('scout3', 'combine');
g.edge('combine', END);
g.run({});
```

Function nodes can also inspect state and use `plan`/`contract` sandbox functions:

```js
g.node('check', (state) => plan.get('sprint-plan').ok ? 'found' : 'missing');
g.node('label', (state) => `processing task: ${state.planner}`);
```

**Command nodes** run a real shell command synchronously — no LLM, no subprocess spawned by an
agent, just the command itself. Use them for deterministic checks that don't need judgement:
`npm test`, a linter, a build step.

```js
g.node('worker', agent('worker', (s) => 'implement the feature'));
g.node('test',   command('npm test'));
g.node('review', agent('reviewer', (s) => `Test output:\n${s.test}`));
g.edge('worker', 'test');
g.edge('test', 'review');
g.edge('review', END);
```

The command **must be a literal string** — not a variable, not built with `+`, not a template
literal with `${}` substitutions. This is enforced by the script validator at build time, not
left to convention: the whole safety property of a command node is that a human reviewing the
script sees the exact command that will execute, with nothing computed at runtime that could
change it.

```js
// Rejected — validator throws before the graph ever runs
const cmd = 'npm test';
g.node('test', command(cmd));

g.node('test', command('npm ' + suite));

g.node('test', command(`npm test ${args.suite}`));

// If a command genuinely needs to vary, let an edge choose between two
// literal command nodes — the choice is dynamic, the commands are not
g.edge('gate', (state, result) => args.ci ? 'test_ci' : 'test_local');
g.node('test_ci',    command('npm test -- --ci'));
g.node('test_local', command('npm test -- --watch=false'));
```

Result shape matches an agent's, so an edge written for agent results reads a command node's
result unmodified:

```text
{ status: "ok" | "blocked", text, data: { exitCode, stdout, stderr, timedOut } }
```

`status` is `"ok"` on exit code 0, `"blocked"` on nonzero — unless `allowFailure: true`, which
forces `"ok"` regardless (useful for best-effort steps where only "did it run" matters). `text`
is stdout, falling back to stderr if stdout was empty. Options: `timeoutMs` (default 30000ms,
matches acceptance verify commands), `cwd` (defaults to the run's cwd), `env` (merged over the
host's). A timeout is a technical failure that aborts the run by default — same as an agent spawn
failure — unless `allowFailure` is set, in which case it routes as `"ok"` instead. A command that
can't start at all (missing shell, bad cwd) always aborts regardless of `allowFailure` — there is
no exit code to route on.

```js
g.edge('test', (state, result) => result.status === 'ok' ? END : 'worker');
```

### State

Every node's result is stored under its id, and every prompt function receives the accumulated
state:

```text
g.node("green", agent("green", (s) => `Implement:\n${s.architect}`));
//                                              ^ architect's result
```

Interpolating a result yields the agent's **text**; edge conditions get the structured fields:

```js
{ status: "ok" | "blocked", text, blockedOn?, reason?, evidence?, proposedFix?, data }
```

That bare `s.architect` above works because a result carries a `toString()` returning `.text` —
string concatenation and template interpolation trigger it automatically. Anything that needs a
structured field directly (`result.status`, `result.blockedOn`, `result.data`) has to name it
explicitly; `s.architect` alone is an object, not a string, outside a coercion context.

`result.data` is the folded `node_state` buffer for that node — always an object (empty `{}`
if the node never called `node_state`). Read it in prompts as `s.<nodeId>.data.<key>` and in
edge conditions as `result.data.<key>` or `state.<nodeId>.data.<key>`:

```js
// In a prompt function: read a completed node's accumulated findings
g.node('assembler', agent('worker', (s) =>
  `Invoice: ${s.extractor.data?.invoice_number ?? 'unknown'}\n` +
  `Vendor:  ${s.extractor.data?.vendor ?? 'unknown'}`));

// In an edge: gate on how many findings were accumulated
g.edge('extractor', (state, result) =>
  Object.keys(result.data).length < 5 ? 'extractor' : 'assembler');
```

> ⚠️ **`${s.nodeId}` gives the reply text only — `data` is invisible to interpolation.**
> This is the most common surprise when using `node_state`. Say worker1 called:
> `node_state({ action: "merge", key: "summary", value: { risk: "low" } })`
>
> Then in worker2:
> ```js
> // ❌ data is NOT in the interpolated string
> `process this: ${s.worker1}`
> // → "process this: <worker1's reply text>"
> // The { summary: { risk: "low" } } buffer is silently absent.
>
> // ✅ Access data fields explicitly
> `Risk: ${s.worker1.data?.summary?.risk ?? 'unknown'}`
> // → "Risk: low"
>
> // ✅ Or dump the whole buffer as JSON
> `Summary: ${JSON.stringify(s.worker1.data)}`
> // → 'Summary: {"summary":{"risk":"low"}}'
>
> // ✅ Both text and data side by side
> `${s.worker1}\nRisk: ${s.worker1.data?.summary?.risk}`
> // → "<worker1 reply text>\nRisk: low"
> ```

### What is available

The graph API — `graph`, `agent`, `human`, `command`, `END`, `args` — plus ordinary language
intrinsics (`JSON`, `Object`, `Array`, `String`, `Math` for arithmetic, and so on).

No `fs`, `process`, `require`, `import`, `fetch`, `Date`, or `Math.random`. A graph describes
routing; it does not need ambient authority, and non-determinism would mean a rerun of the same
graph could take a different path. `command()` is not a loophole here — it does not give script
code a callable exec function; it declares one node whose fixed, literal command string is visible
in the script text a human reviews. There is no way to reach a shell from a fn node, an edge
condition, or a prompt function.

**`plan` and `contract` are also available** — synchronous access to the same store that
the `plan` and `contract` tools use, bound to the project's `cwd` at script load time.
All calls use `fs.*Sync` internally so they work in both edge conditions and prompt functions.

| Call | Returns | Notes |
|---|---|---|
| `plan.get(id)` | `{ ok, content? }` | Read a plan — `ok:false` if not found, never throws |
| `plan.list()` | `{ ok, plans? }` | All plans, newest first |
| `plan.create(name, content)` | `{ ok, id? }` | Create a new plan |
| `plan.edit(id, old, new)` | `{ ok }` | Find-and-replace in a plan |
| `plan.delete(id)` | `{ ok }` | Delete a plan |
| `contract.get(id)` | `{ ok, content? }` | Read a contract — `ok:false` if not found, never throws |
| `contract.list()` | `{ ok, contracts? }` | All contracts, newest first |
| `contract.create(params)` | `{ ok, id? }` | Create a draft contract |
| `contract.edit(id, old, new)` | `{ ok }` | Find-and-replace (draft only) |
| `contract.propose(id)` | `{ ok }` | Move draft → proposed |
| `contract.supersede(oldId, params)` | `{ ok, id? }` | Create v+1 draft |

**`get` never throws.** For a missing id it returns `{ ok: false }`. This means:
- Existence check: `plan.get('foo').ok`
- Character count: `plan.get('foo').content?.length`
- Keyword search: `plan.get('foo').content?.includes('JWT')`

No separate `isExists`, `length`, or `indexOf` helpers are needed.

**Gate on contract status — loop architect until it proposes the contract:**

```text
export const meta = { name: 'tdd_gated', description: 'Design contract, then implement' };
const g = graph();

g.node('architect', agent('architect', (s) =>
  `Design the auth API contract. When done, call contract(action:"propose", id:"auth-api").`));

// Edge reads the file directly — no gate node needed
g.edge('architect', (state, result) => {
  const c = contract.get('auth-api');
  if (!c.ok) return 'architect';                              // not created yet
  if (c.content.includes('status: draft')) return 'architect'; // created but not proposed
  return 'worker';                                            // proposed — advance
});

g.node('worker', agent('worker', (s) => {
  const c = contract.get('auth-api');
  return `Implement against this contract:\n${c.content}\n\nArchitect output:\n${s.architect}`;
}));
g.edge('worker', END);
g.run({ task: args.task });
```

**Embed the current plan in a prompt — always uses the latest version:**

```text
export const meta = { name: 'plan_driven', description: 'Read plan at execution time' };
const g = graph();

g.node('planner', agent('planner', () =>
  `Investigate the codebase and write a plan using plan(action:"create", ...). ` +
  `When done, call plan(action:"propose", id:"sprint-plan").`));

// Prompt function runs at node execution time, not script load time — always fresh
g.node('worker', agent('worker', (s) => {
  const p = plan.get('sprint-plan');
  return p.ok
    ? `Execute this plan:\n${p.content}`
    : `No plan found — use your best judgment. Context:\n${s.planner}`;
}));

g.edge('planner', (state, result) =>
  plan.get('sprint-plan').ok ? 'worker' : 'planner'); // loop until plan exists
g.edge('worker', END);
g.run({});
```

**List all contracts to give the architect context:**

```js
g.node('architect', agent('architect', (s) => {
  const r = contract.list();
  const existing = r.contracts?.map(c => `- ${c.id} (${c.status})`).join('\n') ?? 'none';
  return `Existing contracts:\n${existing}\n\nDesign a new contract for: ${args.feature}`;
}));
```

**Search contract content for a keyword — skip redesign if already covered:**

```js
g.edge('architect', (state, result) => {
  const c = contract.get('auth-api');
  if (c.ok && c.content.includes('JWT')) return 'worker'; // already covers JWT
  return 'architect';                                     // needs redesign
});
```

Scripts are checked with an acorn AST pass, then evaluated in a `vm` context. Intrinsics are
deliberately **not** injected from the host: a vm context has its own realm-local copies, and
passing the host's would hand a script a route back to the host realm through
`Object.constructor`. Prototype access (`constructor`, `__proto__`, `getPrototypeOf`) is rejected
outright — routing logic has no use for it.

Validation happens **before any agent spawns**, so a bad script costs nothing.

## The escalation protocol

Bundled agents that can get stuck are taught to emit:

```
STATUS: blocked
BLOCKED_ON: contract | tests | environment | requirements | information | conflict
REASON: <what they hit>
EVIDENCE: <file:line, error output>
PROPOSED_FIX: <what would unblock them>
```

The same block is **auto-injected** into every workflow agent's system prompt at spawn time, so a
custom agent that was not taught the protocol can still report a blocker (see [Creating custom
agents](#creating-custom-agents)).

`BLOCKED_ON` is a **closed vocabulary** because it is a routing key, not prose — it decides *who
gets asked*. A `contract` blocker goes to whoever designed the interface; a `tests` blocker goes to
whoever wrote them.

`green.md` and `worker.md` additionally forbid the shortcut failure modes by name — mocking the
thing under implementation, weakening or deleting tests, hardcoding to test inputs, claiming done
while red — and state plainly that **escalating is a successful outcome; faking a pass is the only
real failure.**

## Bundled agents

| Agent | Role | Writes files |
|---|---|---|
| `planner` | Decomposes a task into a verifiable plan; saves it with the `plan` tool | no |
| `architect` | Owns the contract: interfaces, invariants, error cases; saves it with the `contract` tool | no |
| `monitor` | Independent plan-feasibility gate | no |
| `red` | Writes failing tests that encode the contract | yes |
| `green` | Implements until tests pass | yes |
| `reviewer` | Independent review — nobody grades their own homework | no |
| `researcher` | Deep read-only investigation, cites `file:line` | no |
| `scout` | Fast reconnaissance, cheap first pass | no |
| `worker` | General implementation outside a full TDD pipeline | yes |

Read-only roles have no `write`/`edit` tools — that restriction is mechanical, not advisory.

Agents resolve live from the installed package, so upgrades propagate and nothing is written into
your repository.

## Customizing & Overriding Agents

You can customize, override, or replace any bundled agent using three mechanisms (lightest first):

### 1. Fine-grained overrides (`settings.json`)

To override specific properties of an agent (such as its LLM model, budget, or tools) without copying the entire markdown file, create a settings file:
- **Project-level**: `.pi-workflow/settings.json`
- **User-level**: `~/.pi/agent/pi-workflow-settings.json` (or `<agentDir>/pi-workflow-settings.json`)

Example:
```json
{
  "agents": {
    "green": {
      "model": "anthropic/claude-3-7-sonnet",
      "systemPromptAppend": "This project uses tabs. Never touch src/legacy/."
    }
  }
}
```

*Note: `systemPromptAppend` is recommended for adding rules to a bundled agent, since replacing the whole `systemPrompt` wholesale makes it prone to drift when upgrading the package.*

Supported override fields:
- `model`: Change the primary LLM model.
- `fallbackModels`: Array of backup models.
- `thinking`: Adjust thinking budget (`"off"`, `"low"`, `"medium"`, `"high"`, or `false`).
- `tools`: Array of allowed tool names (e.g. `["read", "bash"]`).
- `systemPrompt` / `systemPromptAppend`: System prompt overrides.
- `turnBudget` / `toolBudget`: Execution limits.

### 2. Disabling agents

To remove a bundled agent from the roster entirely:
```json
{
  "agents": {
    "monitor": {
      "disabled": true
    }
  }
}
```

Or to disable all built-ins globally:
```json
{
  "disableBuiltins": true
}
```

### 3. Extension behaviour toggles

Top-level keys (outside `agents`) control extension behaviour. Currently supported:

```json
{
  "blankStopGuard": false
}
```

- `blankStopGuard`: disables the auto-"continue" guard for empty model completions
  (see "Production behaviour"). Defaults to enabled when absent. Read once at process
  start from the directory pi runs in; commit the file to git so worktree-isolated
  subagent runs also see it.

### 3. Shadowing (Full file replacement)

You can override a built-in agent completely by creating a markdown file with the exact same name in your agent directories:
- **Project-level**: `.pi/agents/<name>.md` (wins over user and built-in)
- **User-level**: `~/.pi/agent/agents/<name>.md` (wins over built-in)

Precedence order: `builtin < user < project`.

### Creating custom agents

Author a markdown file in `.pi/agents/<name>.md` (project scope) or `~/.pi/agent/agents/<name>.md`
(user scope). The `name` and `description` frontmatter fields are required; everything else is
optional. See the bundled agents in `bundled-agents/` for complete, working examples.

```markdown
---
name: migrator
description: Writes database migrations from a schema diff.
model: claude-sonnet-4
tools: read, write, edit, bash, grep
maxTurns: 15
acceptance:
  level: checked
defaultContext: fork
---

# Migrator

You write forward-only database migrations from a schema diff.

## Your job
1. Read the current schema and the target schema.
2. Write a migration that moves from one to the other.
3. Run it against a scratch database and verify.

## Escalation

If you can't complete the task, say so instead of faking it:

STATUS: blocked
BLOCKED_ON: requirements | environment | conflict
REASON: <specifically what you hit>
EVIDENCE: <error output, file:line>
PROPOSED_FIX: <what would unblock you>

Escalating with a clear reason is a good outcome. Faking completion is the only real failure.
```

#### The escalation protocol — auto-injected

The graph routes on a structured signal, not prose. When an agent cannot finish, it emits the
`STATUS: blocked` block above and the edge condition routes the blocker to whoever owns the
problem. This is the entire coordination mechanism — **there is no other channel.**

**The protocol is auto-injected into every workflow agent's system prompt at spawn time.** A
custom agent whose `.md` omits the `## Escalation` section still receives it — it can always
report a blocker the graph can route on. Including the section in your `.md` is still recommended
(it documents intent and reinforces the instruction), and it is idempotent: if the block is
already present the injection is skipped, so there is never a duplicate.

`BLOCKED_ON` is a closed vocabulary because it is a routing key, not free text. Reuse the existing
categories when one fits:

| Category | Means | Typically routes to |
|---|---|---|
| `contract` | The interface/contract can't express what's needed | the architect |
| `tests` | The tests themselves are wrong or missing | whoever wrote them |
| `requirements` | The task is contradictory or too vague | the planner |
| `information` | Needed context is missing | a researcher/scout |
| `environment` | A tool, dependency, or env is broken/unavailable | the human |
| `conflict` | Two requirements or constraints collide | the human |

The parser preserves any unrecognised value verbatim, so a custom category still reaches the
edge — but an edge author will have written a route for the recognised ones.

Two principles that make a custom agent safe in a graph, borrowed from the bundled implementers:
1. **Escalating is a successful outcome.** Say so plainly. The shortcut (mocking, weakening tests,
   hardcoding) must be the *only* thing called a failure.
2. **Forbid the shortcut failure modes by name** for any agent that writes code: no mocking the
   thing under implementation, no weakening or deleting tests, no hardcoding to test inputs, no
   claiming done while the suite is red.

## Tools

All tools are available to every agent and subagent automatically — no frontmatter declaration needed for the tools marked *always injected* below.

### `workflow`

| Parameter | Purpose |
|---|---|
| `script` | The graph script (or use `loadWorkflow`) |
| `args` | Values available as `args`; must be JSON-serialisable |
| `maxIterations` | Node-execution cap. Default 35 |
| `tokenBudget` | Soft budget — warns at 80% and 100%, never kills a run |
| `useWorktree` | Run agents in an isolated git worktree |
| `resumeRunId` | Resume a run, skipping completed nodes |
| `loadWorkflow` / `saveWorkflow` | Reuse a saved graph by name |

### `subagent`

Single or parallel delegation, unchanged. Use it when there is no coordination to do.

### `workflow_reply`

Answers a pending `ask_supervisor` question from a subagent. Called automatically when the main
agent receives a `workflow-agent-question` message — the question and a receipt appear inline so
the main agent can respond immediately via this tool.

### `ask_user_question` *(always injected)*

Called by a subagent or workflow node to ask the user a question directly. The question appears as
a TUI dialog; the subagent blocks indefinitely until the user answers (no timeout). Use for
decisions only the user can make. Do not use to report errors — escalate via `STATUS: blocked`.

### `ask_supervisor` *(always injected)*

Called by a subagent or workflow node to ask the main agent a question. The main agent detaches
from the child's tool call and receives the question inline. If unanswered within 10 minutes the
child proceeds autonomously. Use for architectural decisions or clarifications. Do not use to
debug errors — escalate via `STATUS: blocked`.

### `subagent_wait`

Lets the main agent wait for or check on a detached subagent. When a subagent calls
`ask_supervisor`, it detaches and runs in the background; `subagent_wait` lets the main agent
rejoin its completion after answering.

| Parameter | Purpose |
|---|---|
| `id` | Run id of the detached subagent |
| `timeoutMs` | How long to wait (default: no timeout) |
| `status` | If `true`, lists all active runs instead of waiting |

### `list_agents`

Lists available agents. The roster is also injected into `workflow`'s guidelines, so the model
knows what exists without asking.

### `list_workflows`

Lists all available workflows across all three scopes (built-in, user-global, and project-saved).

### `workflow_status`

Inspects a run's progress or investigates a failure.

### `plan` *(always injected)*

Creates and manages Markdown plans stored in `.pi-workflow/plans/`. Available in **all modes**
including plan mode (where `write`/`edit` are blocked). Typically produced by the `planner` agent;
any agent can read.

| Action | Description |
|---|---|
| `create` | Write a new plan; returns the assigned id |
| `get` | Read a plan by id |
| `list` | List all plans with name and last-updated |
| `edit` | Precision find-and-replace (`oldText` must match exactly once) |
| `delete` | Remove a plan |

### `contract` *(always injected)*

Creates and manages versioned contracts stored in `.pi-workflow/contracts/`. Available in all
modes. Typically produced by the `architect` agent; any agent can read.

| Action | Description |
|---|---|
| `create` | Write a new `draft` contract (type: `api`\|`interface`\|`task`\|`data`\|`other`) |
| `get` | Read a contract by id (includes frontmatter: status, version, producer, consumer) |
| `list` | List all contracts with type, status, title |
| `edit` | Precision find-and-replace — **draft contracts only** |
| `propose` | Move `draft` → `proposed`; signals the contract is final for consumers |
| `supersede` | Create v+1 draft from an existing contract; marks old as `superseded` |

**Lifecycle:** `draft` → `propose` → `proposed` → `supersede` → `superseded` (old) + new `draft`

**Discipline:** always call `propose` when done writing. Consumers should only act on `proposed`
contracts — a `draft` may still be changing.

### `node_state` *(always injected — workflow-only)*

Accumulates intermediate findings into a durable, per-node buffer that survives context
compaction. Use it when a node searches many files or runs for a long time — write each finding
the moment it is found so compaction cannot lose it.

| Action | Description |
|---|---|
| `set` | Overwrite a key (last-write-wins) |
| `merge` | Shallow-merge an object into a key |
| `append` | Push a value onto an array at a key |
| `get` | Read one key's current value (own buffer only) |
| `list` | Read the whole accumulator (own buffer only) |

**Workflow-only.** Works inside a graph `agent()` node. A plain `subagent` call or the main
session gets a clear refusal (unlike `ask_supervisor`, which works in both).

**Two-phase visibility — the one rule that resolves all confusion:**

| Phase | When | Who can read/write | How |
|---|---|---|---|
| **Private** | While the node runs | That node only | `node_state` tool (`get`/`set`/etc.) |
| **Public** | After the node completes | Every downstream node and edge | `s.<nodeId>.data.<key>` in prompts/edges |

The buffer is folded into `result.data` when the node exits, and the executor stores
`state[nodeId] = result`. From that moment it is graph state — readable by all without a tool
call.

**Cross-node reads go through graph state, not `node_state(get)`:**

```js
// ❌ Wrong — a node calling get on another node's key returns unset
node_state({ action: "get", key: "planner_value" })   // → unset (own buffer only)

// ✅ Right — downstream node reads the completed planner's folded data via graph state
g.node("worker", agent("worker", (s) =>
  `Planner said: ${s.planner.data?.planner_value ?? "(none)"}`))
```

**Fan-out extraction — two extractors, one assembler:**

```js
// Each extractor writes its own findings; assembler reads both from graph state
g.node("extract_a", agent("researcher", (s) =>
  `Search docs/invoices/. For each invoice call:\n` +
  `node_state({ action: "set", key: "invoice_number", value: "<v>" })\n` +
  `node_state({ action: "append", key: "items", value: "<item>" })`));

g.node("extract_b", agent("researcher", (s) =>
  `Search docs/receipts/. Same node_state calls.`));

g.node("assemble", agent("worker", (s) =>
  `Combine:\nA: invoice=${s.extract_a.data?.invoice_number}, items=${JSON.stringify(s.extract_a.data?.items)}\n` +
  `B: invoice=${s.extract_b.data?.invoice_number}, items=${JSON.stringify(s.extract_b.data?.items)}`));

g.edge("scout", "extract_a"); g.edge("scout", "extract_b");  // fan-out
g.edge("extract_a", "assemble"); g.edge("extract_b", "assemble");  // fan-in
g.edge("assemble", END);
```

**Cycle driven by a pass counter in `node_state`** (requires real agents calling node_state):

```text
g.node("plan", agent("planner", (s) =>
  `Pass ${(s.plan.data?.passes ?? 0) + 1} of 3. Task: ${args.task}\n` +
  `Call when done: node_state({ action: "set", key: "passes", value: ${(s.plan.data?.passes ?? 0) + 1} })`));

// Edge reads the COMPLETED visit's folded data — executor writes state before routing
g.edge("plan", (state) =>
  (state.plan.data?.passes ?? 0) < 3 ? "plan" : "worker");
```

> ⚠️ **A constant flag loops forever.** Writing the same value every visit (e.g. `passes = 1`
> unconditionally) means the edge condition never changes. Use a counter that increments, or
> stop writing it on the final visit. `maxIterations` caps rounds as a last resort.

**Lifecycle:** a node's `data` follows the same lifecycle as its `text` — revisiting overwrites
the entry, and resume never reconstructs a crashed node's in-flight writes. **Cross-node
conflicts are author-gated** — if two parallel shards disagree on the same key, write a gate
node to compare `state.<nodeId>.data` and route to resolution; the reducer never silently picks.

## Skills

Three skills ship with the package and appear in `pi config`:

| Skill | Loaded by | Purpose |
|---|---|---|
| `pi-workflow` | normal + workflow modes | Complete reference for the `subagent` and `workflow` tools, graph DSL, escalation vocabulary |
| `pi-plans` | all modes | Reference for the `plan` tool — format, actions, edit precision, plan id slugs |
| `pi-contracts` | all modes | Reference for the `contract` tool — types, lifecycle, discipline rules, full coordination example |

Skills are discoverable via `/skill:pi-workflow`, `/skill:pi-plans`, `/skill:pi-contracts`.
Compact hints are injected into every turn automatically so the agent knows these skills exist
without being forced to read them.

## Commands

| Command | Purpose |
|---|---|
| `/workflows` | Interactive TUI navigator: runs → phases → nodes → detail |
| `/plans` | Interactive TUI navigator: browse and read plans in `.pi-workflow/plans/` |
| `/contracts` | Interactive TUI navigator: browse contracts with type/status colour coding |
| `/wf normal\|plan\|workflow` | Switch execution mode (Normal, Plan, or Workflow) |
| `/agents` | Show the discovered agent roster |
| `/saved-workflows` | List or delete saved workflow scripts |

`/workflows` shows the walk with routing inline, so an escalation loop is legible at a glance:

```
● architect (architect)  → green      Contract v1: UserRepo.findById
● green (green)          → architect  blocked on contract: cannot express soft-delete
● architect (architect)  → green      Contract v2: adds deletedAt
● green (green)          → reviewer   Implemented against revised contract
● reviewer (reviewer)    → END        Approved
```

During a run the status line names the node currently working:

```
▶ tdd_feature: green (green) · step 4 · 12.4kt
```

### Execution modes (`/wf`)

You can switch the execution mode of the session using the `/wf` command to enforce specific tool
and behavioral restrictions on the agent. The current mode is displayed as a sticky status widget
below the editor.

* **`/wf normal`** (or `/wf build`): The default mode. All tools are enabled, and the agent can
  write files directly or delegate.
* **`/wf plan`**: Read-only mode. Blocks `write`, `edit`, all subagent and workflow tools, and
  restricts `bash` to read-only commands (e.g. `cat`, `grep`, `ls`, `git diff`). The `plan` tool
  remains available — use it to record plans and research findings without touching the codebase.
* **`/wf workflow`** (or `/wf on`): Enforced delegation mode. Blocks direct writes (`write`,
  `edit`) and direct subagents (`subagent`). Forces the agent to write a graph script and execute
  it via the `workflow` tool for any file changes or task delegation.

The active mode prompt is continuously injected into the agent's system prompt along with a
high-salience banner to prevent model confusion.

## Production behaviour

**Failures are classified.** Technical failures (spawn died, process killed, run aborted) abort the
graph — there is no agent judgement to route on. Agent-level failures (blocked, turn budget
exhausted) are *results*, and edges decide what happens. This distinction is what makes escalation
possible at all.

**Runs are journaled** to `.pi-workflow/runs/<runId>.jsonl`, one record per node visit. Resume
replays them and continues from where work stopped:

```
resumeRunId: "graph-1786003895762"
```

Resume is refused if the script changed — replaying old results into rerouted edges would describe
a run that never happened.

**Artifacts** land in `.pi-workflow/artifacts/runs/<runId>-<agent>-<n>/` (`input.md`, `output.md`,
`transcript.jsonl`, `events.jsonl`, `metadata.json`), inside the project rather than in
`~/.pi/agent/sessions`.

**Budgets are tracked, not enforced.** Aborting at 100% abandons work already paid for; the useful
signal is "this cost more than expected".

**Headless runs never hang.** A `human()` node with a `default` answers with it and records that it
did; without one it is marked `skipped` — never `approved`. Silence is not consent.

**Worktree isolation** degrades to the project directory when the cwd is not a git repo, rather
than refusing to run.

**Human questions never time out.** `ask_user_question` blocks the subagent indefinitely — the
user can take as long as needed. If the subagent run ends before the user answers, the dialog
closes cleanly. `ask_supervisor` has a 10-minute timeout after which the child proceeds
autonomously.

**Blank model stops are auto-continued.** Some models (notably Gemini Flash tiers) occasionally
return a "successful" turn with nothing in it — `content: []`, zero output tokens,
`stopReason: "stop"` — which pi-coding-agent treats as a clean completion (its auto-retry only
fires on `stopReason: "error"`). The guard detects this shape and sends a visible `continue`
user message, exactly as you would by hand; the model resumes with its full context intact.
It runs in the main agent and in every subagent (the extension is injected into each child),
sends at most 3 times for consecutive blanks, resets after any healthy turn, and never
interferes with retry/compaction — those are checked before the guard's queued message. If the
model stays blank after 3 nudges, the empty result flows out unchanged and workflow-level
backstops (retry edges) remain the last line of defense.

Set `"blankStopGuard": false` in `.pi-workflow/settings.json` to disable it for the whole
project (default: enabled). The setting is read once at process start from the directory pi
runs in — main agent and every subagent — so commit the file to git if you want the toggle to
apply inside worktree-isolated runs.

## Compatibility

Works alongside [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system).
Unknown frontmatter keys are preserved verbatim in `extraFields`, so a `permission:` block written
for that extension survives discovery intact.

## Development

```bash
npm run check       # typecheck + tests
npm test
npm run typecheck
```

## Design

[`docs/GRAPH-WORKFLOW-DESIGN.md`](./docs/GRAPH-WORKFLOW-DESIGN.md) covers the reasoning: why a
graph rather than a pipeline, why code rather than JSON, why no external framework, and what is
deliberately excluded.

## Not included

- **Persistent agents.** Agents are spawned per node execution and run to completion.
- **External notification.** Human-in-the-loop is pi-native (`ctx.ui`) only.
- **Frameworks.** No LangGraph, LangChain, CrewAI, or XState. The executor is a few hundred lines
  purpose-built for spawning pi subprocesses.
