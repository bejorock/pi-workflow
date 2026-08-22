---
name: pi-workflow
description: Subagent delegation and dynamic workflow orchestration. Use the subagent tool to delegate tasks to specialized agents, and the workflow tool to orchestrate multi-agent deterministic workflows.
---

# Pi Workflow Skill

This skill teaches you how to delegate tasks to specialized subagents and orchestrate multi-agent workflows.

## How to Spawn a Subagent

The `subagent` tool delegates a task to a specialized agent. You call it like this:

```
subagent(tasks=[{"agent": "AGENT_NAME", "task": "TASK_DESCRIPTION"}], mode="single")
```

**Step 1: Check available agents**
First, use the `/agents` command to see what agents are available, or check `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`.

**Step 2: Call the subagent tool**
```
subagent(tasks=[{"agent": "scout", "task": "Find security issues in the authentication module"}], mode="single")
```

The tool will:
1. Discover the agent file (e.g., `scout.md`) from the agent scope
2. Apply the agent's frontmatter (model, tools, turnBudget, etc.)
3. Spawn a child pi process with the agent's configuration
4. Return the subagent's output

**Step 3: Handle the result**
The result is the subagent's output string. Use it in your response or chain it to another subagent.

## How to Run Parallel Subagents

```
subagent(tasks=[{"agent": "scout", "task": "Review auth module"}, {"agent": "scout", "task": "Review payment module"}], mode="parallel")
```

## How to Run a Workflow

The `workflow` tool runs a **graph** of coordinating agents: nodes are agents, edges decide where
each result goes next. Use it when the path is not known in advance — particularly when an agent
might hit a wall and need to hand the problem back to whoever can fix it. For a single delegation
with no coordination, use `subagent` instead.

```
workflow(script="export const meta = { name: 'audit', description: 'Security audit' };
const g = graph();
g.node('scan', agent('scout', (s) => 'Find security issues in: ' + s.target));
g.node('verify', agent('researcher', (s) => 'Verify these findings with evidence:\n' + s.scan));
g.edge('scan', 'verify');
g.edge('verify', END);
g.run({ target: args.target });", args={ target: "auth module" })
```

**Building a graph:**
- `graph()` — create the graph (exactly one per script)
- `g.node(id, agent(name, (state) => prompt))` — an agent node
- `g.node(id, human(prompt | promptFn, { options, default }))` — ask the user; always give a `default`
- `g.node(id, (state) => 'result')` — a function node: pure JS, no LLM, instant
- `g.node(id, command('shell command', { timeoutMs, cwd, env, allowFailure }))` — a shell command from a literal string, no LLM
- `g.node(id, command((state) => "shell " + state.x))` — dynamic command: built from state at run time, no LLM (use it sparingly; see Command nodes below)
- `g.edge(from, to)` / `g.edge(from, END)` — direct routing
- `g.edge(from, (state, result) => target)` — conditional routing
- `g.run(initialState)` — start it

**`human()` prompt interpolation:** inside a `human()` prompt string, use `#{nodeId}` to embed a
node's result text — e.g. `human('Review this:\n#{researcher}', { default: 'approve' })`. This is
different from the `${s.nodeId}` syntax used in `agent()` prompt functions — `${}` is a JS
template literal evaluated at script-load time; `#{}` is resolved by the runtime when the human
node actually executes.

**State flows between nodes.** Each node's result is stored under its id, so a later node reads an
earlier one via `s.<nodeId>`. Interpolating a result (string concatenation or `${}`) gives the
agent's text via an automatic `toString()`; edge conditions get the structured object directly —
`{ status, text, blockedOn, reason, data }` — and any field beyond `.text` (e.g. `result.status`,
`result.blockedOn`, `result.data`) must be accessed explicitly. Bare `s.<nodeId>` only stringifies
to `.text` inside a coercion context; it is not a plain string outside one. `s.<nodeId>.data`
contains the node's folded `node_state` buffer (an object), always present after the node
completes (empty object `{}` if `node_state` was never called).

**`${s.nodeId}` gives the reply text only — `data` is invisible to interpolation.**
This is the most common surprise when using `node_state`. If worker1 called
`node_state({ action: "merge", key: "summary", value: { risk: "low" } })`, then in worker2:

```js
g.node('worker2', agent('worker2', (s) => `process this: ${s.worker1}`));
//                                                        ^^^^^^^^^^^^
//  Produces: "process this: <worker1's reply text>"
//  The node_state data is NOT included. data is silently absent from interpolation.
```

To pass `node_state` data to the next node you must name the fields explicitly:

```js
g.node('worker2', agent('worker2', (s) =>
  // Access individual fields
  `Risk level: ${s.worker1.data?.summary?.risk ?? 'unknown'}\n` +
  // Or dump the whole buffer as JSON
  `Full summary: ${JSON.stringify(s.worker1.data)}\n` +
  // The reply text is still available alongside it
  `Worker1 said: ${s.worker1}`
));
```

**Function nodes — pure JS, no LLM.** Pass a plain arrow function as the second argument to
`g.node()` to create a zero-cost hub node. The function receives the current graph state and
returns a string that becomes the node's result text — identical in shape to an agent result, so
downstream prompts (`${s.dispatch}`) and edges work unchanged. No subprocess, no API call.

**Primary use case: conditional fan-out.** A conditional edge returns one target. A function node
acts as that one target, then fans out to many via normal direct edges:

```js
// Gate: conditional edge routes to dispatch or loops back
g.edge('plan', (state, result) => {
  const p = plan.get('sprint-plan');
  return p.ok ? 'dispatch' : 'plan';
});

// dispatch is a fn node — no agent, no cost
g.node('dispatch', () => 'ready');
g.edge('dispatch', 'scout1');
g.edge('dispatch', 'scout2');
g.edge('dispatch', 'scout3');

// scouts fan-in to combine as normal
g.edge('scout1', 'combine');
g.edge('scout2', 'combine');
g.edge('scout3', 'combine');
```

The fn receives `state` and can use it or the `plan`/`contract` sandbox functions:
```js
g.node('dispatch', (state) => `running plan: ${state.plan}`);
g.node('check',    (state) => plan.get('sprint-plan').ok ? 'found' : 'missing');
```

**Command nodes — a shell command, no LLM.** `command(cmdString, options)` runs a real
shell command synchronously, with no agent involved. Use it for deterministic, mechanical checks
that don't need judgement — `npm test`, a linter, a build step:

```js
g.node('worker', agent('worker', (s) => 'implement the feature'));
g.node('test',   command('npm test'));
g.node('review', agent('reviewer', (s) => `Test output:\n${s.test}`));
g.edge('worker', 'test');
g.edge('test', 'review');
g.edge('review', END);
```

**The direct argument must be a literal string or a function — nothing in between.** This is
enforced by the script validator, not just convention: `command(someVariable)`,
`command('npm ' + suite)`, and a template literal containing `${}` as the direct argument are
all rejected at build time. The default and preferred form stays the literal: a human reviewing
the script sees the exact command that will run. If a command genuinely needs to vary, prefer
two literal command nodes with an edge choosing between them — the *choice* is dynamic, the
commands themselves are not:

```js
g.edge('gate', (state, result) => args.ci ? 'test_ci' : 'test_local');
g.node('test_ci',    command('npm test -- --ci'));
g.node('test_local', command('npm test -- --watch=false'));
```

**Dynamic form — `command((state) => ...)` — use it only when the command cannot be enumerated
up front.** The function receives the full graph state (same shape as a prompt function) and
its return value is handed to the shell **verbatim — no escaping, no quoting**. Anything an
upstream agent placed in state, including shell metacharacters in its free-text output,
executes as-is. That risk is yours. A function that throws, or returns an empty/non-string
result, is a technical failure — the run aborts with a clear error:

```js
// Acceptable when the target file genuinely cannot be known ahead of time
g.node('test', command((state) => `npm test -- ${state.scout.data.testFile}`));
```

**Result shape matches an agent's.** `result.status` is `"ok"` on exit code 0, `"blocked"` on a
nonzero exit (same vocabulary an agent's escalation uses, so an edge written for agent results
also reads a command node's result unmodified). `result.text` is stdout (or stderr if stdout was
empty). `result.data` carries `{ exitCode, stdout, stderr, timedOut }` for anything beyond the
text. Options: `timeoutMs` (default 30000), `cwd` (defaults to the run's cwd), `env` (merged over
the host's), `allowFailure` (forces `status: "ok"` even on a nonzero exit — for best-effort steps
where only "did it run" matters, not "did it pass"). A timeout is a technical failure that aborts
the run by default, same as an agent spawn failure — unless `allowFailure` is set, in which case
it routes as `"ok"` instead of aborting. A command that cannot start at all (missing shell, bad
cwd) always aborts the run regardless of `allowFailure` — there is no exit code to route on, so
there is nothing for an edge to decide between.

```js
g.edge('test', (state, result) => result.status === 'ok' ? END : 'worker');
```

**Revisiting a node overwrites its state entry.** A node is not single-use: an edge can route
back to it any number of times (a run is capped at `maxIterations`, default 45). But when a node
runs again, `s.<nodeId>` is replaced with the **latest** result — earlier results are dropped from
state (the full visit sequence is still recorded in the run's history/path). This is deliberate:
cycles are for *iterative refinement* where each pass only needs the most recent state (red finds
failures → green fixes them → back to red which re-runs tests). It is **not** a way to collect one
output per pass. If you must keep every intermediate output, give each step its own node id.

**Route blockers to whoever owns the problem.** When an agent reports `status === 'blocked'`, send
it back rather than retrying the same node — that is the entire point of the graph:

```
g.edge('green', (state, result) => {
  if (result.status === 'blocked') {
    return result.blockedOn === 'contract' ? 'architect' : 'red';
  }
  return 'reviewer';
});
```

Cycles are allowed and are how escalation works. A run stops at `maxIterations` (default 45) if a
loop never resolves.

### Interactive Gates vs. In-Flight Tools

Workflows support two distinct ways to bring external judgment or decisions into a run:

1. **Interactive Nodes (`human(...)`)**
   - **Purpose:** Structural gates defined explicitly in the graph routing.
   - **Usage:** The workflow walk pauses at this node. The user is prompted (via a custom TUI or command line) for input before routing continues.
   - **Rule:** Always specify a `default` fallback for human nodes so a headless run (no TUI) does not hang.

2. **In-Flight Tools (`ask_user_question`, `ask_supervisor`)**
   - **Purpose:** Prompting for details *while an agent is executing* inside its node.
   - **`ask_user_question`**: Spawns a custom questionnaire dialog to ask the user. Used when an agent needs user values or design preferences to proceed.
   - **`ask_supervisor`**: Child agents call this to ask the main agent (the supervisor) for instructions or to report progress.
   - **Restrictions:** Agents MUST NOT use these tools to debug errors or ask for code implementations. Errors and missing capabilities must be escalated via the escalation protocol (`STATUS: blocked`).

### Edge result shape and escalation vocabulary

Every edge condition receives `(state, result)`. The `result` object has:

| Field | Type | Description |
|---|---|---|
| `status` | `"ok"` \| `"blocked"` | Whether the agent completed or escalated |
| `blockedOn` | `string` (optional) | The blocker category — only set when `status === "blocked"` |
| `reason` | `string` (optional) | What the agent hit |
| `evidence` | `string` (optional) | Error output, file:line |
| `proposedFix` | `string` (optional) | What would unblock the agent |
| `text` | `string` | Full text of the agent's reply |
| `agent` | `string` | Name of the agent that ran |
| `data` | `object` | Folded `node_state` buffer — always present, `{}` if unused |

`blockedOn` is a **closed vocabulary** — use these values to decide where a blocker routes:

| `blockedOn` value | Meaning | Typical routing target |
|---|---|---|
| `contract` | The interface/contract can't express what's needed | the architect |
| `tests` | The tests are wrong, contradictory, or missing | whoever wrote them (red) |
| `requirements` | The task is contradictory or too vague to act on | the planner |
| `information` | Needed context is missing from the codebase | a researcher or scout |
| `environment` | A tool, dependency, or environment is broken/unavailable | the human |
| `conflict` | Two requirements or constraints collide | the human |

The parser preserves any unrecognised value verbatim, so a custom category still reaches the edge
condition — but the six values above are what the auto-injected escalation protocol teaches every
agent to emit, so they are what you should route on.

Example — full routing for an implementation agent:

```js
g.edge('green', (state, result) => {
  if (result.status === 'blocked') {
    if (result.blockedOn === 'contract') return 'architect';
    if (result.blockedOn === 'tests')    return 'red';
    if (result.blockedOn === 'environment' || result.blockedOn === 'conflict') {
      return 'human';  // needs a human decision
    }
    return 'planner';  // requirements, information, or anything else
  }
  return 'reviewer';   // success — move to review
});
```

### Cycles vs. linear chains — choose deliberately

The single most common mistake is writing a **flat linear chain with unique node names**
(`planner_1`, `architect_1`, `planner_2`, …) when the task is actually iterative. That works but
throws away the only thing the graph adds over plain sequential `await` calls: **routing**.

- A **linear chain** (`g.edge('a','b'); g.edge('b','c')`) is right when the path is fully known in
  advance and no decision depends on any agent's output.
- A **cycle** is right when the path depends on what agents actually produce — an implementer gets
  blocked and must hand work back, a reviewer rejects and the task re-enters an earlier stage, a
  draft needs another revision round.

To send the *same* node through a known multi-stage loop, reuse the single node id and decide the
next hop with a visit counter stamped into state:

```js
export const meta = { name: 'revise', description: 'Revise a draft up to 3 times' };
const g = graph();
g.node('planner', agent('planner', (s) => 'Draft from: ' + (s.feedback ?? 'scratch')));
g.node('reviewer', agent('reviewer', (s) => 'Critique: ' + s.planner));
g.edge('planner', (s) => {
  s.rounds = (s.rounds ?? 0) + 1;
  return s.rounds < 3 ? 'reviewer' : END;   // revise up to 3 times
});
g.edge('reviewer', 'planner');
g.run({});
```

But note: `s.planner` holds only the *latest* draft. If a reviewer needs every draft, the
latest-wins behavior is wrong — and that is your signal to use distinct node ids instead.

### Parallel branches (fan-out and fan-in)

Give a node **more than one outgoing edge** and those branches run **concurrently**:

```js
g.edge('scout', 'researcherA');
g.edge('scout', 'researcherB');   // scout fans out; both researchers run at once
g.edge('researcherA', 'summarizer');
g.edge('researcherB', 'summarizer');  // summarizer fans in
```

There is no flag and no separate mode: every graph runs in rounds. A node whose branches are all
single edges simply has one node per round, which is an ordinary sequential walk. Fan-out is just
a property of the graph.

**Three things to know:**

1. **A fan-in node waits for *all* of its incoming edges.** `summarizer` above does not run when
   the first researcher finishes — it runs when both have. It never sees partial work. This holds
   even when the branches are different lengths and finish rounds apart.

2. **Nodes in the same round cannot see each other's results.** Work is committed to state at the
   end of a round, so `researcherA` cannot read `s.researcherB`. Only a node in a *later* round
   sees both. If a branch needs another branch's output, it belongs downstream, not beside it.

3. **Escalating from a parallel branch re-runs its siblings.** If `researcherB` routes back to an
   earlier node, everything downstream of that node starts over on the next pass, including
   `researcherA`. This keeps each pass consistent, and re-runs are cheap because an agent resumes
   its own session. Prefer escalating from a node *after* the join when you can.

**Give each branch its own node id, and don't write shared state keys from parallel edges.** Every
node's result is stored under its own id automatically (`s.researcherA`, `s.researcherB`), which is
always safe. But a custom key written from two parallel branches' edge conditions
(`s.findings = ...` in both) is last-write-wins and will silently drop one branch's data. Use
distinct keys and let a downstream node combine them.

**Progress is reported as two numbers** — for example *"6 node executions across 3 rounds"*. Rounds
measure how deep the coordination went; node executions measure how much work happened. They differ
because one round can run several nodes. `maxIterations` caps **rounds** in a parallel graph.

**What's available in a script:** the graph API (`graph`, `agent`, `human`, `END`,
`args`) plus ordinary language intrinsics (`JSON`, `Object`, `Array`, `String`, `Math`, etc. —
they resolve to the sandbox's own copies, so using them cannot reach the host). No `fs`,
`process`, `require`, `import`, `fetch`, `Date`, or `Math.random` — a graph describes routing
only, and non-determinism would mean a rerun could take a different path. Scripts are validated
before any agent spawns, so a rejected script costs nothing.

**`plan` and `contract` are also available in any graph script** — synchronous access to the
same plan/contract store that the `plan` and `contract` tools use:

| Call | Returns | Description |
|---|---|---|
| `plan.get(id)` | `{ ok, content?, message }` | Read a plan — `ok:false` if not found, never throws |
| `plan.list()` | `{ ok, plans?, message }` | List all plans (newest first) |
| `plan.create(name, content)` | `{ ok, id?, message }` | Create a new plan |
| `plan.edit(id, oldText, newText)` | `{ ok, message }` | Precision find-and-replace |
| `plan.delete(id)` | `{ ok, message }` | Delete a plan |
| `contract.get(id)` | `{ ok, content?, message }` | Read a contract — `ok:false` if not found, never throws |
| `contract.list()` | `{ ok, contracts?, message }` | List all contracts (newest first) |
| `contract.create(params)` | `{ ok, id?, message }` | Create a draft contract |
| `contract.edit(id, oldText, newText)` | `{ ok, message }` | Precision find-and-replace (draft only) |
| `contract.propose(id)` | `{ ok, message }` | Move draft → proposed |
| `contract.supersede(oldId, params)` | `{ ok, id?, message }` | Create v+1 from an existing contract |

All calls are **synchronous** (`fs.*Sync` internally) so they work in both **edge conditions**
and **prompt functions**. Bound to the project's `cwd` at script load time.

**Key rule for `get`:** `ok:false` means the file does not exist — it never throws. Use `p.ok`
as an existence check; use `p.content?.includes(...)` / `p.content?.length` for content checks.
These replace any need for separate `isExists` / `indexOf` / `length` helpers.

**Pattern 1 — Gate on contract status (loop architect until proposed):**
```js
// The architect node writes and proposes the contract as part of its work.
// The edge reads the file back and only advances when it sees 'status: proposed'.
g.edge('architect', (state, result) => {
  const c = contract.get('auth-api');
  if (!c.ok) return 'architect';                         // file doesn't exist yet
  if (c.content.includes('status: draft')) return 'architect'; // still being written
  return 'worker';                                       // proposed — proceed
});
```

**Pattern 2 — Embed the live plan into a node's prompt:**
```js
// The plan was written by a previous planner node (or by the architect tool).
// Green reads it at execution time so it always sees the latest version.
g.node('green', agent('green', (s) => {
  const p = plan.get('implementation-plan');
  const planText = p.ok ? p.content : '(no plan yet — proceed with best judgment)';
  return `Implement according to this plan:\n${planText}\n\nTests to pass:\n${s.red}`;
}));
```

**Pattern 3 — Create a plan inside a node, gate on it in the next edge:**
```js
// Planner writes the plan as part of its work (via the plan tool).
// Edge confirms the plan file exists before routing to worker.
g.edge('planner', (state, result) => {
  const p = plan.get('sprint-plan');
  return p.ok ? 'worker' : 'planner'; // loop if plan not written yet
});
```

**Pattern 4 — List all contracts in a prompt to give context:**
```js
g.node('architect', agent('architect', (s) => {
  const r = contract.list();
  const summary = r.contracts?.map(c => `- ${c.id} (${c.status})`).join('\n') ?? 'none';
  return `Existing contracts:\n${summary}\n\nNow design the new auth contract.`;
}));
```

**Pattern 5 — Search contract content for a keyword:**
```js
g.edge('architect', (state, result) => {
  const c = contract.get('auth-api');
  // Check if the contract already covers JWT — if so skip to worker
  if (c.ok && c.content.includes('JWT')) return 'worker';
  return 'architect';
});
```

### `node_state` — durable per-node memory for long-running agents

An agent that searches many files over a long run can hit auto-compaction before producing its
final output; compaction is a lossy summary and does not reliably preserve values found early.
The fix is structural: write each finding the moment it is found, to a buffer that survives
independently of the agent's context.

`node_state` is a tool (dispatch/reducer-shaped, five actions) that does exactly this. It is
**strictly workflow-only**: available to an `agent()` node inside a graph run, and **not** to a
plain `subagent` call or the main session (unlike `ask_supervisor`, which works in both).

```
node_state({ action: "set",    key: "invoice_number", value: "INV-4471", meta?: {...} })
node_state({ action: "merge",  key: "summary", value: { risk: "low" } })
node_state({ action: "append", key: "risks", value: "unclosed transaction" })
node_state({ action: "get",    key: "invoice_number" })   // returns the current value
node_state({ action: "list" })                            // returns the whole accumulator
```

**Scope: per node, never shared.** Every call is tagged with the calling node's own id. Two
parallel nodes never share a buffer — there is no write race to reason about. `get`/`list` read
back the *reduced value* of **the calling node's own buffer only** — never an action envelope,
never another node's accumulator, and never a buffer of a node that has not run yet.

> ⚠️ **Two-phase visibility — private while running, public once folded.**
>
> - **While the node is running:** its buffer is private. Only that node reads/writes it via the
>   `node_state` tool. Siblings calling `get` see their own buffer (unset for any key they never
>   wrote). `list` shows only the calling node's own keys.
> - **When the node completes:** the runner folds the buffer into `result.data`. The executor then
>   stores `state[nodeId] = result`, making the values public graph state. Every downstream node
>   and every edge reads them as `s.<nodeId>.data.<key>` — no tool call needed.
>
> **Cross-node reads always go through graph state, never through `node_state(get)`:**
>
> ```js
> // ❌ Wrong — a node calling get on another node's key
> node_state({ action: "get", key: "planner_value" })   // → unset (own buffer only)
>
> // ✅ Right — the workflow script reads the completed node's folded data
> g.node("worker", agent("worker", (s) =>
>   `Planner said: ${s.planner.data?.planner_value ?? "(none)"}`));
> ```
>
> Rule of thumb: use `node_state` to durably accumulate findings *within* a node; use
> `s.<nodeId>.data.<key>` in the workflow script to hand those findings to the next node.

**Downstream access is plain JS, hardcoded in the script.** When a node finishes, its
accumulated buffer is folded into that node's result as `data`, so a later node reads it the
same way it reads any result field — no tool call needed:

```js
g.node('assemble', agent('assembler', (s) =>
  `Shard A: ${s.extract_a.data.invoice_number}\n` +
  `Shard B: ${s.extract_b.data.invoice_number}`));

g.edge('extract_a', (state, result) => {
  const found = Object.keys(result.data).length;
  return found < 90 ? 'extract_a' : 'assemble';   // mechanical gate on folded data
});
```

**Cycles driven by folded state.** The same read path drives loops: the executor writes
`state[nodeId]` *before* routing, so a conditional edge sees the just-completed visit's folded
`data` and can decide to revisit the same node. The planner writes a pass counter into its own
buffer with `node_state`; the edge reads it back and either cycles or proceeds:

```js
const g = graph();

g.node('plan', agent('planner', (s) =>
  `Planning pass ${(s.plan.data?.passes ?? 0) + 1} of max 2. ...planning instructions...\n` +
  `When you finish this pass, call exactly:\n` +
  `node_state({ action: "set", key: "passes", value: ${(s.plan.data?.passes ?? 0) + 1} })`));

g.edge('plan', (state) =>
  (state.plan.data?.passes ?? 0) < 2 ? 'plan' : 'worker');   // cycle until 2 passes are done

g.edge('worker', END);
```

> ⚠️ **A constant flag loops forever.** Because the edge re-reads the current visit's folded
> data, a node that writes the same value every visit (e.g. `visited = 1` unconditionally)
> never changes the edge's answer — the loop never exits. Make the value change between visits
> (a counter, as above) or have the node stop writing it on the final visit. `maxIterations`
> caps rounds as a safety net, but the cycle must be able to terminate on its own.

A node's `data` follows the same lifecycle as its `text`: revisiting a node overwrites its
entry, and resume never reconstructs a crashed node's in-flight writes — a node's state is
whatever its most recent complete visit produced.

**Cross-node conflicts are author-gated, never auto-resolved.** The reducer only guarantees no
collision *within* one node's buffer; it has no visibility across nodes. If two parallel shards
disagree on the same key, the workflow author writes the comparison explicitly — an edge
condition or a dedicated gate node comparing `state.<nodeId>.data` across nodes — and routes to
a resolution node. Never silently pick one value.

## Saving and Reusing Workflows

Scripts are not persisted automatically — pass `saveWorkflow: true` to save a script for later reuse (it is filed under the graph's `meta.name`), and `loadWorkflow` to re-run one without rewriting it:

```
workflow(script="...", saveWorkflow=true)                      # persists to .pi-workflow/workflows/<meta.name>.js
workflow(loadWorkflow="audit", args={ repo: "..." })               # re-runs the saved script; `script` not needed
```

Before writing a new workflow script from scratch, check whether a matching one was already saved (e.g. via `/saved-workflows` or by trying `loadWorkflow` first) — especially if the user asks to "run that workflow again" or describes a repeatable process. If `loadWorkflow` references an unknown name, the tool error lists the names that do exist. Use `saveWorkflow: true` when the user explicitly asks to save a workflow, or when the task is clearly a repeatable process worth reusing later; don't save one-off exploratory workflows by default.

The user can also save a workflow after the fact from the `/workflows` TUI navigator by selecting a run and pressing `s` — no need to have passed `saveWorkflow: true` up front. This only works for runs still live in the current session (the script is kept in memory, not journaled); it won't work for runs restored from a prior session's journal.

## Session Execution Modes (`/wf`)

You can switch the execution mode of the session using the `/wf` command to enforce specific tool and behavioral restrictions on the agent. The active mode is displayed in the status widget below the editor.

* **`/wf normal`** (or `/wf build`): The default mode. All tools are enabled, and the agent can write files directly or delegate.
* **`/wf plan`**: Read-only mode. Blocks all write tools (`write`, `edit`) and delegation tools (`subagent`, `workflow`). Restricts `bash` to read-only commands (e.g. `cat`, `grep`, `ls`, `git diff`). Use this for safe, modification-free planning and codebase research.
* **`/wf workflow`**: Enforced delegation mode. Blocks direct writes (`write`, `edit`) and direct subagents (`subagent`). Forces the agent to write a graph script and execute it via the `workflow` tool for any file changes or task delegation. `read`, read-only `bash`, `grep`, `find`, `ls`, `workflow`, `workflow_status`, `workflow_stop`, `list_agents`, and `list_workflows` remain available.

Use the `list_workflows` tool to discover available pre-built and saved workflows (such as "tdd" and "review_loop") that you can run instantly via the `loadWorkflow` parameter. Use the `list_agents` tool to discover available subagents and their roles.

If you are the agent and a restricted mode is active (you'll see it in the injected system-prompt directive, or a blocked-tool error message), do not try to work around it — respect the boundaries of the mode (e.g., plan/research only in plan mode, or write a workflow script in workflow mode).

## Creating Agents

Create agent files in `~/.pi/agent/agents/*.md` (user scope) or `.pi/agents/*.md` (project scope).

**CRITICAL REQUIREMENT:** Every agent file *must* include `name` and `description` in the YAML frontmatter block, otherwise the agent will be silently ignored!

```markdown
---
name: scout
description: Lightweight exploration agent that finds security issues and code smells.
model: google/gemini-2.5-flash
tools: read, grep, bash
turnBudget: {"maxTurns": 5, "graceTurns": 1}
acceptance:
  level: none
---

# Scout Agent

Find security issues and code smells. Keep responses concise.
```

### Agents that work in a workflow graph

A custom agent does not need to know anything about routing, edges, or which other agents exist —
it only needs to do its own job. **But if it can hit a wall, it must say so using the escalation
protocol, or the graph will route it forward as if it succeeded.** This is the single most
important thing to get right when authoring an agent for a workflow.

When an agent cannot complete its task, teach it to emit this exact block (the parser is
line-anchored on `STATUS:` and `BLOCKED_ON:`):

```text
## Escalation

If you can't complete the task, say so instead of faking it:

STATUS: blocked
BLOCKED_ON: requirements | environment | conflict | contract | tests | information
REASON: <specifically what you hit>
EVIDENCE: <error output, file:line>
PROPOSED_FIX: <what would unblock you>
```

Copy that `## Escalation` section verbatim into the agent's markdown body. `BLOCKED_ON` is a
**closed vocabulary** — it is a routing key the edge branches on, not prose.
Reuse the existing categories (`requirements`, `environment`, `conflict`, `contract`, `tests`,
`information`) when one fits; the parser preserves any other value verbatim so the edge can still
see it, but a recognized category is what an edge author will have written a route for.

Two rules that make an agent safe in a graph:
1. **Escalating is a successful outcome.** State plainly that reporting a blocker is good — it is
   *cheaper than faking*. "Faking a pass is the only real failure."
2. **Forbid the shortcut failure modes by name** for any agent that writes code: do not mock or
   stub the thing under implementation, do not weaken or delete tests, do not hardcode to test
   inputs, do not claim done while the suite is red.

**You do not have to include the block for routing to work.** The protocol is **auto-injected**
into every workflow agent's system prompt at spawn time — a custom agent whose `.md` omits it
still receives it and can report a blocker. Including it in the `.md` yourself is still good
practice (it reinforces the instruction and documents intent), and it is idempotent: if the block
is already present the injection is skipped, so there is never a duplicate. Only a *technical*
crash (OOM, provider error) is not covered by this — but those already abort the graph as a
safety net.

## Agent Frontmatter Attributes

| Attribute | Description |
|-----------|-------------|
| `name` | **Required.** Name of the agent (used to spawn it) |
| `description` | **Required.** Short description of what the agent does |
| `model` | Model to use (e.g., google/gemini-2.5-pro) |
| `tools` | Tool allowlist (comma-separated or YAML list) |
| `turnBudget` | `{"maxTurns": N, "graceTurns": N}` — soft-blocks tools at `maxTurns`, hard-kills at `maxTurns + graceTurns`. Default (when omitted): `{"maxTurns": 50, "graceTurns": 2}`; project settings can change or disable this default (see "Project-wide settings" below) |
| `toolBudget` | `{"hard": N, "soft": N, "block": [...] \| "*"}` — caps tool calls, not turns |
| `timeoutMs` | Hard wall-clock timeout for the whole subagent run, in milliseconds |
| `acceptance.level` | none, checked, or auto |
| `acceptance.evidence` | Required evidence kinds |
| `defaultContext` | `fresh` or `fork` (global default: `fork`) — see Context section below |

### Project-wide settings (`.pi-workflow/settings.json`)

Independent of any individual agent's frontmatter, a few extension-wide safety behaviors can be
tuned or disabled by placing a settings file at `.pi-workflow/settings.json` (project scope) or
`pi-workflow-settings.json` in the agent directory (user scope, project wins). Read once at
process start, for the main agent and every subagent — commit the file to git if worktree-isolated
subagent runs need to see it too.

```json
{
  "blankStopGuard": false,
  "bashTimeoutGuard": false,
  "bashTimeoutSeconds": 900,
  "defaultTurnBudget": { "maxTurns": 30, "graceTurns": 3 }
}
```

| Key | Default | Effect |
|-----|---------|--------|
| `blankStopGuard` | `true` | Auto-"continue" nudge when a model returns a genuinely empty or thinking-only completion. Set `false` to disable. |
| `bashTimeoutGuard` | `true` | Injects a default `timeout` into `bash` calls that don't set one. Set `false` to disable. Never touches `ask_user_question`/`ask_supervisor` — those stay unbounded regardless of this setting. |
| `bashTimeoutSeconds` | `600` (10 min) | The default injected by `bashTimeoutGuard`. A model-specified `timeout` on an individual `bash` call always wins over this. |
| `defaultTurnBudget` | `{"maxTurns": 50, "graceTurns": 2}` | Applied to any subagent run (graph node or plain `subagent` call) whose agent frontmatter declares no `turnBudget`. An agent's own frontmatter `turnBudget` always wins over this. Set to `null` to disable the default entirely (agents with no frontmatter `turnBudget` then run unbounded). |

## Context: Fresh vs Fork

Every subagent runs with one of two context modes, resolved as: explicit `context` option (subagent tool only) → agent's `defaultContext` frontmatter → `fork`.

- **`fork`** (default): the child's system prompt is prepended with a compaction-style structured summary (Goal / Progress / Key Decisions / Next Steps) of the parent session — not the raw transcript. This keeps cost bounded regardless of how long the parent conversation has run. A note referencing the parent's raw session file is included as an escape hatch, in case the child needs an exact detail not captured in the summary.
- **`fresh`**: the child starts with zero inherited history — only its system prompt + the task you give it. Use this for agents that should run in full isolation with no awareness of the current conversation.

In the `subagent` tool, override per-call:

```
subagent(tasks=[{"agent": "worker", "task": "run an isolated audit", "context": "fresh"}], mode="single")
```

In a `workflow` graph there is no inline per-node override — set `defaultContext: fresh` in that agent's frontmatter so every spawn of it runs isolated:

```markdown
---
name: auditor
defaultContext: fresh
---
```

If fork context can't be produced (no active session, or summarization fails), the subagent silently runs fresh instead — it never blocks or throws.

## Error Handling: Agent-Level vs Technical Failures

Two kinds of subagent failure are handled differently:

- **Agent-level** (the agent ran, but its own work has errors — failing tests, a tool error, rejected acceptance): The graph node still emits a result, but `status === 'error'` or `status === 'blocked'`. The workflow keeps running and follows whatever edge you wrote for that condition.
- **Technical** (LLM provider errors, rate limits, quota exhaustion, process crashes/OOM kills, protocol output limits): the whole workflow run is **automatically aborted**. The `workflow` tool call fails with a message naming the failing agent, the failure reason, and the `runId` to investigate further.

Command nodes follow the same split: a nonzero exit code is agent-level (`status: 'blocked'`, routable — the command ran, it just failed, same as a test suite reporting real failures). A command that could not even start (missing binary's shell dependency, bad `cwd`) or that timed out is technical (aborts the run), unless `allowFailure: true` was set on that node, which downgrades both to routable.

If you see a workflow tool call fail with "hit a technical failure", **do not** assume the workflow script is broken — it's usually transient infrastructure (rate limit, provider outage, OOM). Use `workflow_status` to inspect before retrying or editing the script.

### Investigating a failed run: `workflow_status`

```
workflow_status({ runId: "wf-1234567890" })
```
Summarizes every agent's status/error/result preview in the run.

```
workflow_status({ runId: "wf-1234567890", agentId: 2 })
```
Returns one agent's full prompt, complete (untruncated) result, and tool-call/output history — use this to see exactly what a failing (or any) agent did before it failed, without needing the interactive `/workflows` TUI.

### Stopping a run: `workflow_stop`

```
workflow_stop({ runId: "wf-1234567890" })
```
Cancels a running workflow — the same action as pressing `x` in the `/workflows` TUI, but callable directly. In-flight nodes are aborted; results already recorded stay in the run journal, so the run can still be resumed later with `resumeRunId`. Call with no arguments to list every workflow currently running:

```
workflow_stop()
```

Only runs tracked live in this process can actually be stopped — a run visible solely as a persisted journal entry (started by a different session/process) is reported as not stoppable from here.

## Common Patterns

The best way to understand workflows is by example. Here are five core architectural patterns you can reach for.

### 1. Linear Pipeline (Plan → Implement → Review)
The simplest workflow: a fixed sequence where each step builds on the last.

```js
export const meta = { name: 'simple_task', description: 'Plan, implement, review' };
const g = graph();
g.node('planner',  agent('planner',  (s) => `Plan this: ${args.task}`));
g.node('worker',   agent('worker',   (s) => `Implement this plan:\n${s.planner}`));
g.node('reviewer', agent('reviewer', (s) => `Review what worker did:\n${s.worker}`));

g.edge('planner', 'worker');
g.edge('worker', 'reviewer');
g.edge('reviewer', END);
g.run({ task: args.task });
```

### 2. TDD Cycle with Escalation Routing
The classic escalation pattern. If `green` hits a wall, the edge reads the `blockedOn` category to decide who owns the problem.

```js
export const meta = { name: 'tdd_cycle', description: 'TDD red-green with escalation routing' };
const g = graph();
g.node('architect', agent('architect', (s) => `Design the contract for: ${args.task}`));
g.node('red',       agent('red',       (s) => `Write failing tests for this contract:\n${s.architect}`));
g.node('green',     agent('green',     (s) => `Make these tests pass:\n${s.red}\nContract:\n${s.architect}`));
g.node('reviewer',  agent('reviewer',  (s) => `Review implementation:\n${s.green}`));
g.node('ask',       human('Green is blocked. What should we do?', { default: 'retry' }));

g.edge('architect', 'red');
g.edge('red', 'green');
g.edge('green', (state, result) => {
  if (result.status === 'blocked') {
    if (result.blockedOn === 'contract') return 'architect';
    if (result.blockedOn === 'tests')    return 'red';
    return 'ask'; // environment, conflict, etc.
  }
  return 'reviewer'; // success
});
g.edge('ask', 'green');
g.edge('reviewer', (state, result) => {
  if (result.status === 'blocked') return 'green';
  return END;
});
g.run({});
```

### 3. Iterative Refinement (Cycle with Visit Counter)
A loop that stops after a fixed number of attempts by storing a counter in the shared `state` object.

```js
export const meta = { name: 'refine_draft', description: 'Iterative refinement with a cap' };
const g = graph();
g.node('writer',   agent('worker',   (s) => s.feedback
  ? `Revise based on this feedback:\n${s.feedback}\n\nPrevious draft:\n${s.writer}`
  : `Write a first draft: ${args.task}`));
g.node('reviewer', agent('reviewer', (s) => `Critique this draft:\n${s.writer}`));

g.edge('writer', 'reviewer');
g.edge('reviewer', (state, result) => {
  state.rounds = (state.rounds ?? 0) + 1;
  // Stop if Reviewer escalates (can't review) or we hit the cap
  if (result.status === 'blocked' || state.rounds >= 3) return END;
  state.feedback = result.text; // Store feedback for writer to read
  return 'writer';
});
g.run({});
```

### 4. Interactive Research (Human mid-workflow)
Uses `human` so the user gets to read the research and decide the implementation approach before spawning the worker.

```js
export const meta = { name: 'investigate_fix', description: 'Research then decide approach' };
const g = graph();
g.node('scout',      agent('scout',      (s) => `Find all files related to: ${args.task}`));
g.node('researcher', agent('researcher', (s) => `Analyze this area of code:\n${s.scout}\nQuestion: ${args.task}`));
// The #{nodeId} syntax is required for human prompts
g.node('decide',     human(`Based on the research, should we refactor or patch?\n\nResearch:\n#{researcher}`, { options: ['refactor', 'patch'], default: 'patch' }));
g.node('worker',     agent('worker',     (s) => `${s.decide}\n\nContext:\n${s.researcher}`));

g.edge('scout', 'researcher');
g.edge('researcher', 'decide');
g.edge('decide', 'worker');
g.edge('worker', END);
g.run({});
```

### 5. Human Approval Gate
Pauses the workflow to ask the human user for a decision using `human()`.

```js
export const meta = { name: 'guarded_deploy', description: 'Implement with human approval gate' };
const g = graph();
g.node('worker',   agent('worker',   (s) => `Implement: ${args.task}`));
g.node('reviewer', agent('reviewer', (s) => `Review:\n${s.worker}`));
g.node('approve',  human('Reviewer says:\n#{reviewer}\n\nApprove for merge?', {
  options: ['yes', 'no', 'revise'],
  default: 'yes'
}));
g.node('revise',   agent('worker',   (s) => `Address review feedback:\n${s.reviewer}`));

g.edge('worker', 'reviewer');
g.edge('reviewer', 'approve');
g.edge('approve', (state, result) => {
  if (result.text === 'no') return END;
  if (result.text === 'revise') return 'revise';
  return END; // default 'yes'
});
g.edge('revise', 'reviewer');
g.run({});
```

### 6. Parallel Fan-Out (independent branches, then a join)
Use when several pieces of work are genuinely independent and a later step needs all of them.
The two researchers run concurrently; `summarizer` waits for both.

```js
export const meta = { name: 'parallel_audit', description: 'Audit two areas at once, then combine' };
const g = graph();
g.node('scout',    agent('scout',      (s) => `Map the codebase for: ${args.task}`));
g.node('security', agent('researcher', (s) => `Audit SECURITY only:\n${s.scout}`));
g.node('perf',     agent('researcher', (s) => `Audit PERFORMANCE only:\n${s.scout}`));
// Runs only after BOTH branches finish, and sees both results.
g.node('summarizer', agent('worker', (s) =>
  `Combine these two audits into one plan:\n\nSECURITY:\n${s.security}\n\nPERFORMANCE:\n${s.perf}`));

g.edge('scout', 'security');
g.edge('scout', 'perf');        // fan-out: both run in the same round
g.edge('security', 'summarizer');
g.edge('perf', 'summarizer');   // fan-in: waits for both
g.edge('summarizer', END);
g.run({});
```

Each branch keeps its own key (`s.security`, `s.perf`), so nothing is overwritten. Splitting one
agent's job across branches only pays off when the branches genuinely do not need each other's
output — if one depends on the other, chain them instead.

### 7. Long-Running Extraction with `node_state` (compaction-safe)

When a node searches many files and may hit auto-compaction, write each finding immediately rather
than accumulating in the reply. The folded `data` is then available to downstream nodes via graph
state. The cycle variant drives the loop from the counter in `data`.

```js
export const meta = { name: 'extract_invoices', description: 'Extract invoice data from documents' };
const g = graph();

// Extractor: writes findings into its own node_state buffer as it goes
g.node('extractor', agent('researcher', (s) =>
  `Search every file under docs/ for invoice fields.\n` +
  `For each invoice you find, call node_state IMMEDIATELY (do not wait until the end):\n` +
  `  node_state({ action: "set",    key: "invoice_number", value: "<value>" })\n` +
  `  node_state({ action: "set",    key: "vendor",         value: "<value>" })\n` +
  `  node_state({ action: "append", key: "line_items",     value: "<item>" })\n` +
  `When done, reply with a one-line summary.`));

// Assembler: reads the extractor's folded data from graph state — no tool call needed
g.node('assembler', agent('worker', (s) =>
  `Produce a final invoice report from these extracted fields:\n` +
  `Invoice #: ${s.extractor.data?.invoice_number ?? 'unknown'}\n` +
  `Vendor:    ${s.extractor.data?.vendor         ?? 'unknown'}\n` +
  `Line items: ${JSON.stringify(s.extractor.data?.line_items ?? [])}\n` +
  `Verify completeness and format as Markdown.`));

g.edge('extractor', 'assembler');
g.edge('assembler', END);
g.run({});
```

**Cycle variant — driven by a pass counter in `node_state`** (conceptual — requires real agents calling node_state):

```text
export const meta = { name: 'iterative_plan', description: 'Plan with up to 3 revision passes' };
const g = graph();

g.node('plan', agent('planner', (s) => {
  const pass = (s.plan.data?.passes ?? 0) + 1;
  return (
    `This is planning pass ${pass} of max 3.\n` +
    (s.plan.data?.passes ? `Previous pass summary:\n${s.plan}\n\n` : '') +
    `Task: ${args.task}\n\n` +
    `When you finish this pass, call EXACTLY:\n` +
    `node_state({ action: "set", key: "passes", value: ${pass} })`
  );
}));

// Edge reads the completed visit's folded data to decide whether to cycle
g.edge('plan', (state) =>
  (state.plan.data?.passes ?? 0) < 3 ? 'plan' : 'worker');

g.node('worker', agent('worker', (s) =>
  `Implement this plan (${s.plan.data?.passes} passes completed):\n${s.plan}`));
g.edge('worker', END);
g.run({ task: args.task });
```

> ⚠️ A constant flag (e.g. `passes = 1` written every pass) loops forever. The counter must
> increment each visit so the edge's condition eventually becomes false.

### Delegate to a specialized agent
```
subagent(tasks=[{"agent": "worker", "task": "Implement user authentication with JWT tokens"}], mode="single")
```

### Run multiple agents in parallel
```
subagent(tasks=[{"agent": "scout", "task": "Review auth"}, {"agent": "scout", "task": "Review API"}, {"agent": "scout", "task": "Review payments"}], mode="parallel")
```

### Running Without a TUI (Headless / IDE Mode)

When `pi-permission-system` is installed and no interactive terminal is available, it cannot
prompt the user — so any tool gated as `ask` is blocked. The correct fix is to create a
permission config file that pre-approves the tools your workflows need:

**Global (applies to all projects):** `~/.pi/agent/extensions/pi-permission-system/config.json`
**Project (applies to this directory):** `.pi/extensions/pi-permission-system/config.json`

```json
{
  "permission": {
    "workflow": "allow",
    "subagent": "allow",
    "node_state": "allow",
    "ask_supervisor": "allow",
    "ask_user_question": "allow"
  }
}
```

In a full TUI session these tools show a forwarded permission prompt the first time — approve with
`s` ("for this session") to skip subsequent prompts for the rest of the session.
