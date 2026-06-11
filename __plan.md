# Forest tree snapshot / refresh architecture refactor plan

## Goal

Simplify Forest’s tree-state architecture so that:

1. **UI rendering uses one shared source of truth** for per-tree derived data.
2. **Delete / ship / review / open-PR flows stop re-fetching remote state just to render UI.**
3. **Remote data is refreshed predictably in the background** instead of opportunistically and redundantly.
4. **Commands revalidate only at submit/commit time**, where correctness matters.
5. The current delete-form latency is solved as a **side effect** of a cleaner model.

---

## Executive summary

Today the codebase mixes two competing models:

### Model A: snapshot-driven UI
`src/views/treeData.ts` computes `TreeCardData` for the sidebar and caches it for 30 seconds.

### Model B: command-local truth
Many commands and forms independently ask git / GitHub / Linear again for data they need.

That creates:
- duplicated network calls
- duplicated git calls
- cache invalidation problems
- stale/fresh ambiguity
- side effects that write derived data back into state
- UI latency, especially before forms appear

## Core proposal

Introduce a stronger **tree snapshot architecture**:

- A service owns **all derived per-tree data**.
- The webview and other UI surfaces consume snapshots only.
- Commands use snapshots to render immediately.
- Commands revalidate critical facts only when the user submits an action.
- Refreshing becomes periodic + targeted, not “clear all and re-fetch”.

This can start as an evolution of `TreeDataService`, or be renamed to `TreeSnapshotService` if we want the name to reflect broader responsibility.

---

# Part 1: current architecture and problems

## 1.1 Current main pieces

### Persistent state
`src/state.ts`
- stores durable tree metadata: branch, path, ticket, createdAt, flags like `cleaning`, `busyOperation`, `prUrl`, `mergeNotified`
- state is shared across windows

### Derived sidebar data
`src/views/treeData.ts`
- computes `TreeCardData`
- fetches:
  - `gh.prStatus(tree.path)`
  - `git.commitsBehindRemote(tree.path, baseBranch)`
  - `git.commitsAhead(tree.path, branch)`
  - `git.commitsBehindRemote(tree.path, branch)`
  - `git.localChanges(tree.path)`
- caches results per tree for 30s

### Webview provider
`src/views/ForestWebviewProvider.ts`
- calls `this.data.build()`
- posts rendered data to the webview
- but also has direct fetch paths for some forms/actions

### Background polling
`src/extension.ts`
- 3-minute `forestProvider.refresh()`
- 5-minute merged-PR cleanup polling via separate GitHub queries
- 60-second orphan polling

### Commands
`src/commands/*`
- several commands ask for remote state again, even when the sidebar just fetched it

---

## 1.2 Concrete duplicated-fetch problems

### A. Delete form duplicates sidebar data fetch
`src/views/ForestWebviewProvider.ts:showDeleteForm()`
- loads state
- checks busy state
- calls `gh.prStatus(tree.path)`
- calls `git.remoteBranchExists(repoPath, branch)`
- only then posts the form

But the sidebar already had:
- `prState`
- `prNumber`
- `hasTrackingRef` (effectively “remote branch exists?”)

This is the user-visible 5-second lag.

### B. `refresh()` defeats the cache
`src/views/ForestWebviewProvider.ts`

```ts
refresh(): void {
  this.data.clear();
  this.update();
}
```

This clears the whole tree-data cache before every refresh.

Refreshes happen on:
- window focus
- state changes from other windows
- health refresh interval
- manual refresh
- some async completions

So the service has a TTL cache, but many callers bypass its value by clearing it eagerly.

### C. Separate PR polling systems
Two different systems ask GitHub for PR state:

1. sidebar snapshots via `gh.prStatus`
2. merged cleanup polling via `gh.prIsMerged`

That means multiple sources of truth for PR state.

### D. PR URL ownership is split
PR URL may come from:
- `TreeDataService.fetch()` via `gh.prStatus`, then written into state as a side effect
- `shipCore()` after PR creation
- persisted `tree.prUrl` in state
- UI reads from state, not necessarily from latest remote snapshot

This is sync-by-side-effect, not a clean ownership model.

### E. Duplicate state loads inside one interaction
Common pattern:
- caller loads state and resolves tree
- helper reloads state again (`ensureTreeIdle` -> `getBlockingTreeOperation`)

Not the biggest latency issue, but a sign that “latest tree snapshot” is not a first-class concept.

### F. “working changes” and “change summary” are split
The snapshot already contains `localChanges`, but many UI-time flows independently call:
- `git.localChanges(repoPath)`
- `git.hasUncommittedChanges(tree.path)`

Some of those rechecks are correct at submit time.
Some are just redundant when opening UI.

---

## 1.3 Root cause

The root cause is not one slow function.

The root cause is that Forest lacks a single, explicit contract for:

> “What is the current derived state of a tree, who owns it, how fresh is it, and who is allowed to fetch it?”

Right now:
- `state.ts` owns durable metadata
- `TreeDataService` owns some derived data
- commands often bypass `TreeDataService`
- refresh invalidation is broad and destructive
- some derived data is persisted back into state opportunistically

---

# Part 2: target architecture

## 2.1 Design principles

1. **One source of truth for derived tree state**
   - UI should render from shared snapshots, not ad hoc queries.

2. **Commands render fast, validate late**
   - Use snapshot data to open forms instantly.
   - Revalidate at submit time for correctness.

3. **Last-known-good data is valuable**
   - Do not clear useful cached data before replacement is ready.

4. **Targeted invalidation beats global clearing**
   - If one tree changed, mark one tree stale.
   - If one remote property changed, refresh that property or that tree.

5. **Background refresh should be owned by the data service**
   - Not scattered across extension/provider layers.

6. **Persistent state should store durable intent, not temporary remote truth**
   - Persist only what must survive reloads/windows.
   - Prefer snapshots for remote/transient state.

---

## 2.2 Proposed main service: `TreeSnapshotService`

This can be:
- a rename + refactor of `TreeDataService`, or
- a new service with `TreeDataService` removed later

### Responsibilities

- Maintain per-tree derived snapshots.
- Refresh snapshots periodically.
- Refresh snapshots on demand.
- Expose last-known-good snapshot immediately.
- Expose freshness / loading / error metadata.
- Notify subscribers when snapshots change.
- Avoid duplicate in-flight fetches.

### Non-responsibilities

- Do not own durable state mutations like add/remove tree.
- Do not directly own UI rendering.
- Do not present notifications.

---

## 2.3 Proposed data model

### Durable state stays in `TreeState`
Examples:
- branch
- path
- ticketId
- title
- createdAt
- `cleaning`
- `busyOperation`
- `useDevcontainer`
- maybe `prUrl` if we decide it is worth persisting

### Derived snapshot lives in service

Suggested shape:

```ts
export interface TreeSnapshot {
  key: string;
  repoPath: string;
  branch: string;

  // snapshot metadata
  fetchedAt?: number;
  loading: boolean;
  stale: boolean;
  error?: string;

  // durable tree-facing fields copied through for convenience
  ticketId?: string;
  ticketTitle?: string;
  isCurrent: boolean;
  cleaning: boolean;
  busyOperation?: string;

  // remote/git-derived data
  pr?: {
    state: "OPEN" | "MERGED" | "CLOSED" | null;
    number?: number;
    url?: string;
    reviewDecision?: string | null;
  };

  tracking?: {
    hasRemote: boolean;
    hasTrackingRef: boolean;
  };

  counts?: {
    behindBase: number;
    aheadOfRemote: number;
    behindRemote: number;
  };

  working?: {
    hasUncommittedChanges: boolean;
    localChanges: { added: number; removed: number; modified: number } | null;
  };
}
```

### Notes

- `hasRemote` and `hasTrackingRef` may overlap; decide whether both are needed.
- Ideally remove separate `remoteBranchExists()` form-time calls by deriving UI behavior from one remote-tracking model.
- `loading`, `stale`, `error`, `fetchedAt` make freshness explicit.

---

# Part 3: refresh model

## 3.1 Current refresh model problems

Current behavior:
- `refresh()` clears cache
- `update()` rebuilds data
- periodic refresh is driven from `extension.ts`
- state changes trigger full refreshes

Problems:
- cached data is discarded before replacement exists
- UI sees unnecessary loading or latency
- too many layers know about refresh policy
- the service is passive, not authoritative

---

## 3.2 Proposed refresh model

`TreeSnapshotService` should own refresh cadence and invalidation.

### Service API sketch

```ts
class TreeSnapshotService implements vscode.Disposable {
  getSnapshot(key: string): TreeSnapshot | undefined;
  getSnapshotsForRepo(repoPath: string): TreeSnapshot[];

  ensureWarm(repoPath: string): Promise<void>;
  refreshRepo(repoPath: string, opts?: { force?: boolean }): Promise<void>;
  refreshTree(repoPath: string, branch: string, opts?: { force?: boolean }): Promise<void>;

  markTreeStale(repoPath: string, branch: string): void;
  markRepoStale(repoPath: string): void;

  onDidChangeSnapshots: vscode.Event<{ repoPath: string; keys?: string[] }>;
}
```

### Behavioral rules

1. `getSnapshot()` returns immediately with last-known-good data if present.
2. `refreshTree()` and `refreshRepo()` update in background.
3. Existing snapshot is preserved while refresh is in flight.
4. If fetch fails, keep old data and attach `error` + `stale`.
5. Never blank out UI data just because refresh started.

---

## 3.3 Periodic refresh cadence

Suggested default:
- **60s repo refresh** for active workspace snapshots

Why 60s:
- fresher than current 3-minute health refresh
- much cheaper than 30s if many trees exist
- good enough for PR state / ahead-behind / change summaries

Possible future tuning:
- 30s when webview visible
- 60s when window focused but webview hidden
- paused or 3–5 min when window unfocused

For now, keep it simple:
- 60s while extension/window is active

---

## 3.4 Explicit invalidation triggers

### Refresh one tree after:
- ship success
- merge from main
- pull
- push
- commit
- discard
- delete completion/removal
- link/detach ticket only if snapshot includes ticket convenience fields

### Refresh whole repo after:
- tree add/remove
- state reconciliation / orphan prune
- initial activation
- explicit manual refresh

### No longer do:
- unconditional `clear()` before every refresh

---

# Part 4: which callers should use snapshots

## 4.1 Sidebar

Current:
- already uses `TreeDataService`

Target:
- keep sidebar purely snapshot-driven
- webview receives `WebviewData` built from snapshots
- no per-render direct git/GitHub calls outside snapshot service

---

## 4.2 Delete form

### Current problem
`showDeleteForm()` does blocking remote fetches.

### Target
Delete form init should come from the snapshot already shown in the sidebar.

Inputs needed:
- tree identity and display name
- ticket info
- PR state / PR number
- whether remote exists / tracking exists
- linear enabled and status names

### Flow
1. User clicks delete on tree card.
2. Webview already has tree snapshot.
3. Webview sends delete-form init payload or enough data to derive it.
4. Provider posts form immediately.
5. On submit, extension revalidates:
   - tree still exists
   - tree still idle
   - uncommitted changes warning
   - then execute delete plan

### Important
The correctness boundary is **submit time**, not **form-open time**.

---

## 4.3 PR review / ship form

Today the PR review form does not block on `gh.prStatus`, but ship logic still has split ownership of PR existence / URL.

### Target
- UI for review/ship should derive visible PR state from snapshot.
- `shipCore()` remains authoritative for actual push/create behavior.
- After ship succeeds, refresh that tree snapshot.

### Note
`shipCore()` may still query GitHub when necessary to avoid duplicate PR creation. That is fine because this is commit-time logic, not render-time logic.

---

## 4.4 Open PR action

Today `openPR` reads `tree.prUrl` from persisted state.

### Options

#### Option A: keep `prUrl` persisted
Pros:
- works before snapshot loads
- survives restart

Cons:
- split ownership remains

#### Option B: stop persisting `prUrl`
Pros:
- cleaner ownership

Cons:
- opening PR depends on latest snapshot availability

#### Recommended near-term compromise
Keep `prUrl` persisted for convenience, but define ownership clearly:
- snapshot is the source of truth for UI
- persisted `prUrl` is a convenience cache only
- do not build core logic around whether `tree.prUrl` happens to exist

Long-term, we can revisit removing it.

---

## 4.5 Create form

Current `getCreateFormInit()` calls `git.localChanges(repoPath)` directly.

This is not as bad as delete, because main repo data is not currently part of tree snapshots.

### Recommendation
Leave create form alone initially.

Possible future improvement:
- add a `RepoSnapshotService` for main repo state
- then create form can use repo snapshot too

But that is a separate concern from tree snapshots.

---

## 4.6 Working diff / change warnings

Some commands need a fast yes/no for “are there uncommitted changes?”.

### Rule of thumb
- For **displaying buttons, hints, form defaults**: snapshot is enough.
- For **destructive or commit actions**: recheck with git at submit/execute time.

Examples:
- delete form open -> use snapshot
- delete submit -> recheck `git.hasUncommittedChanges`
- ship form open -> use snapshot if shown
- ship submit -> recheck `git.hasUncommittedChanges`

---

# Part 5: PR state and merged cleanup unification

## 5.1 Current issue

Merged cleanup polling uses `gh.prIsMerged(...)` separately from sidebar PR status.

That means:
- duplicate GitHub work
- separate cadence
- separate truth
- more branching logic

---

## 5.2 Target

Merged cleanup should react to snapshot state transitions.

### Example rule
If a snapshot changes from:
- previous `pr.state !== "MERGED"`
- next `pr.state === "MERGED"`
- tree has `prUrl`
- `mergeNotified` is not set

Then trigger the existing notification flow.

### Benefits
- one PR-truth source
- one background refresh path
- less GitHub duplication
- sidebar and cleanup notifications stay aligned

### Caveat
Need to preserve behavior:
- notify only in tree’s own window or main window
- dedupe with `mergeNotified`
- do not block polling on ignored notifications

That logic can stay; only the source of merged-state detection changes.

---

# Part 6: cache and invalidation redesign

## 6.1 Current cache structure

```ts
Map<string, { data: Promise<TreeCardData>; time: number }>
```

Problems:
- cache stores only promises, not current resolved snapshot metadata
- hard to expose stale/loading/error state
- easy to clear destructively
- service is optimized for `build()`, not for reuse by multiple consumers

---

## 6.2 Proposed cache entry structure

```ts
interface SnapshotEntry {
  snapshot: TreeSnapshot;
  fetchPromise?: Promise<void>;
  fetchedAt?: number;
}
```

### Why this is better
- can return immediate last-known-good snapshot
- can indicate `loading` while keeping existing values
- can track `stale`
- can expose refresh errors without losing data
- supports many consumers, not just one `build()` call

---

## 6.3 Refresh algorithm

For each tree:

1. Build a base snapshot from durable tree state.
2. If missing tree path or folder gone:
   - keep minimal snapshot
   - mark not loading
3. If a fetch is already in flight:
   - return existing snapshot
   - optionally await if caller explicitly requests warm data
4. If snapshot is fresh enough:
   - return existing snapshot
5. Else:
   - mark `loading=true`, keep previous values
   - start fetch
   - when done, merge new values into snapshot
   - mark `loading=false`, `stale=false`, update `fetchedAt`
   - emit change event
   - if failed, keep prior values, mark `error`, `stale=true`, `loading=false`

---

## 6.4 What counts as “fresh”

Suggested TTLs:
- PR / ahead-behind / remote-tracking / local changes: 60s
- maybe different TTL for `localChanges` if we find it should be more reactive

Do **not** overcomplicate v1 with per-field TTLs unless needed.

Use one per-tree snapshot freshness window first.

---

# Part 7: state ownership rules

## 7.1 Durable vs derived

### Durable: belongs in `state.ts`
- user/worktree metadata
- operation flags
- workflow flags like `needsSetup`, `mergeNotified`

### Derived: belongs in snapshot service
- PR state / number / review decision
- ahead/behind counts
- remote-tracking existence
- local change summary
- “is this done/in review” categorization inputs

---

## 7.2 `prUrl` decision

This needs an explicit rule.

### Short-term recommended rule
- `prUrl` may remain in durable state as a convenience hint.
- snapshot remains authoritative for current PR metadata.
- if snapshot has a URL and state lacks one, updating state is allowed but should be treated as optional convenience, not essential synchronization.

### Long-term ideal
Either:
1. remove `prUrl` from state and rely on snapshot, or
2. formally declare `prUrl` as durable cached metadata with clear ownership

What we should avoid is today’s ambiguous middle ground.

---

# Part 8: webview/provider responsibilities after refactor

## 8.1 ForestWebviewProvider should become thinner

### Today it does too much
- snapshot retrieval
- form orchestration
- extra remote fetches
- some git state checks for UI open

### Target role
- subscribe to snapshot service
- transform snapshots into `WebviewData`
- post updates to webview
- handle messages
- execute commands
- no render-time GitHub fetches for tree forms

---

## 8.2 `refresh()` semantics should change

Current:
```ts
refresh(): void {
  this.data.clear();
  this.update();
}
```

Target:
```ts
refresh(): void {
  void this.snapshotService.refreshRepo(this.repoPath, { force: true });
}
```

Or, if we want immediate UI repaint of stale values:
```ts
refresh(): void {
  this.updateFromCurrentSnapshots();
  void this.snapshotService.refreshRepo(this.repoPath, { force: true });
}
```

Key idea:
- **refresh does not erase data**
- refresh means “start getting newer data”

---

## 8.3 Webview data should include all form-needed config

To let the webview derive form init locally, add needed config-derived fields to `WebviewData`, such as:
- `cancelStatusName`
- `cleanupStatusName`
- possibly app-wide capabilities flags if useful

Then the webview can build delete-form defaults from the snapshot it already has.

---

# Part 9: phased implementation plan

## Phase 0: document invariants

Before code changes, write down invariants in comments / docstring:

- UI surfaces render from snapshots, not ad hoc remote fetches.
- Destructive/commit actions revalidate at submit time.
- Snapshot refresh preserves last-known-good data.
- `refresh()` does not clear data.

This avoids regressions during the refactor.

---

## Phase 1: evolve `TreeDataService` into reusable snapshot store

### Tasks
1. Replace promise-only cache with snapshot entries.
2. Add explicit `loading`, `stale`, `error`, `fetchedAt`.
3. Add `getSnapshot(key)` / `getSnapshotsForRepo(repoPath)`.
4. Add `refreshTree()` / `refreshRepo()` / `ensureWarm()`.
5. Add `onDidChangeSnapshots` event.
6. Stop clearing all state on refresh.

### Deliverable
A service that can be consumed by more than just `build()`.

---

## Phase 2: move periodic refresh into the service layer

### Tasks
1. Service owns interval-based repo refresh.
2. Start it on activation or when provider context is set.
3. Remove or simplify the 3-minute health refresh in `extension.ts`.
4. Make provider subscribe to snapshot changes and post updates.

### Deliverable
Remote tree data freshness is owned by one service.

---

## Phase 3: make sidebar fully snapshot-driven without destructive invalidation

### Tasks
1. Refactor `build()` to assemble `WebviewData` from snapshots.
2. Do not drop cached values during in-flight refresh.
3. Ensure state changes only update affected snapshots.
4. Keep grouping logic (`In progress`, `In review`, etc.) snapshot-based.

### Deliverable
Sidebar becomes stable, fast, and refreshes incrementally.

---

## Phase 4: delete form consumes snapshot data

### Tasks
1. Add needed config fields to `WebviewData`.
2. Have webview derive delete form init from selected tree card + config.
3. Change delete command message payload to carry init data or equivalent fields.
4. Remove `gh.prStatus` / `git.remoteBranchExists` from `showDeleteForm()`.
5. Keep submit-time validation in `handleDeleteSubmit()` / `executeDeletePlan()`.

### Deliverable
Delete form opens instantly; current user-visible lag disappears.

---

## Phase 5: unify merged PR cleanup with snapshot transitions

### Tasks
1. Track previous snapshot PR state.
2. On `OPEN/CLOSED/null -> MERGED`, trigger existing cleanup notice flow.
3. Respect current window scoping rules.
4. Keep `mergeNotified` dedupe.
5. Remove independent `gh.prIsMerged()` polling path.

### Deliverable
One PR-truth source across sidebar and cleanup notifications.

---

## Phase 6: normalize PR URL ownership

### Tasks
1. Decide short-term `prUrl` policy.
2. Update ship/open-PR code to use declared ownership rules.
3. Reduce side-effect writes where possible.
4. Add comments documenting whether `prUrl` is authoritative or convenience-only.

### Deliverable
PR metadata has clear ownership.

---

## Phase 7: reduce duplicate state loads in command paths

### Tasks
1. Add helpers that accept a resolved latest tree snapshot/state when already available.
2. Avoid `load() -> helper -> load()` patterns where possible.
3. Consider introducing a small helper like:

```ts
resolveLatestTree(ctx, repoPath, branch): Promise<TreeState | undefined>
```

4. Keep cross-window correctness by reloading only where needed.

### Deliverable
Cleaner command orchestration, less incidental I/O.

---

# Part 10: recommended exact code changes by file

## `src/views/treeData.ts`

### Change scope
High. This is the center of the refactor.

### Likely changes
- rename to `treeSnapshots.ts` or keep filename initially and refactor internals
- introduce `TreeSnapshot` and `SnapshotEntry`
- add event emitter
- add targeted refresh methods
- convert `build()` to consume stored snapshots instead of owning the only fetch path
- keep existing grouping logic

### Watch-outs
- do not break current `treeData.test.ts` behavior without replacing it with equivalent coverage
- keep failures isolated per tree

---

## `src/views/ForestWebviewProvider.ts`

### Change scope
High.

### Likely changes
- subscribe to snapshot change events
- simplify `refresh()`
- remove delete-form remote fetches
- possibly keep `showDeleteForm()` only as a transport layer, or remove it entirely in favor of direct webview-driven init
- ensure `update()` can render from current snapshots without waiting for full fetch completion

### Watch-outs
- avoid posting excessive updates to the webview; debounce if necessary
- keep behavior identical for hidden/non-visible webview

---

## `src/extension.ts`

### Change scope
Medium-high.

### Likely changes
- remove the 3-minute health refresh interval or delegate it to snapshot service
- replace merged-PR polling with snapshot transition observer
- keep orphan polling separate unless snapshot service later owns filesystem-health too

### Watch-outs
- preserve current notification dedupe semantics
- preserve “only notify in tree’s own window or main window” behavior

---

## `src/commands/cleanup.ts`

### Change scope
Medium.

### Likely changes
- leave `fallbackDeletePlan()` for non-webview path
- keep commit-time validation in `executeDeletePlan()`
- possibly adjust delete-plan defaults if payload now comes from snapshot/webview

### Watch-outs
- do not weaken submit-time safety checks

---

## `src/commands/ship.ts`

### Change scope
Medium-low.

### Likely changes
- maybe annotate why commit-time GitHub queries are still valid here
- refresh snapshot after ship success
- possibly reduce dependence on `tree.prUrl` for flow control if snapshot/service becomes stronger

### Watch-outs
- avoid changing ship semantics unnecessarily; this area is correctness-sensitive

---

## `src/commands/shared.ts`

### Change scope
Low-medium.

### Likely changes
- possibly add helpers for “resolve latest tree once”
- maybe allow `ensureTreeIdle` variants that take preloaded latest tree state

### Watch-outs
- don’t over-abstract; keep helpers small

---

# Part 11: risk assessment

## 11.1 Main risks

### Risk: stale snapshot leads to slightly stale form defaults
Example:
- snapshot says PR is open
- user opens delete form
- PR was merged 5 seconds ago

Mitigation:
- acceptable for form defaults
- correctness checks remain at submit time
- periodic refresh bounds staleness

### Risk: too many background requests
Mitigation:
- use 60s cadence initially
- keep one in-flight fetch per tree
- skip refresh when one is already running
- consider pausing or slowing when unfocused later

### Risk: event/update storms to webview
Mitigation:
- debounce snapshot change notifications in provider
- batch repo refresh updates

### Risk: state/UI drift during transition
Mitigation:
- migrate one consumer at a time
- keep old fallback paths until snapshot path is stable

### Risk: PR URL ownership confusion remains
Mitigation:
- explicitly document short-term rule
- avoid relying on side-effect updates as control flow

---

# Part 12: testing plan

## 12.1 Unit tests for snapshot service

Add/expand tests for:
- returns cached snapshot while refresh in flight
- preserves last-known-good snapshot on refresh failure
- emits change events on snapshot update
- does not duplicate in-flight fetches
- targeted refresh of one tree vs whole repo
- stale/fresh behavior by TTL
- grouping still works with snapshots

Potential file:
- extend `test/views/treeData.test.ts`
- or rename/create `test/views/treeSnapshots.test.ts`

---

## 12.2 Delete-form tests

Add tests for:
- delete form init no longer calls `gh.prStatus`
- delete form init no longer calls `git.remoteBranchExists`
- form opens from existing snapshot data
- submit still checks `ensureTreeIdle`
- submit still checks uncommitted changes warning

---

## 12.3 PR transition tests

Add tests for:
- snapshot transition to `MERGED` triggers notify path once
- `mergeNotified` suppresses repeats
- non-own-window trees still obey existing scoping rules

---

## 12.4 Regression tests around refresh semantics

Add tests for:
- `refresh()` does not clear visible data
- snapshot remains available during background refresh
- state changes do not force global data loss

---

# Part 13: rollout strategy

## Step 1: internal service refactor with no UI behavior change
- change cache model
- add snapshot APIs
- keep `build()` output same

## Step 2: provider refresh semantics
- stop `clear()` on refresh
- subscribe to snapshot events

## Step 3: delete form migration
- use snapshot/webview data
- remove render-time fetches

## Step 4: merged PR cleanup migration
- move from separate polling to snapshot transitions

## Step 5: PR URL cleanup
- clarify/document ownership
- simplify call sites

This order limits blast radius and gets the user-visible win early.

---

# Part 14: recommended non-goals for this refactor

To keep scope reasonable, avoid bundling these unless needed:

1. A full `RepoSnapshotService` for main repo state
2. Reworking all Linear fetching
3. Reworking devcontainer cleanup behavior
4. Redesigning all command APIs around new snapshot types immediately
5. Removing `prUrl` from persistent state in the first pass

These can be follow-ups.

---

# Part 15: suggested implementation decisions

## Decision 1: rename now or later?

### Option A: keep `TreeDataService` name initially
Pros:
- smaller diff
- easier migration

Cons:
- name undersells new responsibility

### Option B: rename to `TreeSnapshotService` now
Pros:
- architecture becomes explicit immediately

Cons:
- larger diff

### Recommendation
Keep file/name initially if minimizing churn matters, but use `TreeSnapshot` terminology in types/comments. Rename later if the refactor lands well.

---

## Decision 2: should the webview construct delete-form init itself?

### Option A: webview sends full init payload
Pros:
- no provider recomputation
- simple and instant

Cons:
- more UI logic in webview JS

### Option B: webview sends key; provider derives init from current snapshot cache
Pros:
- keeps derivation in TypeScript
- thinner webview logic

Cons:
- provider still needs snapshot lookup

### Recommendation
Prefer **Option B** if snapshot service is easily accessible from provider. It keeps logic out of raw webview JS while still avoiding remote fetches.

---

## Decision 3: should merged-cleanup notifications live in service or extension?

### Recommendation
Keep user-notification orchestration in `extension.ts` / provider layer, not inside snapshot service.

The service should emit data changes.
The app layer should decide what UX to trigger.

---

# Part 16: success criteria

This refactor is successful if:

1. Clicking delete from the sidebar opens the form essentially instantly.
2. `showDeleteForm()` no longer performs blocking remote fetches.
3. `refresh()` no longer clears all cached tree data.
4. Sidebar keeps showing last-known-good data during background refresh.
5. There is one authoritative path for PR state used by both sidebar and merge-cleanup notification logic.
6. Tests cover snapshot caching, refresh semantics, delete-form behavior, and merged-state transitions.

---

# Part 17: ideal end state

In the ideal end state:

- `state.ts` holds durable workflow state.
- `TreeSnapshotService` holds derived git/GitHub truth.
- `ForestWebviewProvider` is a thin adapter.
- sidebar cards, delete form, PR review form all read the same snapshot data.
- destructive commands still revalidate at submit time.
- refresh means “get newer data”, not “erase current data”.
- the extension no longer has multiple independent PR-state polling paths.

That architecture is simpler, faster, and more reliable — and the current delete-form delay disappears naturally rather than being patched locally.
