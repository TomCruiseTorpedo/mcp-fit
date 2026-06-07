# Task Corpus — mcp-fit fixtures

Synthetic task corpus for evaluating the strawman MCP server. All tasks run against `fixtures/strawman-server`.

## Signal classification

| `lowSignal` | `multiStep` | Role |
|-------------|-------------|------|
| `true`      | `false`     | Trivial single-call — runs but does not dominate the aggregate score |
| `false`     | `true`      | Multi-step inter-tool — carries eval weight; exercises tool-selection and provenance |

Per spec (selectivity requirement): single-call tasks are flagged `lowSignal: true` and excluded from the weighted aggregate. The weighted eval score is driven by multi-step tasks.

## Task inventory

### Low-signal (single-call)

| taskId | Tool | What it tests |
|--------|------|----------------|
| `single-get-001` | `get` | Basic retrieval — trivial |
| `single-remove-001` | `remove` | Basic deletion — trivial |
| `single-search-001` | `search` | Basic search — trivial |

### Multi-step (eval-weighted)

| taskId | Tools | What it tests |
|--------|-------|----------------|
| `multi-create-verify-001` | `process` → `get` | Provenance: ID from creation used in retrieval |
| `multi-search-update-001` | `search` → `change` | Provenance: ID from search result used in update |
| `multi-create-search-delete-001` | `process` → `search` → `remove` | 3-step chain; provenance across two hops |
| `multi-search-find-compare-001` | `search` + `find` | Tool-selection-confusion: agent must call both overlapping tools |

## Provenance instrumentation

Multi-step tasks are specifically designed so tool arguments in later steps **must** trace to the output of a prior step — not be fabricated. The eval runner (B-005) records a `provenance:fabricated` event when a tool argument cannot be traced to a prior tool return or a task literal.

## Schema

Each task object in `tasks.json`:

```ts
{
  taskId: string;             // Unique identifier
  description: string;        // Natural-language instruction for the eval agent
  multiStep: boolean;         // True if the task requires > 1 tool call
  lowSignal: boolean;         // True if trivial single-call (excluded from weighted score)
  expectedTools: string[];    // Tools expected to be invoked (in order for multi-step)
  steps?: {                   // Per-step breakdown (multi-step only)
    stepId: string;
    description: string;
    expectedTool: string;
  }[];
  verificationCriteria: string; // Human-readable pass/fail description for the rubric
}
```
