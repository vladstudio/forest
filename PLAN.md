# Forest — Implementation Plan

A VSCode extension that manages parallel feature development using git worktrees. One tree = one Linear ticket = one branch = one worktree = one VSCode window.

---

## Table of Contents

1. [Terminology](#1-terminology)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Setup](#3-project-setup)
4. [Configuration Format](#4-configuration-format)
5. [State Management](#5-state-management)
6. [Extension Manifest](#6-extension-manifest)
7. [Extension Activation](#7-extension-activation)
8. [CLI Wrappers](#8-cli-wrappers)
9. [Commands](#9-commands)
10. [Sidebar Views](#10-sidebar-views)
11. [Terminal Manager](#11-terminal-manager)
12. [Browser Manager](#12-browser-manager)
13. [Port Manager](#13-port-manager)
14. [Status Bar](#14-status-bar)
15. [Cross-Window State Sync](#15-cross-window-state-sync)
16. [Workspace File Generation](#16-workspace-file-generation)
17. [Error Handling](#17-error-handling)
18. [Build & Distribution](#18-build--distribution)
19. [Testing Strategy](#19-testing-strategy)
20. [File-by-File Specification](#20-file-by-file-specification)

---

## 1. Terminology

| Term | Meaning |
|------|---------|
| **Tree** | A single unit of work: Linear ticket + git branch + worktree directory + VSCode window |
| **Forest** | The collection of all active trees for a given repo |
| **Plant** | Create a tree from an existing Linear ticket |
| **Seed** | Create a new Linear ticket AND a tree in one step |
| **Ship** | Push branch + create PR + move ticket to "In Review" |
| **Fell** | Merge PR + delete worktree + delete branch + move ticket to "Done" |
| **Water** | Refresh a tree (re-run setup, reinstall deps) |
| **Survey** | View all trees in a quick-pick list |
| **Grove** | The directory on disk where all tree worktrees live (e.g. `~/forest/kadoa-backend/`) |

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        VSCode Window A                          │
│  ┌──────────┐  ┌──────────────────────────┐  ┌──────────────┐  │
│  │ Sidebar   │  │ Editor                   │  │ Browser Tab  │  │
│  │           │  │                          │  │ localhost:   │  │
│  │ MY ISSUES │  │  code...                 │  │ 14001        │  │
│  │ ○ KAD-95  │  │                          │  │              │  │
│  │ ○ KAD-12  │  │                          │  │              │  │
│  │           │  │                          │  │              │  │
│  │ TREES     │  ├──────────────────────────┤  │              │  │
│  │ ● KAD-88 ←│  │ Terminals               │  │              │  │
│  │ ● KAD-01  │  │ [dev] [claude] [shell]  │  │              │  │
│  └──────────┘  └──────────────────────────┘  └──────────────┘  │
│  Status: [KAD-4788] ● dev ● claude              ▌ green bar ▌  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        VSCode Window B                          │
│  (same structure, different tree, different color)              │
│  All processes in Window A continue running.                    │
└─────────────────────────────────────────────────────────────────┘

Shared state: ~/.forest/state.json (watched by all windows)
Repo config:  <repo>/.forest/config.json (checked into git)
Local config: <repo>/.forest/local.json (gitignored)
```

### Process Architecture

Each VSCode window is an independent OS process. Each window runs its own extension host with its own instance of Forest. Windows share state through `~/.forest/state.json` using file system watchers. Switching between windows does NOT affect processes in other windows — all terminals, dev servers, and Claude Code sessions keep running.

### External Dependencies

Forest delegates to existing CLIs instead of reimplementing their functionality:

| Tool | Purpose | Required |
|------|---------|----------|
| `git` | Worktree management, branching, push | Yes |
| `gh` | PR merge operations | Yes |
| `linear` | Ticket management, PR creation | Optional (features degrade gracefully) |

---

## 3. Project Setup

### Directory Structure

```
forest/
├── .vscode/
│   ├── launch.json          # F5 debug config
│   ├── tasks.json           # Build tasks
│   └── extensions.json      # Recommended extensions
├── src/
│   ├── extension.ts         # Activation / deactivation
│   ├── config.ts            # .forest/config.json + local.json loader
│   ├── state.ts             # ~/.forest/state.json manager
│   ├── context.ts           # Shared extension context (config, state, current tree)
│   │
│   ├── views/
│   │   ├── IssuesTreeProvider.ts   # "MY ISSUES" sidebar section
│   │   ├── TreesTreeProvider.ts    # "TREES" sidebar section
│   │   └── items.ts               # TreeItem renderers (IssueItem, TreeItem)
│   │
│   ├── managers/
│   │   ├── TerminalManager.ts      # Create, watch, restart named terminals
│   │   ├── BrowserManager.ts       # Open browser tabs, wait for ports
│   │   ├── PortManager.ts          # Allocate/free port ranges
│   │   └── StatusBarManager.ts     # Status bar with tree name + process health
│   │
│   ├── commands/
│   │   ├── seed.ts          # Create Linear ticket + tree
│   │   ├── plant.ts         # Create tree from existing ticket
│   │   ├── switch.ts        # Focus another tree's VSCode window
│   │   ├── ship.ts          # Push + PR + "In Review"
│   │   ├── fell.ts          # Merge + cleanup + "Done"
│   │   ├── water.ts         # Refresh deps (re-run setup)
│   │   └── survey.ts        # Quick-pick list of all trees
│   │
│   ├── cli/
│   │   ├── linear.ts        # Spawn `linear` CLI, parse JSON output
│   │   ├── gh.ts            # Spawn `gh` CLI, parse output
│   │   └── git.ts           # Worktree create/delete/list, push, branch
│   │
│   └── utils/
│       ├── ports.ts         # Port allocation logic
│       ├── colors.ts        # Ticket ID → deterministic HSL color
│       ├── slug.ts          # Title → URL-safe slug
│       └── exec.ts          # Promise-based child_process.exec wrapper
│
├── resources/
│   └── forest.svg           # Activity bar icon (tree icon, 24x24, monochrome)
│
├── test/
│   ├── suite/
│   │   ├── config.test.ts
│   │   ├── state.test.ts
│   │   ├── portManager.test.ts
│   │   ├── colors.test.ts
│   │   └── cli/
│   │       ├── git.test.ts
│   │       ├── linear.test.ts
│   │       └── gh.test.ts
│   ├── runTest.ts
│   └── index.ts
│
├── .vscodeignore
├── .gitignore
├── esbuild.js
├── tsconfig.json
├── package.json
├── LICENSE
└── README.md
```

### Technology Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Language | TypeScript (strict mode) | VSCode extension standard |
| Runtime | Node.js (VSCode extension host) | Required by VSCode |
| Bundler | esbuild | Fast, simple, VSCode-recommended |
| Package manager | npm | Standard for VSCode extensions (not bun — extension runs in VSCode's Node.js) |
| Testing | @vscode/test-electron + mocha | VSCode official test framework |
| Linting | ESLint | Standard |

### Initial Scaffold

```bash
mkdir forest && cd forest
npx --package yo --package generator-code -- yo code \
  --extensionType ts \
  --bundle esbuild \
  --pkgManager npm \
  --gitInit \
  --quick
```

Then restructure to match the directory layout above.

### tsconfig.json

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": "src",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true
  },
  "exclude": ["node_modules", ".vscode-test", "dist"]
}
```

---

## 4. Configuration Format

### 4.1. Repo Config: `.forest/config.json`

Checked into git. Shared with the team. Defines how trees behave for this repo.

```jsonc
{
  // Schema version for future compatibility
  "version": 1,

  // Where worktrees are created on disk.
  // Variables: ${repo} = repository directory name
  // Default: "~/forest/${repo}"
  "treesDir": "~/forest/${repo}",

  // Files/directories to copy from main repo into each new tree.
  // Paths are relative to repo root.
  // These are COPIED (not symlinked) because they may differ per tree.
  "copy": [".env", ".env.local"],

  // Command to run once after worktree creation + file copy.
  // Runs in the tree's root directory.
  // Can be a string (single command) or array of strings (run sequentially).
  "setup": "bun install --frozen-lockfile",

  // Terminal tabs to create in each tree's VSCode window.
  "terminals": [
    {
      // Display name for the terminal tab
      "name": "dev",
      // Command to execute. If omitted, opens a plain shell.
      "command": "bunx turbo dev",
      // If true, terminal is created and command runs when VSCode opens the tree.
      // If false, terminal is created but no command runs (user can start manually).
      "autostart": true,
      // Optional environment variables for this terminal only.
      "env": {}
    },
    {
      "name": "claude",
      "command": "claude",
      "autostart": true
    },
    {
      "name": "shell",
      "autostart": false
    }
  ],

  // Browser tabs to open inside VSCode (uses integrated browser / Simple Browser).
  // Each entry opens a separate browser tab.
  "browsers": [
    {
      // Display name (shown in tab title)
      "name": "Dashboard",
      // URL to open. Supports ${ports.<name>} variable interpolation.
      "url": "http://localhost:${ports.dashboard}",
      // If true, Forest waits for the port to accept connections before opening.
      // Prevents "connection refused" on slow-starting dev servers.
      "waitForPort": true,
      // Max seconds to wait for port. Default: 120.
      "waitTimeout": 120
    }
  ],

  // Port allocation for running multiple trees simultaneously.
  "ports": {
    // Range of base ports Forest can allocate from.
    // Each tree gets one base port; individual service ports are offsets from it.
    "baseRange": [14000, 15000],
    // Named port offsets from the tree's base port.
    // e.g., if base=14000, dashboard=14000, api=14001, worker=14002
    "mapping": {
      "dashboard": "+0",
      "api": "+1",
      "worker": "+2"
    }
  },

  // Environment variable overrides written to a `.forest.env` file in each tree.
  // Supports ${ports.<name>} interpolation.
  // This file is sourced by terminals if the user's shell/direnv is configured.
  // Forest also injects these as env vars into terminals it creates.
  "env": {
    "DASHBOARD_PORT": "${ports.dashboard}",
    "PUBLIC_API_PORT": "${ports.api}"
  },

  // Integration toggles. Each requires the respective CLI on PATH.
  "integrations": {
    // Enable Linear integration. Requires `linear` CLI (https://github.com/nicholasgriffintn/linear-cli).
    // When enabled: sidebar shows "MY ISSUES", commands use `linear` CLI for ticket ops.
    // When disabled: user must manually enter ticket ID and title.
    "linear": true,

    // Enable GitHub integration. Requires `gh` CLI.
    // When enabled: "Ship" creates PRs, "Fell" merges them.
    // When disabled: user handles PRs manually.
    "github": true
  },

  // Branch naming format.
  // Variables: ${ticketId}, ${slug} (slugified ticket title)
  // Default: "${ticketId}-${slug}"
  "branchFormat": "${ticketId}-${slug}",

  // Base branch to create worktrees from.
  // Default: "origin/main"
  "baseBranch": "origin/main",

  // Maximum number of simultaneous trees. Prevents port exhaustion.
  // Default: 10
  "maxTrees": 10
}
```

### 4.2. Local Config: `.forest/local.json`

Gitignored. Per-developer overrides.

```jsonc
{
  // Override or extend terminals (merged with config.json terminals by name)
  "terminals": [
    { "name": "logs", "command": "tail -f .logs/*.log", "autostart": true }
  ],

  // Override any top-level config values
  "setup": "bun install",
  "maxTrees": 5
}
```

### 4.3. Config Resolution

1. Read `.forest/config.json` from workspace root
2. Read `.forest/local.json` from workspace root (if exists)
3. Deep merge: `local` overrides `config` at each key level
4. For `terminals` array: merge by `name` field (local overrides matching entries, appends new ones)
5. Resolve `~` in `treesDir` to `os.homedir()`
6. Validate all required fields, set defaults for optional ones

### 4.4. Config Validation

On activation, validate:
- `version` is `1`
- `treesDir` is a writable path (or can be created)
- `ports.baseRange` is a 2-element array of integers, `[0] < [1]`, range >= 100
- `ports.mapping` values match pattern `+N` where N is an integer
- `terminals` entries have `name` (string), optional `command` (string), optional `autostart` (boolean)
- `browsers` entries have `name`, `url`, optional `waitForPort`, optional `waitTimeout`
- `branchFormat` contains `${ticketId}`
- `baseBranch` is a valid git ref
- `integrations.linear` → `linear` is on PATH (warn if not, don't fail)
- `integrations.github` → `gh` is on PATH (warn if not, don't fail)

If `.forest/config.json` doesn't exist, the extension is **inert** — no sidebar, no commands registered, no overhead. The extension activation event should only fire when the config exists.

---

## 5. State Management

### 5.1. State File: `~/.forest/state.json`

Global state file shared across all VSCode windows. Each Forest extension instance reads and writes to this file.

```jsonc
{
  // Schema version
  "version": 1,

  // Trees indexed by a composite key: "<repoPath>:<ticketId>"
  // This allows multiple repos to use Forest simultaneously.
  "trees": {
    "/Users/vlad/Code/kadoa-backend:KAD-4788": {
      "ticketId": "KAD-4788",
      "title": "Fix team invite role selection",
      "branch": "KAD-4788-fix-team-invite-role-selection",
      "path": "/Users/vlad/forest/kadoa-backend/KAD-4788",
      "repoPath": "/Users/vlad/Code/kadoa-backend",
      "portBase": 14000,
      "status": "dev",
      "createdAt": "2026-02-13T10:00:00.000Z"
    },
    "/Users/vlad/Code/kadoa-backend:KAD-4801": {
      "ticketId": "KAD-4801",
      "title": "New API endpoint",
      "branch": "KAD-4801-new-api-endpoint",
      "path": "/Users/vlad/forest/kadoa-backend/KAD-4801",
      "repoPath": "/Users/vlad/Code/kadoa-backend",
      "portBase": 14100,
      "status": "review",
      "createdAt": "2026-02-12T15:00:00.000Z",
      "prUrl": "https://github.com/kadoa-team/kadoa-backend/pull/247"
    }
  }
}
```

### 5.2. Tree Status Values

| Status | Meaning |
|--------|---------|
| `dev` | Actively being worked on |
| `testing` | Development complete, testing in progress |
| `review` | PR created, waiting for review |
| `done` | Merged, ready for cleanup |

Status is informational (shown in sidebar). It's updated by commands:
- `plant` / `seed` → `dev`
- `ship` → `review`
- `fell` → tree is removed from state

### 5.3. State Operations

```typescript
interface ForestState {
  version: number;
  trees: Record<string, TreeState>;
}

interface TreeState {
  ticketId: string;
  title: string;
  branch: string;
  path: string;        // absolute path to worktree directory
  repoPath: string;    // absolute path to main repo
  portBase: number;
  status: 'dev' | 'testing' | 'review' | 'done';
  createdAt: string;   // ISO 8601
  prUrl?: string;
}

// State manager API
class StateManager {
  // Read state from disk
  async load(): Promise<ForestState>;

  // Write state to disk (triggers watchers in other windows)
  async save(state: ForestState): Promise<void>;

  // Add a tree
  async addTree(repoPath: string, tree: TreeState): Promise<void>;

  // Remove a tree
  async removeTree(repoPath: string, ticketId: string): Promise<void>;

  // Update a tree's fields
  async updateTree(repoPath: string, ticketId: string, updates: Partial<TreeState>): Promise<void>;

  // Get all trees for a specific repo
  getTreesForRepo(state: ForestState, repoPath: string): TreeState[];

  // Get a specific tree
  getTree(state: ForestState, repoPath: string, ticketId: string): TreeState | undefined;

  // Watch for changes (from other windows)
  onDidChange: vscode.Event<ForestState>;
}
```

### 5.4. Concurrency

Multiple VSCode windows may write to state.json simultaneously. Use optimistic locking:

1. Read file, parse JSON
2. Make modifications in memory
3. Write file atomically (write to temp file, rename)

Since operations are infrequent (user-triggered commands), race conditions are extremely unlikely. If they occur, the worst case is a stale sidebar that refreshes on the next file change event.

Use `fs.writeFileSync` with a temp file + `fs.renameSync` for atomic writes:

```typescript
async save(state: ForestState): Promise<void> {
  const content = JSON.stringify(state, null, 2);
  const tmpPath = this.statePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, this.statePath);
}
```

---

## 6. Extension Manifest

### package.json (contributes section)

```jsonc
{
  "name": "forest",
  "displayName": "Forest",
  "description": "Manage parallel feature development with git worktrees",
  "version": "0.1.0",
  "publisher": "forest-dev",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "keywords": ["git", "worktree", "linear", "workflow", "monorepo"],
  "main": "./dist/extension.js",
  "activationEvents": [
    "workspaceContains:.forest/config.json"
  ],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "forest",
          "title": "Forest",
          "icon": "resources/forest.svg"
        }
      ]
    },
    "views": {
      "forest": [
        {
          "id": "forest.issues",
          "name": "My Issues",
          "when": "forest.active && forest.linearEnabled"
        },
        {
          "id": "forest.trees",
          "name": "Trees",
          "when": "forest.active"
        }
      ]
    },
    "viewsWelcome": [
      {
        "view": "forest.trees",
        "contents": "No trees planted yet.\n[Plant a Tree](command:forest.plant)\n[Seed a New Ticket](command:forest.seed)",
        "when": "forest.active && forest.noTrees"
      }
    ],
    "commands": [
      {
        "command": "forest.seed",
        "title": "Seed — New Ticket + Tree",
        "category": "Forest",
        "icon": "$(add)"
      },
      {
        "command": "forest.plant",
        "title": "Plant — Tree from Existing Ticket",
        "category": "Forest",
        "icon": "$(git-branch)"
      },
      {
        "command": "forest.switch",
        "title": "Switch Tree",
        "category": "Forest",
        "icon": "$(arrow-swap)"
      },
      {
        "command": "forest.ship",
        "title": "Ship — Push + PR",
        "category": "Forest",
        "icon": "$(rocket)"
      },
      {
        "command": "forest.fell",
        "title": "Fell — Merge + Cleanup",
        "category": "Forest",
        "icon": "$(check-all)"
      },
      {
        "command": "forest.water",
        "title": "Water — Refresh Dependencies",
        "category": "Forest",
        "icon": "$(refresh)"
      },
      {
        "command": "forest.survey",
        "title": "Survey — List All Trees",
        "category": "Forest",
        "icon": "$(list-tree)"
      },
      {
        "command": "forest.openInLinear",
        "title": "Open in Linear",
        "category": "Forest",
        "icon": "$(link-external)"
      },
      {
        "command": "forest.copyBranch",
        "title": "Copy Branch Name",
        "category": "Forest",
        "icon": "$(copy)"
      },
      {
        "command": "forest.setStatus",
        "title": "Set Tree Status",
        "category": "Forest",
        "icon": "$(tag)"
      },
      {
        "command": "forest.refreshIssues",
        "title": "Refresh Issues",
        "category": "Forest",
        "icon": "$(refresh)"
      },
      {
        "command": "forest.refreshTrees",
        "title": "Refresh Trees",
        "category": "Forest",
        "icon": "$(refresh)"
      }
    ],
    "menus": {
      "view/title": [
        {
          "command": "forest.refreshIssues",
          "when": "view == forest.issues",
          "group": "navigation"
        },
        {
          "command": "forest.seed",
          "when": "view == forest.issues",
          "group": "navigation"
        },
        {
          "command": "forest.refreshTrees",
          "when": "view == forest.trees",
          "group": "navigation"
        },
        {
          "command": "forest.plant",
          "when": "view == forest.trees",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "forest.plant",
          "when": "view == forest.issues && viewItem == issue",
          "group": "inline"
        },
        {
          "command": "forest.switch",
          "when": "view == forest.trees && viewItem == tree",
          "group": "inline"
        },
        {
          "command": "forest.openInLinear",
          "when": "viewItem == tree || viewItem == issue",
          "group": "1_navigation"
        },
        {
          "command": "forest.copyBranch",
          "when": "viewItem == tree",
          "group": "1_navigation"
        },
        {
          "command": "forest.setStatus",
          "when": "viewItem == tree",
          "group": "2_status"
        },
        {
          "command": "forest.ship",
          "when": "viewItem == tree",
          "group": "3_lifecycle"
        },
        {
          "command": "forest.water",
          "when": "viewItem == tree",
          "group": "3_lifecycle"
        },
        {
          "command": "forest.fell",
          "when": "viewItem == tree",
          "group": "4_danger"
        }
      ]
    },
    "keybindings": [
      {
        "command": "forest.survey",
        "key": "ctrl+shift+f",
        "mac": "cmd+shift+f",
        "when": "forest.active"
      }
    ]
  }
}
```

Note on keybindings: `cmd+shift+f` conflicts with Find in Files. Consider `cmd+alt+f` or let the user configure it. Better: register the command but don't assign a default keybinding. Users can bind it via VSCode's keyboard shortcuts UI.

Revised:
```jsonc
"keybindings": []
```

---

## 7. Extension Activation

### `src/extension.ts`

```typescript
import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
  // 1. Load config from workspace root
  const config = await loadConfig();
  if (!config) {
    // No .forest/config.json found — extension stays inert
    return;
  }

  // 2. Set context flags for `when` clauses in package.json
  vscode.commands.executeCommand('setContext', 'forest.active', true);
  vscode.commands.executeCommand('setContext', 'forest.linearEnabled', config.integrations.linear);

  // 3. Initialize state manager
  const stateManager = new StateManager(context);
  await stateManager.initialize();

  // 4. Detect if current workspace is a tree
  const currentTree = detectCurrentTree(stateManager, config);

  // 5. Initialize managers
  const portManager = new PortManager(config, stateManager);
  const terminalManager = new TerminalManager(config, currentTree);
  const browserManager = new BrowserManager(config, currentTree);
  const statusBarManager = new StatusBarManager(currentTree);

  // 6. Register sidebar views
  const issuesProvider = new IssuesTreeProvider(config, stateManager);
  const treesProvider = new TreesTreeProvider(config, stateManager);
  vscode.window.registerTreeDataProvider('forest.issues', issuesProvider);
  vscode.window.registerTreeDataProvider('forest.trees', treesProvider);

  // 7. Update "no trees" context for welcome view
  updateNoTreesContext(stateManager, config);

  // 8. Register all commands
  registerCommands(context, {
    config, stateManager, portManager,
    terminalManager, browserManager, statusBarManager,
    issuesProvider, treesProvider, currentTree,
  });

  // 9. If this window IS a tree, set up terminals + browser
  if (currentTree) {
    statusBarManager.show();
    await terminalManager.ensureConfiguredTerminals();
    await browserManager.openConfiguredBrowsers();
  }

  // 10. Watch state file for changes from other windows
  stateManager.onDidChange(() => {
    issuesProvider.refresh();
    treesProvider.refresh();
    updateNoTreesContext(stateManager, config);
  });
}

export function deactivate() {
  // Cleanup is handled by disposables pushed to context.subscriptions
}
```

### Detecting Current Tree

A workspace is a "tree" if its folder path matches a tree in state. The detection logic:

```typescript
function detectCurrentTree(stateManager: StateManager, config: ForestConfig): TreeState | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return undefined;

  const currentPath = workspaceFolder.uri.fsPath;
  const state = stateManager.loadSync();

  return Object.values(state.trees).find(tree => tree.path === currentPath);
}
```

Alternative detection: check if the current directory has a `.git` **file** (not directory) pointing to a worktree:

```typescript
function isGitWorktree(dirPath: string): boolean {
  const gitPath = path.join(dirPath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    return stat.isFile(); // .git is a file in worktrees, a directory in main repos
  } catch {
    return false;
  }
}
```

---

## 8. CLI Wrappers

### 8.1. `src/utils/exec.ts` — Shared Execution Helper

```typescript
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(cpExec);

interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Execute a command and return stdout/stderr.
 * Throws on non-zero exit code.
 */
export async function exec(
  command: string,
  options?: { cwd?: string; timeout?: number }
): Promise<ExecResult> {
  const result = await execAsync(command, {
    cwd: options?.cwd,
    timeout: options?.timeout ?? 30_000,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/**
 * Check if a command exists on PATH.
 */
export async function commandExists(name: string): Promise<boolean> {
  try {
    await exec(`which ${name}`);
    return true;
  } catch {
    return false;
  }
}
```

### 8.2. `src/cli/git.ts`

```typescript
import { exec } from '../utils/exec';

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;  // null if detached
}

/**
 * Create a new worktree with a new branch from a base ref.
 *
 * @param repoPath - Path to the main repo
 * @param worktreePath - Absolute path where the worktree will be created
 * @param branch - Name of the new branch to create
 * @param baseRef - Git ref to branch from (e.g. "origin/main")
 */
export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  // Fetch latest from remote first
  await exec('git fetch origin', { cwd: repoPath });
  // Create worktree with new branch
  await exec(
    `git worktree add "${worktreePath}" -b "${branch}" "${baseRef}"`,
    { cwd: repoPath },
  );
}

/**
 * Remove a worktree and its directory from disk.
 * Does NOT delete the branch.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await exec(
    `git worktree remove "${worktreePath}" --force`,
    { cwd: repoPath },
  );
}

/**
 * List all worktrees for a repo.
 * Parses `git worktree list --porcelain` output.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const { stdout } = await exec('git worktree list --porcelain', { cwd: repoPath });
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === '') {
      if (current.path && current.head) {
        worktrees.push({
          path: current.path,
          head: current.head,
          branch: current.branch ?? null,
        });
      }
      current = {};
    }
  }

  return worktrees;
}

/**
 * Delete a branch (local + remote).
 */
export async function deleteBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  // Delete local branch
  await exec(`git branch -D "${branch}"`, { cwd: repoPath }).catch(() => {});
  // Delete remote branch (ignore errors if already deleted)
  await exec(`git push origin --delete "${branch}"`, { cwd: repoPath }).catch(() => {});
}

/**
 * Push a branch to remote with tracking.
 */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  await exec(`git push -u origin "${branch}"`, { cwd: worktreePath });
}

/**
 * Check if there are uncommitted changes.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await exec('git status --porcelain', { cwd: worktreePath });
  return stdout.length > 0;
}

/**
 * Get the main repo path from a worktree directory.
 * Reads the .git file to find the main repo's .git directory.
 */
export async function getMainRepoPath(worktreePath: string): Promise<string | null> {
  const gitFilePath = path.join(worktreePath, '.git');
  try {
    const stat = fs.statSync(gitFilePath);
    if (stat.isFile()) {
      // It's a worktree — .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(gitFilePath, 'utf8').trim();
      const gitdir = content.replace('gitdir: ', '');
      // gitdir points to <main-repo>/.git/worktrees/<name>
      // Navigate up to get main repo path
      return path.resolve(gitdir, '..', '..', '..');
    }
  } catch {}
  return null;
}
```

### 8.3. `src/cli/linear.ts`

```typescript
import { exec, commandExists } from '../utils/exec';

interface LinearIssue {
  id: string;           // e.g. "KAD-4788"
  title: string;
  state: string;        // e.g. "In Progress", "Todo", "Done"
  priority: number;     // 1-4
  branchName?: string;  // Linear-suggested branch name
  url?: string;
}

let _linearAvailable: boolean | null = null;

export async function isAvailable(): Promise<boolean> {
  if (_linearAvailable === null) {
    _linearAvailable = await commandExists('linear');
  }
  return _linearAvailable;
}

/**
 * List issues assigned to the current user.
 * Filters by state: unstarted + started by default.
 */
export async function listMyIssues(
  states: string[] = ['unstarted', 'started'],
): Promise<LinearIssue[]> {
  const stateFlags = states.map(s => `--state ${s}`).join(' ');
  const { stdout } = await exec(
    `linear issue list ${stateFlags} --no-pager --json`,
    { timeout: 15_000 },
  );

  // Parse JSON output from linear CLI
  // The exact format depends on linear CLI version.
  // Expected: array of issue objects
  try {
    return JSON.parse(stdout);
  } catch {
    // Fallback: linear CLI may output non-JSON; handle gracefully
    return [];
  }
}

/**
 * Get a single issue by ID.
 */
export async function getIssue(issueId: string): Promise<LinearIssue | null> {
  try {
    const { stdout } = await exec(
      `linear issue view ${issueId} --json --no-pager --no-download`,
      { timeout: 10_000 },
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Create a new issue and return its ID.
 */
export async function createIssue(opts: {
  title: string;
  assignee?: string;
  priority?: number;
  label?: string;
  team?: string;
  state?: string;
}): Promise<string> {
  const args: string[] = [
    `--title "${opts.title}"`,
    '--assignee self',
    '--no-interactive',
  ];

  if (opts.priority) args.push(`--priority ${opts.priority}`);
  if (opts.label) args.push(`--label "${opts.label}"`);
  if (opts.team) args.push(`--team "${opts.team}"`);
  if (opts.state) args.push(`--state "${opts.state}"`);

  const { stdout } = await exec(
    `linear issue create ${args.join(' ')}`,
    { timeout: 15_000 },
  );

  // Parse ticket ID from output (e.g. "Created KAD-4830")
  const match = stdout.match(/([A-Z]+-\d+)/);
  if (!match) throw new Error(`Could not parse ticket ID from: ${stdout}`);
  return match[1];
}

/**
 * Update an issue's state.
 */
export async function updateIssueState(
  issueId: string,
  state: string,
): Promise<void> {
  await exec(
    `linear issue update ${issueId} --state "${state}" --no-interactive`,
    { timeout: 10_000 },
  );
}

/**
 * Create a GitHub PR for a Linear issue.
 * Uses `linear issue pr` which auto-populates title and body from the ticket.
 */
export async function createPR(
  issueId: string,
  baseBranch: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      `linear issue pr ${issueId} --base "${baseBranch}"`,
      { timeout: 30_000 },
    );
    // Try to extract PR URL from output
    const urlMatch = stdout.match(/(https:\/\/github\.com\/[^\s]+)/);
    return urlMatch ? urlMatch[1] : null;
  } catch (err) {
    throw new Error(`Failed to create PR: ${err}`);
  }
}

/**
 * Get the issue URL for opening in browser.
 */
export async function getIssueUrl(issueId: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      `linear issue url ${issueId}`,
      { timeout: 5_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
```

### 8.4. `src/cli/gh.ts`

```typescript
import { exec, commandExists } from '../utils/exec';

let _ghAvailable: boolean | null = null;

export async function isAvailable(): Promise<boolean> {
  if (_ghAvailable === null) {
    _ghAvailable = await commandExists('gh');
  }
  return _ghAvailable;
}

/**
 * Merge a PR by squash and delete the remote branch.
 * Runs from the worktree directory so `gh` can detect the repo.
 */
export async function mergePR(
  worktreePath: string,
  opts?: { squash?: boolean; deleteBranch?: boolean },
): Promise<void> {
  const flags: string[] = [];
  if (opts?.squash !== false) flags.push('--squash');
  if (opts?.deleteBranch !== false) flags.push('--delete-branch');

  await exec(
    `gh pr merge ${flags.join(' ')}`,
    { cwd: worktreePath, timeout: 30_000 },
  );
}

/**
 * Get the PR URL for the current branch.
 */
export async function getPRUrl(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'gh pr view --json url --jq .url',
      { cwd: worktreePath, timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check the PR review/check status.
 */
export async function getPRStatus(worktreePath: string): Promise<{
  state: string;
  reviewDecision: string;
  statusCheckRollup: string;
} | null> {
  try {
    const { stdout } = await exec(
      'gh pr view --json state,reviewDecision,statusCheckRollup',
      { cwd: worktreePath, timeout: 10_000 },
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
```

---

## 9. Commands

### 9.1. `seed` — Create New Ticket + Tree

**Trigger**: Command palette "Forest: Seed" or "+" icon in Issues view title bar.

**Flow**:

```
1. Show input box: "Issue title"
   → User types: "Fix team invite email validation"

2. Show quick pick: "Priority" (optional)
   → Options: Urgent (1), High (2), Normal (3), Low (4)
   → Default: Normal

3. Show quick pick: "Label" (optional, only if Linear available)
   → Options fetched from: linear label list (or hardcoded common ones)
   → Can skip

4. Call: linear issue create --title "..." --priority 3 --assignee self --state started
   → Returns: KAD-4830

5. Call: linear issue view KAD-4830 --json
   → Returns: { title, branchName, ... }

6. Generate branch name from config.branchFormat:
   → "${ticketId}-${slug}" → "KAD-4830-fix-team-invite-email-validation"

7. Allocate ports from PortManager

8. Create worktree:
   git worktree add ~/forest/kadoa-backend/KAD-4830 -b KAD-4830-fix-team-invite-email-validation origin/main

9. Copy files from config.copy:
   cp <mainRepo>/.env ~/forest/kadoa-backend/KAD-4830/.env
   cp <mainRepo>/.env.local ~/forest/kadoa-backend/KAD-4830/.env.local

10. Write .forest.env with port overrides:
    DASHBOARD_PORT=14200
    PUBLIC_API_PORT=14201

11. Generate .code-workspace file (see Section 16)

12. Run config.setup in the worktree:
    cd ~/forest/kadoa-backend/KAD-4830 && bun install --frozen-lockfile

13. Save tree to state

14. Open new VSCode window:
    vscode.commands.executeCommand('vscode.openFolder', Uri.file(workspacePath), { forceNewWindow: true })

15. Refresh sidebar in all windows (via state file change)
```

**If Linear is not available**: Skip steps 2-5. Show input boxes for ticket ID and title manually. Skip `linear issue create`.

### 9.2. `plant` — Tree from Existing Ticket

**Trigger**: Command palette "Forest: Plant", click issue in sidebar, or right-click issue → "Plant".

**Flow**:

```
1. Determine ticket ID:
   a. If triggered from sidebar issue item → use that issue's ID
   b. If triggered from command palette:
      - If Linear available: show quick pick with issues from listMyIssues()
      - Else: show input box "Ticket ID (e.g. KAD-4788)"

2. Fetch issue details:
   linear issue view <ticketId> --json
   → Extract: title, branchName

3. Check if tree already exists in state
   → If yes: show error "Tree for <ticketId> already exists. Switch to it?"
   → Offer: [Switch] [Cancel]

4. Same as Seed steps 6-15 above (but skip ticket creation)

5. Update Linear issue state:
   linear issue update <ticketId> --state started
```

### 9.3. `switch` — Focus Another Tree's Window

**Trigger**: Command palette "Forest: Switch", click tree in sidebar, right-click tree → "Switch".

**Flow**:

```
1. Determine which tree to switch to:
   a. If triggered from sidebar tree item → use that tree
   b. If triggered from command palette → show quick pick of all trees:
      [KAD-4788] Fix invite roles (dev)
      [KAD-4801] New API endpoint (review)

2. Open that tree's VSCode window:
   vscode.commands.executeCommand('vscode.openFolder',
     Uri.file(<tree.path>/<ticketId>.code-workspace),
     { forceNewWindow: true }
   )
```

Note: `vscode.openFolder` with `forceNewWindow: true` will either:
- Focus an already-open window for that workspace, OR
- Open a new window if the workspace isn't open

This is the desired behavior — it works as a "focus or open" operation.

### 9.4. `ship` — Push + PR

**Trigger**: Command palette "Forest: Ship", right-click tree → "Ship".

**Preconditions**:
- Must be run from a tree's VSCode window (the worktree directory)
- If not in a tree window, show error: "Ship must be run from a tree window"

**Flow**:

```
1. Detect current tree from state

2. Check for uncommitted changes:
   git status --porcelain
   → If dirty: show warning "You have uncommitted changes. Commit first?"
   → [Commit All] [Ship Anyway] [Cancel]
   → If "Commit All": prompt for commit message, commit, then continue

3. Push branch:
   git push -u origin <branch>

4. Create PR:
   a. If Linear available:
      linear issue pr <ticketId> --base <config.baseBranch without "origin/">
      → Returns PR URL
   b. Else if GitHub available:
      gh pr create --title "<ticketId>: <title>" --body "..." --base main
   c. Else: show error "No PR tool available"

5. Update Linear state:
   linear issue update <ticketId> --state "In Review"

6. Update tree status in state: "review"

7. Save PR URL to state

8. Show info message: "Shipped! PR: <url>" with [Open PR] button
```

### 9.5. `fell` — Merge + Cleanup

**Trigger**: Command palette "Forest: Fell", right-click tree → "Fell".

**Flow**:

```
1. Detect current tree (from sidebar selection or current window)

2. Show confirmation dialog:
   "Fell KAD-4788: Fix invite roles?

   This will:
   • Merge PR #247 into main (squash)
   • Delete remote branch
   • Remove worktree from disk
   • Move Linear ticket to Done
   • Close this VSCode window

   [Fell] [Cancel]"

3. If confirmed:

4. Check for uncommitted changes:
   → If dirty: show error "Tree has uncommitted changes. Commit or discard first."
   → [Cancel]

5. Merge PR (if GitHub available):
   gh pr merge --squash --delete-branch
   → On failure: show error, abort

6. Update Linear (if available):
   linear issue update <ticketId> --state done

7. Remove worktree:
   (Must be run from MAIN repo, not the worktree being removed)
   git worktree remove <treePath> --force

8. Delete local branch:
   git branch -D <branch>

9. Free ports in PortManager

10. Remove tree from state

11. Close VSCode window:
    vscode.commands.executeCommand('workbench.action.closeWindow')
```

**Important**: Step 7 must run from the main repo path, NOT from the worktree being removed. The `exec` call uses `{ cwd: tree.repoPath }`.

### 9.6. `water` — Refresh Dependencies

**Trigger**: Command palette "Forest: Water", right-click tree → "Water".

**Flow**:

```
1. Detect current tree

2. Re-copy config.copy files from main repo:
   cp <mainRepo>/.env <treePath>/.env
   → Preserve port overrides by re-writing .forest.env after copy

3. Re-run config.setup:
   bun install --frozen-lockfile

4. Show info: "Tree watered. Dependencies refreshed."
```

### 9.7. `survey` — Quick-Pick List of All Trees

**Trigger**: Command palette "Forest: Survey".

**Flow**:

```
1. Load state, get all trees for current repo

2. Show quick pick:
   ● KAD-4788 — Fix invite roles [dev]
   ● KAD-4801 — New API endpoint [review]
   ○ KAD-4823 — Dashboard bug [idle]

   Icons: ● = tree window is open, ○ = window closed

3. On selection: execute forest.switch for that tree
```

---

## 10. Sidebar Views

### 10.1. `IssuesTreeProvider`

Provides the "MY ISSUES" section. Shows Linear issues assigned to the current user that don't yet have a tree.

```typescript
class IssuesTreeProvider implements vscode.TreeDataProvider<IssueItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<IssueItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  // Cache issues to avoid fetching on every UI interaction
  private issues: LinearIssue[] = [];
  private lastFetch: number = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute

  constructor(
    private config: ForestConfig,
    private stateManager: StateManager,
  ) {}

  refresh(): void {
    this.lastFetch = 0; // Invalidate cache
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(): Promise<IssueItem[]> {
    if (!this.config.integrations.linear || !(await linear.isAvailable())) {
      return [];
    }

    // Fetch issues (with caching)
    if (Date.now() - this.lastFetch > this.CACHE_TTL) {
      this.issues = await linear.listMyIssues(['unstarted', 'started', 'backlog']);
      this.lastFetch = Date.now();
    }

    // Filter out issues that already have a tree
    const state = await this.stateManager.load();
    const repoPath = getMainRepoPath();
    const existingTickets = new Set(
      this.stateManager.getTreesForRepo(state, repoPath).map(t => t.ticketId),
    );

    return this.issues
      .filter(issue => !existingTickets.has(issue.id))
      .map(issue => new IssueItem(issue));
  }

  getTreeItem(element: IssueItem): vscode.TreeItem {
    return element;
  }
}
```

### 10.2. `TreesTreeProvider`

Provides the "TREES" section. Shows all active trees for the current repo.

```typescript
class TreesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private config: ForestConfig,
    private stateManager: StateManager,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(): Promise<TreeItem[]> {
    const state = await this.stateManager.load();
    const repoPath = getMainRepoPath();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);

    // Sort: current tree first, then by creation date
    const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    trees.sort((a, b) => {
      if (a.path === currentPath) return -1;
      if (b.path === currentPath) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return trees.map(tree => new TreeItemView(tree, tree.path === currentPath));
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }
}
```

### 10.3. `items.ts` — Tree Item Renderers

```typescript
class IssueItem extends vscode.TreeItem {
  contextValue = 'issue';

  constructor(public readonly issue: LinearIssue) {
    super(`${issue.id}  ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.description = `[${issue.state}]`;
    this.tooltip = new vscode.MarkdownString(
      `**${issue.id}**: ${issue.title}\n\nState: ${issue.state}\n\nClick $(add) to plant a tree`,
    );
    this.iconPath = new vscode.ThemeIcon('circle-outline');

    // Clicking the item plants a tree
    this.command = {
      command: 'forest.plant',
      title: 'Plant Tree',
      arguments: [issue.id],
    };
  }
}

class TreeItemView extends vscode.TreeItem {
  contextValue = 'tree';

  constructor(public readonly tree: TreeState, isCurrent: boolean) {
    super(
      `${tree.ticketId}  ${tree.title}`,
      vscode.TreeItemCollapsibleState.None,
    );

    this.description = `[${tree.status}]`;

    // Visual indicators
    if (isCurrent) {
      this.iconPath = new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('git-branch');
    }

    this.tooltip = new vscode.MarkdownString([
      `**${tree.ticketId}**: ${tree.title}`,
      ``,
      `Branch: \`${tree.branch}\``,
      `Status: ${tree.status}`,
      `Ports: ${tree.portBase}`,
      tree.prUrl ? `PR: [${tree.prUrl}](${tree.prUrl})` : 'PR: none',
    ].join('\n'));

    // Clicking switches to this tree
    if (!isCurrent) {
      this.command = {
        command: 'forest.switch',
        title: 'Switch to Tree',
        arguments: [tree.ticketId],
      };
    }
  }
}
```

---

## 11. Terminal Manager

Manages named terminal tabs within a tree's VSCode window.

```typescript
class TerminalManager {
  private managedTerminals = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private config: ForestConfig,
    private currentTree: TreeState | undefined,
  ) {
    // Track terminal closures
    this.disposables.push(
      vscode.window.onDidCloseTerminal(terminal => {
        this.handleTerminalClose(terminal);
      }),
    );
  }

  /**
   * Ensure all configured terminals exist.
   * Called on activation when the window is a tree.
   */
  async ensureConfiguredTerminals(): Promise<void> {
    if (!this.currentTree) return;

    // Check which terminals already exist (from previous session)
    const existing = new Set(vscode.window.terminals.map(t => t.name));

    for (const termConfig of this.config.terminals) {
      const name = `[Forest] ${termConfig.name}`;

      if (existing.has(name)) {
        // Terminal already exists (restored from previous session)
        const terminal = vscode.window.terminals.find(t => t.name === name);
        if (terminal) this.managedTerminals.set(termConfig.name, terminal);
        continue;
      }

      this.createTerminal(termConfig);
    }
  }

  /**
   * Create a single terminal from config.
   */
  private createTerminal(termConfig: TerminalConfig): vscode.Terminal {
    // Build environment with port variables
    const env: Record<string, string> = { ...termConfig.env };
    if (this.currentTree && this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        env[key] = this.resolvePortVars(value);
      }
    }

    const terminal = vscode.window.createTerminal({
      name: `[Forest] ${termConfig.name}`,
      cwd: this.currentTree?.path,
      env,
      iconPath: new vscode.ThemeIcon('terminal'),
    });

    if (termConfig.autostart && termConfig.command) {
      terminal.sendText(termConfig.command);
    }

    this.managedTerminals.set(termConfig.name, terminal);
    return terminal;
  }

  /**
   * Handle terminal close events.
   * If an autostart terminal died, offer to restart.
   */
  private handleTerminalClose(terminal: vscode.Terminal): void {
    // Find which managed terminal this was
    for (const [name, managed] of this.managedTerminals) {
      if (managed === terminal) {
        this.managedTerminals.delete(name);

        // Check if it was an autostart terminal
        const termConfig = this.config.terminals.find(t => t.name === name);
        if (termConfig?.autostart) {
          vscode.window
            .showWarningMessage(
              `Terminal "${name}" exited. Restart?`,
              'Restart',
              'Ignore',
            )
            .then(choice => {
              if (choice === 'Restart') {
                this.createTerminal(termConfig);
              }
            });
        }
        break;
      }
    }
  }

  /**
   * Resolve ${ports.xxx} variables in a string.
   */
  private resolvePortVars(value: string): string {
    if (!this.currentTree) return value;
    return value.replace(/\$\{ports\.(\w+)\}/g, (_, name) => {
      const offset = parseInt(this.config.ports.mapping[name]?.replace('+', '') ?? '0');
      return String(this.currentTree!.portBase + offset);
    });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
```

---

## 12. Browser Manager

Opens browser tabs inside VSCode for configured URLs.

```typescript
class BrowserManager {
  constructor(
    private config: ForestConfig,
    private currentTree: TreeState | undefined,
  ) {}

  /**
   * Open all configured browser tabs.
   * Called on activation when the window is a tree.
   */
  async openConfiguredBrowsers(): Promise<void> {
    if (!this.currentTree) return;
    if (!this.config.browsers?.length) return;

    for (const browserConfig of this.config.browsers) {
      const url = this.resolveUrl(browserConfig.url);

      if (browserConfig.waitForPort) {
        // Wait for the port to be available before opening
        const port = this.extractPort(url);
        if (port) {
          const timeout = (browserConfig.waitTimeout ?? 120) * 1000;
          this.waitForPortAndOpen(port, url, timeout);
        }
      } else {
        await this.openBrowser(url);
      }
    }
  }

  /**
   * Wait for a port to accept connections, then open the browser.
   */
  private async waitForPortAndOpen(
    port: number,
    url: string,
    timeout: number,
  ): Promise<void> {
    const start = Date.now();
    const interval = 2000; // Check every 2 seconds

    const check = async (): Promise<void> => {
      if (Date.now() - start > timeout) {
        vscode.window.showWarningMessage(
          `Timed out waiting for port ${port}. Open manually?`,
          'Open Anyway',
        ).then(choice => {
          if (choice) this.openBrowser(url);
        });
        return;
      }

      try {
        await exec(`nc -z localhost ${port}`, { timeout: 2000 });
        // Port is open
        await this.openBrowser(url);
      } catch {
        // Port not ready yet, retry
        setTimeout(check, interval);
      }
    };

    check();
  }

  /**
   * Open a URL in VSCode's integrated browser.
   */
  private async openBrowser(url: string): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        'simpleBrowser.api.open',
        vscode.Uri.parse(url),
        {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: true,
        },
      );
    } catch {
      // Fallback: open in external browser
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  /**
   * Resolve ${ports.xxx} variables in URL.
   */
  private resolveUrl(url: string): string {
    if (!this.currentTree) return url;
    return url.replace(/\$\{ports\.(\w+)\}/g, (_, name) => {
      const offset = parseInt(this.config.ports.mapping[name]?.replace('+', '') ?? '0');
      return String(this.currentTree!.portBase + offset);
    });
  }

  /**
   * Extract port number from a URL.
   */
  private extractPort(url: string): number | null {
    const match = url.match(/:(\d+)/);
    return match ? parseInt(match[1]) : null;
  }
}
```

---

## 13. Port Manager

Allocates non-overlapping port ranges for trees.

```typescript
class PortManager {
  constructor(
    private config: ForestConfig,
    private stateManager: StateManager,
  ) {}

  /**
   * Allocate the next available base port.
   * Each tree needs a contiguous range of ports:
   *   basePort + 0, basePort + 1, ..., basePort + maxOffset
   *
   * The range between ports must be >= maxOffset + 1 to avoid overlap.
   */
  async allocate(repoPath: string): Promise<number> {
    const state = await this.stateManager.load();
    const trees = this.stateManager.getTreesForRepo(state, repoPath);
    const usedBases = new Set(trees.map(t => t.portBase));

    const [rangeStart, rangeEnd] = this.config.ports.baseRange;
    const maxOffset = this.getMaxOffset();
    const step = maxOffset + 1; // Minimum gap between base ports

    // Find first available slot
    for (let base = rangeStart; base + maxOffset <= rangeEnd; base += step) {
      if (!usedBases.has(base)) {
        return base;
      }
    }

    throw new Error(
      `No available ports in range [${rangeStart}, ${rangeEnd}]. ` +
      `${trees.length} trees active. Fell some trees to free ports.`,
    );
  }

  /**
   * Get the maximum offset from port mapping.
   */
  private getMaxOffset(): number {
    const offsets = Object.values(this.config.ports.mapping)
      .map(v => parseInt(v.replace('+', '')));
    return Math.max(...offsets, 0);
  }

  /**
   * Resolve all named ports for a given base.
   */
  resolvePorts(base: number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, offsetStr] of Object.entries(this.config.ports.mapping)) {
      const offset = parseInt(offsetStr.replace('+', ''));
      result[name] = base + offset;
    }
    return result;
  }
}
```

---

## 14. Status Bar

Shows the current tree name and process health in the bottom status bar.

```typescript
class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor(private currentTree: TreeState | undefined) {
    this.item = vscode.window.createStatusBarItem(
      'forest.tree',
      vscode.StatusBarAlignment.Left,
      100,
    );
  }

  show(): void {
    if (!this.currentTree) return;

    this.item.text = `$(git-branch) ${this.currentTree.ticketId}`;
    this.item.tooltip = `${this.currentTree.ticketId}: ${this.currentTree.title}\nStatus: ${this.currentTree.status}\nClick to survey all trees`;
    this.item.command = 'forest.survey';

    // Color based on status
    switch (this.currentTree.status) {
      case 'dev':
        this.item.backgroundColor = undefined; // default
        break;
      case 'review':
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }

    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

For visually distinguishing trees, the **workspace color customization** in the generated `.code-workspace` file is more effective than the status bar (see Section 16).

---

## 15. Cross-Window State Sync

All Forest extension instances watch `~/.forest/state.json` for changes.

```typescript
class StateManager {
  private statePath: string;
  private watcher: vscode.FileSystemWatcher | undefined;
  private _onDidChange = new vscode.EventEmitter<ForestState>();
  readonly onDidChange = this._onDidChange.event;

  constructor(context: vscode.ExtensionContext) {
    const forestDir = path.join(os.homedir(), '.forest');
    this.statePath = path.join(forestDir, 'state.json');
  }

  async initialize(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create state file if it doesn't exist
    if (!fs.existsSync(this.statePath)) {
      await this.save({ version: 1, trees: {} });
    }

    // Watch for changes from other windows
    // Use a polling-based approach since FileSystemWatcher
    // requires the file to be within a workspace folder.
    // Instead, use node's fs.watch which works on any path.
    this.startWatching();
  }

  private startWatching(): void {
    let lastContent = '';

    // fs.watch is more reliable than VSCode's FileSystemWatcher
    // for files outside the workspace
    const watcher = fs.watch(this.statePath, async () => {
      try {
        const content = fs.readFileSync(this.statePath, 'utf8');
        if (content !== lastContent) {
          lastContent = content;
          const state = JSON.parse(content);
          this._onDidChange.fire(state);
        }
      } catch {
        // File might be mid-write, ignore
      }
    });

    // Initial read
    try {
      lastContent = fs.readFileSync(this.statePath, 'utf8');
    } catch {}
  }

  // ... load, save, addTree, removeTree, updateTree, getTreesForRepo methods ...
}
```

**Important**: VSCode's `createFileSystemWatcher` only watches files within workspace folders. Since `~/.forest/state.json` is outside any workspace, we use Node's native `fs.watch` instead.

---

## 16. Workspace File Generation

Each tree gets a `.code-workspace` file that configures VSCode for that tree.

```typescript
function generateWorkspaceFile(
  treePath: string,
  ticketId: string,
  title: string,
  portBase: number,
  config: ForestConfig,
): void {
  const color = ticketToColor(ticketId);

  const workspace = {
    folders: [{ path: '.' }],
    settings: {
      // Window title shows ticket ID and title
      'window.title': `${ticketId}: ${title} — \${activeEditorShort}`,
      'window.titleBarStyle': 'custom',

      // Unique color per tree (title bar + status bar)
      'workbench.colorCustomizations': {
        'titleBar.activeBackground': color,
        'titleBar.activeForeground': '#ffffff',
        'titleBar.inactiveBackground': darken(color, 0.3),
        'titleBar.inactiveForeground': '#cccccc',
        'statusBar.background': color,
        'statusBar.foreground': '#ffffff',
      },
    },
  };

  const filePath = path.join(treePath, `${ticketId}.code-workspace`);
  fs.writeFileSync(filePath, JSON.stringify(workspace, null, 2));
}
```

### Color Generation

```typescript
/**
 * Generate a deterministic HSL color from a ticket ID.
 * Uses a hash to distribute colors evenly around the hue wheel.
 * Saturation and lightness are fixed for readability on dark/light themes.
 */
function ticketToColor(ticketId: string): string {
  let hash = 0;
  for (let i = 0; i < ticketId.length; i++) {
    hash = ((hash << 5) - hash + ticketId.charCodeAt(i)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  const saturation = 50;  // Muted enough for a title bar
  const lightness = 30;   // Dark enough for white text

  return hslToHex(hue, saturation, lightness);
}

/**
 * Darken a hex color by a factor (0-1).
 */
function darken(hex: string, factor: number): string {
  // Convert hex to RGB, multiply each channel by (1 - factor), convert back
  // Implementation omitted for brevity — standard color math
}
```

---

## 17. Error Handling

### General Principles

- All CLI calls are wrapped in try/catch
- CLI failures show `vscode.window.showErrorMessage` with the stderr output
- Missing CLIs (linear, gh) degrade gracefully — features that need them are disabled
- File system errors (permissions, disk full) show user-friendly messages
- Network errors (git push, PR creation) retry once, then show error with retry button

### Specific Error Scenarios

| Scenario | Handling |
|----------|----------|
| `.forest/config.json` missing | Extension stays inert. No sidebar, no commands. |
| `.forest/config.json` invalid JSON | Show error on activation: "Forest config is invalid: <parse error>" |
| `linear` CLI not on PATH | Set `forest.linearEnabled` = false. Issues section hidden. Seed/Plant work without Linear. |
| `gh` CLI not on PATH | Ship uses `linear issue pr` instead. Fell shows error if no merge tool available. |
| Port range exhausted | Show error: "No ports available. Fell some trees." |
| Worktree creation fails (branch exists) | Show error with option to delete existing branch: "Branch already exists. Delete and recreate?" |
| Worktree creation fails (path exists) | Show error: "Directory already exists at <path>. Remove it first?" |
| `bun install` fails in setup | Show error with stderr. Tree is still created — user can fix and run `water`. |
| State file corrupted | Reset to `{ version: 1, trees: {} }`. Warn user: "State was corrupted and has been reset." Existing worktrees on disk are not affected. |
| Fell with uncommitted changes | Refuse. Show error: "Commit or discard changes before felling." |
| Fell when PR has failing checks | Show warning: "PR has failing checks. Fell anyway?" |

---

## 18. Build & Distribution

### esbuild.js

```javascript
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    treeShaking: true,
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
```

### package.json scripts

```json
{
  "scripts": {
    "vscode:prepublish": "npm run package",
    "compile": "npm run check-types && node esbuild.js",
    "watch": "npm-run-all -p watch:*",
    "watch:esbuild": "node esbuild.js --watch",
    "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
    "package": "npm run check-types && node esbuild.js --production",
    "check-types": "tsc --noEmit",
    "lint": "eslint src --ext ts",
    "test": "node ./out/test/runTest.js"
  }
}
```

### .vscodeignore

```
.vscode/**
.vscode-test/**
src/**
test/**
.gitignore
.eslintrc.json
*.map
**/*.ts
!dist/**
node_modules/**
esbuild.js
tsconfig.json
PLAN.md
```

### Local Development

```bash
# 1. Open the forest project in VSCode
code /Users/vlad/Code/forest

# 2. Press F5 to launch Extension Development Host
#    This opens a new VSCode window with the extension loaded

# 3. In the dev host window, open a repo that has .forest/config.json

# 4. The Forest sidebar should appear
```

### Packaging

```bash
# Install vsce
npm install -g @vscode/vsce

# Build and package
npm run package
vsce package
# Creates: forest-0.1.0.vsix

# Install locally
code --install-extension forest-0.1.0.vsix
```

---

## 19. Testing Strategy

### Unit Tests (pure logic, no VSCode API)

| File | Tests |
|------|-------|
| `config.test.ts` | Config loading, merging, validation, default values, ~ expansion |
| `state.test.ts` | State CRUD, atomic writes, concurrent access simulation |
| `portManager.test.ts` | Port allocation, exhaustion, freeing, gap filling |
| `colors.test.ts` | Deterministic color generation, hex format, darken function |
| `slug.test.ts` | Slugification edge cases (unicode, long strings, special chars) |
| `cli/git.test.ts` | Output parsing for `worktree list --porcelain` |
| `cli/linear.test.ts` | JSON parsing from `linear issue view/list`, error handling |

### Integration Tests (require VSCode API)

Run via `@vscode/test-electron`:

| Test | What it verifies |
|------|-----------------|
| Activation test | Extension activates when `.forest/config.json` exists |
| Inert test | Extension does NOT activate without config |
| Sidebar test | Tree views register correctly |
| Command test | All commands are registered and callable |

### Manual Testing Checklist

Before each release:

- [ ] `Seed`: creates Linear ticket + worktree + opens new window
- [ ] `Plant`: picks from issue list + creates worktree + opens new window
- [ ] New window: terminals auto-start, browser opens after port ready
- [ ] Sidebar: shows issues and trees in both windows
- [ ] `Switch`: click tree in sidebar → other window focuses
- [ ] `Ship`: pushes branch, creates PR, Linear moves to "In Review"
- [ ] `Fell`: merges PR, removes worktree, closes window, Linear moves to "Done"
- [ ] `Water`: reinstalls deps, re-copies env files
- [ ] Process persistence: switch windows → terminals in both keep running
- [ ] Terminal crash: autostart terminal dies → restart prompt appears
- [ ] No Linear: disable in config → issues section hidden, plant works with manual ID
- [ ] No GitHub: disable in config → ship warns, fell shows error
- [ ] Port exhaustion: create maxTrees trees → next plant shows error
- [ ] Config validation: invalid config → error message on activation

---

## 20. File-by-File Specification

This section lists every file to create with a brief description of its content and responsibilities.

### `src/extension.ts`
- Entry point. Exports `activate()` and `deactivate()`.
- Loads config, initializes state manager, detects current tree.
- Registers sidebar providers, commands, and managers.
- If current window is a tree: starts terminals, opens browsers, shows status bar.
- Sets up state file watcher for cross-window sync.
- All disposables pushed to `context.subscriptions`.

### `src/config.ts`
- Exports `ForestConfig` interface and `loadConfig()` function.
- Reads `.forest/config.json` from workspace root.
- Reads `.forest/local.json` if it exists.
- Deep merges local into config (terminals merged by name).
- Resolves `~` to home directory in `treesDir`.
- Validates all fields. Returns `null` if config doesn't exist.
- Exports `TerminalConfig` and `BrowserConfig` sub-interfaces.

### `src/state.ts`
- Exports `StateManager` class and `ForestState` / `TreeState` interfaces.
- Manages `~/.forest/state.json`.
- Uses `fs.watch` for change detection (cross-window).
- Atomic writes via temp file + rename.
- Methods: `load`, `save`, `addTree`, `removeTree`, `updateTree`, `getTreesForRepo`, `getTree`.
- Fires `onDidChange` event when file changes.

### `src/context.ts`
- Exports `ForestContext` interface bundling config, state, managers, providers.
- Utility function `getMainRepoPath()` — returns the path of the main git repo (not the worktree).
  - If current workspace is a worktree: reads `.git` file to find main repo.
  - If current workspace is the main repo: returns workspace path.

### `src/views/IssuesTreeProvider.ts`
- Implements `vscode.TreeDataProvider<IssueItem>`.
- Fetches issues from `linear issue list` with 60s cache.
- Filters out issues that already have a tree.
- Returns `IssueItem` instances.
- `refresh()` invalidates cache and fires change event.

### `src/views/TreesTreeProvider.ts`
- Implements `vscode.TreeDataProvider<TreeItemView>`.
- Reads trees from state for the current repo.
- Sorts: current tree first, then newest first.
- Returns `TreeItemView` instances with appropriate icons.
- `refresh()` fires change event.

### `src/views/items.ts`
- `IssueItem` class extending `vscode.TreeItem`.
  - Shows ticket ID + title, state as description.
  - `contextValue = 'issue'` for context menu filtering.
  - Click command: `forest.plant` with issue ID argument.
- `TreeItemView` class extending `vscode.TreeItem`.
  - Shows ticket ID + title, status as description.
  - Green arrow icon if current tree, git-branch icon otherwise.
  - `contextValue = 'tree'` for context menu filtering.
  - Click command: `forest.switch` with ticket ID argument.

### `src/managers/TerminalManager.ts`
- Creates named terminals from config on activation.
- Prefixes terminal names with `[Forest]` for identification.
- Tracks managed terminals in a Map.
- Watches `onDidCloseTerminal` — if autostart terminal dies, prompts restart.
- Resolves `${ports.xxx}` variables in terminal env.
- `ensureConfiguredTerminals()` — idempotent, skips already-existing terminals.

### `src/managers/BrowserManager.ts`
- Opens browser tabs from config on activation.
- Resolves `${ports.xxx}` in URLs.
- If `waitForPort: true`, polls with `nc -z` until port accepts connections.
- Uses `simpleBrowser.api.open` for VSCode integrated browser.
- Falls back to `vscode.env.openExternal` if simple browser unavailable.
- Configurable timeout for port waiting.

### `src/managers/PortManager.ts`
- Allocates base ports from the configured range.
- Each tree gets a base port. Individual ports are base + offset.
- Step between base ports = max offset + 1 (prevents overlap).
- `allocate()` finds first unused base port.
- `resolvePorts()` returns `{ name: port }` mapping for a given base.

### `src/managers/StatusBarManager.ts`
- Creates a left-aligned status bar item.
- Shows ticket ID with git-branch icon.
- Tooltip shows full ticket title and status.
- Click triggers `forest.survey`.
- Background color changes for `review` status (warning color).

### `src/commands/seed.ts`
- Full flow: input title → optional priority/label → `linear issue create` → worktree → env copy → setup → workspace file → open window.
- Graceful degradation without Linear (manual ticket ID + title input).
- Shows progress notification during setup.

### `src/commands/plant.ts`
- Accepts optional ticket ID argument (from sidebar click).
- If no argument: shows quick pick of issues (Linear) or input box (no Linear).
- Checks for existing tree with same ticket ID.
- Creates worktree from `config.baseBranch`.
- Updates Linear state to "started".
- Same setup flow as seed (env, ports, workspace, open).

### `src/commands/switch.ts`
- Accepts optional ticket ID argument.
- If no argument: shows quick pick of all trees.
- Opens target tree's `.code-workspace` in new window.

### `src/commands/ship.ts`
- Must run from a tree window.
- Checks for uncommitted changes (warns but allows proceeding).
- Pushes branch with `-u`.
- Creates PR via `linear issue pr` or `gh pr create`.
- Updates Linear state to "In Review".
- Updates tree status to "review" in state.

### `src/commands/fell.ts`
- Shows detailed confirmation dialog.
- Refuses if uncommitted changes exist.
- Merges PR via `gh pr merge --squash --delete-branch`.
- Updates Linear state to "done".
- Removes worktree via `git worktree remove --force` (from main repo cwd).
- Deletes local branch.
- Removes tree from state.
- Closes current VSCode window.

### `src/commands/water.ts`
- Re-copies `config.copy` files from main repo.
- Re-writes `.forest.env` with port overrides.
- Re-runs `config.setup` command.
- Shows progress notification.

### `src/commands/survey.ts`
- Shows quick pick of all trees for current repo.
- Each item shows: ticket ID, title, status, port base.
- Active tree is marked with a star.
- Selection triggers `forest.switch`.

### `src/cli/linear.ts`
- Thin wrapper over `linear` CLI.
- Functions: `isAvailable`, `listMyIssues`, `getIssue`, `createIssue`, `updateIssueState`, `createPR`, `getIssueUrl`.
- All functions handle CLI parsing and error formatting.
- Timeout: 15s for list/create, 10s for view/update, 30s for PR creation.

### `src/cli/gh.ts`
- Thin wrapper over `gh` CLI.
- Functions: `isAvailable`, `mergePR`, `getPRUrl`, `getPRStatus`.
- Runs from worktree cwd so `gh` detects the correct repo.

### `src/cli/git.ts`
- Functions: `createWorktree`, `removeWorktree`, `listWorktrees`, `deleteBranch`, `pushBranch`, `hasUncommittedChanges`, `getMainRepoPath`.
- `createWorktree` fetches first, then creates worktree with `-b` from base ref.
- `removeWorktree` uses `--force` flag.
- `listWorktrees` parses `--porcelain` output.

### `src/utils/exec.ts`
- `exec(command, opts)` — promisified child_process.exec with timeout and maxBuffer.
- `commandExists(name)` — checks if command is on PATH.

### `src/utils/ports.ts`
- Standalone port utility: `isPortOpen(port)` — uses `net.createConnection` to check if a port accepts connections. Used by BrowserManager for port waiting.

### `src/utils/colors.ts`
- `ticketToColor(ticketId)` — deterministic hash → HSL → hex.
- `darken(hex, factor)` — darkens a color for inactive title bar.
- `hslToHex(h, s, l)` — color space conversion.

### `src/utils/slug.ts`
- `slugify(title)` — converts "Fix team invite email validation" to "fix-team-invite-email-validation".
- Lowercases, replaces spaces with hyphens, removes non-alphanumeric chars, truncates to 50 chars.

### `resources/forest.svg`
- Monochrome SVG icon (24x24) for the activity bar.
- Simple tree silhouette. Single color (will be themed by VSCode).

### `.vscode/launch.json`
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```

### `.vscode/tasks.json`
```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "watch",
      "problemMatcher": ["$tsc-watch", "$esbuild-watch"],
      "isBackground": true,
      "presentation": { "reveal": "never" },
      "group": { "kind": "build", "isDefault": true }
    },
    {
      "type": "npm",
      "script": "compile",
      "problemMatcher": ["$tsc", "$esbuild"],
      "group": "build"
    }
  ]
}
```

---

## Appendix A: `.forest/config.json` for kadoa-backend

Example config to add to the kadoa-backend repo:

```jsonc
{
  "version": 1,
  "treesDir": "~/forest/${repo}",
  "copy": [".env", ".env.local"],
  "setup": "bun install --frozen-lockfile",
  "terminals": [
    { "name": "dev", "command": "bunx turbo dev", "autostart": true },
    { "name": "claude", "command": "claude", "autostart": true },
    { "name": "shell", "autostart": false }
  ],
  "browsers": [
    {
      "name": "Dashboard",
      "url": "http://localhost:${ports.dashboard}",
      "waitForPort": true,
      "waitTimeout": 120
    }
  ],
  "ports": {
    "baseRange": [14000, 15000],
    "mapping": {
      "dashboard": "+0",
      "publicApi": "+1",
      "customApi": "+2",
      "scraperApi": "+3",
      "observerApi": "+4",
      "operationsApi": "+5",
      "mappingApi": "+6",
      "crawlerApi": "+7",
      "dataValidationApi": "+8",
      "engineApi": "+9",
      "realtimeApi": "+10",
      "eventGateway": "+11"
    }
  },
  "env": {
    "DASHBOARD_PORT": "${ports.dashboard}",
    "PUBLIC_API_PORT": "${ports.publicApi}",
    "CUSTOM_API_PORT": "${ports.customApi}",
    "SCRAPER_API_PORT": "${ports.scraperApi}",
    "OBSERVER_API_PORT": "${ports.observerApi}",
    "OPERATIONS_API_PORT": "${ports.operationsApi}",
    "MAPPING_API_PORT": "${ports.mappingApi}",
    "CRAWLER_API_PORT": "${ports.crawlerApi}",
    "DATA_VALIDATION_API_PORT": "${ports.dataValidationApi}",
    "ENGINE_API_PORT": "${ports.engineApi}",
    "REALTIME_API_PORT": "${ports.realtimeApi}",
    "EVENT_GATEWAY_PORT": "${ports.eventGateway}"
  },
  "integrations": {
    "linear": true,
    "github": true
  },
  "branchFormat": "${ticketId}-${slug}",
  "baseBranch": "origin/main",
  "maxTrees": 10
}
```

## Appendix B: Process Persistence Guarantee

**Why processes persist across switches:**

1. Each VSCode window is an independent OS process (Electron instance).
2. Terminals within a window are child processes of that window's Electron process.
3. Switching focus between windows (via `forest.switch` or Cmd+\`) only changes which window is in the foreground.
4. No window is closed, minimized, or suspended during a switch.
5. The `vscode.openFolder` command with `forceNewWindow: true` either:
   - Focuses an already-open window for that workspace (no restart), OR
   - Opens a new window (does not close any existing window).

**The only way processes die:**
- User manually closes a VSCode window (Cmd+W on last editor tab, or Cmd+Q)
- System kills the process (OOM, crash)
- User explicitly disposes a terminal

**Mitigation for window close:**
When a window reopens (user runs `forest.switch` for a tree whose window was closed), the extension activates and `TerminalManager.ensureConfiguredTerminals()` recreates any missing autostart terminals. The user loses terminal history but processes are restarted automatically.

## Appendix C: Why Not Symlink node_modules

Research shows that symlinking `node_modules` from the main repo into worktrees is unreliable:

1. **Branches diverge in dependencies** — different branches may have different package versions in the lockfile.
2. **Bun-specific issues** — Bun has known bugs with symlinked workspace packages (oven-sh/bun#25801).
3. **Turbo monorepo** — internal workspace package symlinks inside `node_modules` point to absolute paths that break when symlinked from a different root.
4. **Post-install scripts** — may reference wrong paths.

**Decision**: Each worktree runs `bun install` independently via the `setup` command. This costs ~30s and ~2.7GB disk per tree, but is reliable. The `maxTrees` config (default: 10) bounds total disk usage to ~27GB.

**Future optimization**: Add a `"symlinks": ["node_modules"]` option for users who know their branches share identical dependencies. This would be opt-in and documented as "use at your own risk".
