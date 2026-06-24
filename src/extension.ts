import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { clearTreesDirCache, loadConfig, getTreesDir, allShortcuts, resolveTetraConfig } from "./config";
import {
	ShortcutItem,
	ShortcutsTreeProvider,
} from "./views/ShortcutsTreeProvider";
import { TodoItem, TodosTreeProvider } from "./views/TodosTreeProvider";
import { StateManager, type ForestState } from "./state";
import { ForestContext, getHostWorkspacePath, getRepoPath } from "./context";
import { ShortcutManager } from "./managers/ShortcutManager";
import { StatusBarManager } from "./managers/StatusBarManager";
import { ForestWebviewProvider } from "./views/ForestWebviewProvider";
import { parseTreeKey, TreeDataService } from "./views/treeData";
import { create as createWizard, start } from "./commands/create";
import { linkTicket } from "./commands/linkTicket";
import { switchTree } from "./commands/switch";
import { ship } from "./commands/ship";
import * as ai from "./cli/ai";
import { cleanupMerged, deleteTree } from "./commands/cleanup";
import { update, rebase, pull, push } from "./commands/update";
import { list } from "./commands/list";
import {
	deleteWorkspaceFiles,
	focusOrOpenWindow,
	openTreeWindow,
} from "./commands/shared";
import * as gh from "./cli/gh";
import * as linear from "./cli/linear";
import { notify } from "./notify";
import { gcForestFiles } from "./utils/gc";

const emptyProvider: vscode.TreeDataProvider<never> = {
	getTreeItem: () => {
		throw new Error("no items");
	},
	getChildren: () => [],
};

export async function activate(context: vscode.ExtensionContext) {
	clearTreesDirCache();
	gh.clearCache();
	linear.clearCache();
	const config = await loadConfig();
	if (!config) {
		context.subscriptions.push(
			vscode.window.registerTreeDataProvider("forest.setup", emptyProvider),
			vscode.commands.registerCommand("forest.copySetupPrompt", () => {
				vscode.env.clipboard.writeText(
					"Set up Forest (https://github.com/vladstudio/forest) for this project. Interview me and create .forest/config.json with the required configuration.",
				);
				vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Copied to clipboard",
					},
					() => new Promise((resolve) => setTimeout(resolve, 3000)),
				);
			}),
		);
		return;
	}

	vscode.commands.executeCommand("setContext", "forest.active", true);
	// When GitHub integration is disabled, keep the full UI active without requiring gh.
	const ghReady = !config.github.enabled || (await gh.isAvailable());
	vscode.commands.executeCommand("setContext", "forest.ghAvailable", ghReady);
	if (!ghReady) {
		context.subscriptions.push(
			vscode.window.registerTreeDataProvider("forest.ghMissing", emptyProvider),
		);
		return;
	}
	linear.configure(config.linear.apiKey);
	const linearReady = config.linear.enabled && linear.isAvailable();
	const showTodos = linearReady && !!config.linear.showTodos;
	vscode.commands.executeCommand(
		"setContext",
		"forest.linearEnabled",
		linearReady,
	);
	vscode.commands.executeCommand(
		"setContext",
		"forest.showTodos",
		showTodos,
	);
	vscode.commands.executeCommand(
		"setContext",
		"forest.multipleBrowsers",
		config.browser.length > 1,
	);
	vscode.commands.executeCommand(
		"setContext",
		"forest.multipleTerminals",
		config.terminal.length > 1,
	);
	const repoPath = getRepoPath();
	const outputChannel = vscode.window.createOutputChannel("Forest");

	// Validate Linear config statuses against actual workflow states
	if (linearReady && config.linear.teams?.length) {
		linear
			.validateStatuses(config.linear.statuses, config.linear.teams)
			.then((problems) => {
				if (!problems.length) return;
				vscode.window
					.showWarningMessage(
						`Forest config: ${problems.join(". ")}`,
						"Open Config",
					)
					.then((action) => {
						if (action === "Open Config") {
							vscode.workspace
								.openTextDocument(path.join(repoPath, ".forest", "config.json"))
								.then((doc) => vscode.window.showTextDocument(doc));
						}
					});
			})
			.catch((e) => outputChannel.appendLine(`[Forest] Linear config validation failed: ${e.message}`));
	}

	// Warn once if `tetra` is configured but Tetra isn't reachable — users
	// who opt into AI would otherwise see silent fallbacks.
	if (config.tetra) {
		const tetra = resolveTetraConfig(config.tetra);
		ai.isAvailable(tetra.port).then((ok) => {
			if (ok) return;
			vscode.window.showWarningMessage(
				`Forest: Tetra isn't reachable on localhost:${tetra.port}. AI features will fall back to defaults.`,
			);
		});
	}

	// Watch config files for external edits
	const configWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(
			path.join(repoPath, ".forest"),
			"{config,local}.json",
		),
	);
	let configDebounce: ReturnType<typeof setTimeout> | undefined;
	let configNotificationVisible = false;
	const onConfigChange = () => {
		clearTimeout(configDebounce);
		configDebounce = setTimeout(() => {
			if (configNotificationVisible) return;
			configNotificationVisible = true;
			vscode.window
				.showInformationMessage(
					"Forest config changed. Reload to apply?",
					"Reload Window",
				)
				.then((action) => {
					configNotificationVisible = false;
					if (action === "Reload Window")
						vscode.commands.executeCommand("workbench.action.reloadWindow");
				});
		}, 500);
	};
	configWatcher.onDidChange(onConfigChange);
	configWatcher.onDidCreate(onConfigChange);
	configWatcher.onDidDelete(onConfigChange);
	context.subscriptions.push(configWatcher, {
		dispose: () => clearTimeout(configDebounce),
	});

	const stateManager = new StateManager();
	await stateManager.initialize();

	const { postPruneState, pruneOrphans } = await reconcileState(
		repoPath,
		stateManager,
		outputChannel,
	);
	gcForestFiles(postPruneState, (msg) => outputChannel.appendLine(`[Forest] ${msg}`));

	// Detect if current workspace is a tree (reuse state after pruning).
	// getHostWorkspacePath maps remote (dev container) workspace URIs back to the host tree path.
	const curPath = getHostWorkspacePath();
	const currentTree = curPath
		? Object.values(postPruneState.trees).find((t) => t.path === curPath)
		: undefined;
	vscode.commands.executeCommand("setContext", "forest.isTree", !!currentTree);

	const shortcutManager = new ShortcutManager(config);
	const statusBarManager = new StatusBarManager(currentTree);
	const treeData = new TreeDataService(
		stateManager,
		config,
		() => repoPath,
		(msg) => outputChannel.appendLine(`[Forest] ${msg}`),
	);
	context.subscriptions.push(treeData);
	const forestProvider = new ForestWebviewProvider(
		stateManager,
		config,
		context.extensionUri,
		treeData,
	);
	const shortcutsProvider = new ShortcutsTreeProvider(config);
	const todosProvider = showTodos ? new TodosTreeProvider(config, outputChannel) : undefined;
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("forest.trees", forestProvider),
		vscode.window.registerTreeDataProvider(
			"forest.shortcuts",
			shortcutsProvider,
		),
	);
	if (todosProvider) {
		context.subscriptions.push(
			vscode.window.registerTreeDataProvider("forest.todos", todosProvider),
		);
	}

	// Update noTrees context
	const updateNoTrees = async () => {
		const s = await stateManager.load();
		const trees = stateManager.getTreesForRepo(s, repoPath);
		vscode.commands.executeCommand(
			"setContext",
			"forest.noTrees",
			trees.length === 0,
		);
	};
	updateNoTrees().catch((e) => outputChannel.appendLine(`[Forest] noTrees update failed: ${e.message}`));

	const ctx: ForestContext = {
		config,
		repoPath,
		stateManager,
		shortcutManager,
		statusBarManager,
		forestProvider,
		todosProvider,
		outputChannel,
		currentTree,
	};
	forestProvider.setContext(ctx);
	treeData.startAutoRefresh();

	// Pre-warm tree data cache so the sidebar renders instantly on first open.
	forestProvider.refresh();

	// Pre-warm todos list
	todosProvider?.refresh();

	// Warm the automerge detection cache so the ship buttons render correctly without a network wait.
	if (config.github.enabled) {
		gh.repoHasAutomerge(repoPath)
			.then(() => forestProvider.refresh())
			.catch((e) => outputChannel.appendLine(`[Forest] Automerge warmup failed: ${e.message}`));
	}

	registerCommands(context, ctx, outputChannel);

	// Refresh when window gains focus (cross-window coordination)
	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((e) => {
			if (e.focused) {
				forestProvider.refresh();
				todosProvider?.refresh();
			}
		}),
	);

	// If this is a tree window, run onNewTree shortcuts and show tree-specific UI.
	// For dev-container trees, VS Code first activates locally, then reloads into the
	// container — gate on env match so we don't show/run anything during the brief
	// pre-attach local activation that gets thrown away.
	if (currentTree) {
		const wsScheme = vscode.workspace.workspaceFolders?.[0]?.uri.scheme;
		const isRemoteWs = !!wsScheme && wsScheme !== "file";
		const expectingRemote = !!currentTree.useDevcontainer;
		if (isRemoteWs === expectingRemote) {
			statusBarManager.show();
			if (currentTree.needsSetup) {
				shortcutManager.openNewTreeShortcuts();
				await stateManager.updateTree(repoPath, currentTree.branch, {
					needsSetup: undefined,
				});
			}
			vscode.commands.executeCommand("forest.trees.focus");
		}
	}

	// Helper: setInterval with a guard flag to prevent overlapping runs
	const guardedInterval = (label: string, fn: () => Promise<void>, ms: number) => {
		let running = false;
		const id = setInterval(async () => {
			if (running) return;
			running = true;
			try {
				await fn();
			} catch (e: any) {
				outputChannel.appendLine(`[Forest] ${label} failed: ${e.message}`);
			} finally {
				running = false;
			}
		}, ms);
		return { dispose: () => clearInterval(id) };
	};

	// Auto-cleanup notices use the same PR state snapshots as the sidebar.
	// Only notify in the tree's own window or the main (non-tree) window.
	const previousPrStates = new Map<string, string | undefined>();
	const mergeNoticeInFlight = new Set<string>();
	context.subscriptions.push(
		treeData.onDidChangeSnapshots(({ repoPath: changedRepoPath, keys }) => {
			void (async () => {
				if (changedRepoPath !== repoPath) return;
				for (const key of keys ?? []) {
					const snapshot = treeData.getSnapshot(key);
					const hasPrevious = previousPrStates.has(key);
					const previous = previousPrStates.get(key);
					previousPrStates.set(key, snapshot?.prState);
					if (!hasPrevious || previous === "MERGED" || snapshot?.prState !== "MERGED") continue;
					const parsed = parseTreeKey(key);
					if (!parsed || mergeNoticeInFlight.has(key)) continue;
					mergeNoticeInFlight.add(key);
					const s = await stateManager.load();
					const tree = stateManager.getTree(s, parsed.repoPath, parsed.branch);
					if (!tree?.path || tree.mergeNotified) {
						mergeNoticeInFlight.delete(key);
						continue;
					}
					if (ctx.currentTree?.branch !== tree.branch && ctx.currentTree) {
						mergeNoticeInFlight.delete(key);
						continue;
					}
					const isOwnWindow = ctx.currentTree?.branch === tree.branch;
					await stateManager.updateTree(tree.repoPath, tree.branch, {
						mergeNotified: true,
					});
					const name = tree.ticketId ?? tree.branch;
					const detail = [
						tree.ticketId &&
							config.linear.enabled &&
							`move ${tree.ticketId} → ${config.linear.statuses.onCleanup}`,
						"remove worktree + branch",
						isOwnWindow && "close window",
					]
						.filter(Boolean)
						.join(", ");
					void Promise.resolve(
						vscode.window.showInformationMessage(
							`${name} PR was merged. Cleanup will ${detail}.`,
							"Cleanup",
							"Dismiss",
						),
					)
						.then((action) => {
							if (action === "Cleanup") return cleanupMerged(ctx, tree);
						})
						.catch((e: Error) =>
							outputChannel.appendLine(
								`[Forest] merged-PR notice failed: ${e.message}`,
							),
						)
						.finally(() => mergeNoticeInFlight.delete(key));
				}
			})().catch((e: Error) =>
				outputChannel.appendLine(`[Forest] merged-PR snapshot handler failed: ${e.message}`),
			);
		}),
	);

	// Periodic orphan check: detect worktree folders deleted externally
	context.subscriptions.push(
		guardedInterval("Orphan prune", async () => {
			const before = stateManager.getTreesForRepo(
				await stateManager.load(),
				repoPath,
			).length;
			const afterState = await pruneOrphans();
			const after = stateManager.getTreesForRepo(afterState, repoPath).length;
			if (after < before) forestProvider.refresh();
		}, 60_000),
	);

	// Auto-refresh todos every 3 minutes
	if (todosProvider) {
		const todosId = setInterval(() => todosProvider.refresh(), 3 * 60 * 1000);
		context.subscriptions.push({ dispose: () => clearInterval(todosId) });
	}

	// Watch state for changes from other windows
	let previousTrees = stateManager.getTreesForRepo(postPruneState, repoPath);
	stateManager.onDidChange(({ state: newState, isLocal }) => {
		if (ctx.currentTree) {
			const updated = stateManager.getTree(
				newState,
				repoPath,
				ctx.currentTree.branch,
			);
			if (updated) {
				// Another window started deleting our tree — close now so a dev container
				// window detaches gracefully before its container is killed.
				if (updated.cleaning && !isLocal) {
					vscode.commands.executeCommand("workbench.action.closeWindow");
					return;
				}
				ctx.currentTree = updated;
				statusBarManager.update(updated);
			} else {
				// Our tree was removed by another window — close this window
				vscode.commands.executeCommand("workbench.action.closeWindow");
				return;
			}
		}
		const currentTrees = stateManager.getTreesForRepo(newState, repoPath);
		// Clean up workspace files for trees removed by another window.
		// Skip for local writes — the initiating command handles its own cleanup.
		if (!isLocal) {
			const currentBranches = new Set(currentTrees.map((t) => t.branch));
			for (const prev of previousTrees) {
				if (prev.branch === ctx.currentTree?.branch) continue;
				if (!currentBranches.has(prev.branch)) {
					deleteWorkspaceFiles(prev);
				}
			}
		}
		previousTrees = currentTrees;
		forestProvider.refresh();
		updateNoTrees().catch((e) => outputChannel.appendLine(`[Forest] noTrees update failed: ${e.message}`));
	});

	context.subscriptions.push(
		outputChannel,
		shortcutManager,
		shortcutsProvider,
		statusBarManager,
		stateManager,
		forestProvider,
	);
	if (todosProvider) context.subscriptions.push(todosProvider);
}

export function deactivate() {}

async function reconcileState(
	repoPath: string,
	stateManager: StateManager,
	outputChannel: vscode.OutputChannel,
): Promise<{ postPruneState: ForestState; pruneOrphans: () => Promise<ForestState> }> {
	await stateManager.clearStaleTreeOperations(repoPath);
	for (const tree of stateManager.getTreesForRepo(await stateManager.load(), repoPath)) {
		if (tree.cleaning && tree.path && fs.existsSync(tree.path)) {
			await stateManager.updateTree(tree.repoPath, tree.branch, { cleaning: undefined });
		}
	}

	const pruneOrphans = async (): Promise<ForestState> => {
		const treesDir = getTreesDir(repoPath);
		if (fs.existsSync(treesDir)) {
			for (const entry of fs.readdirSync(treesDir)) {
				if (entry.includes(".removing.")) {
					await fs.promises.rm(path.join(treesDir, entry), { recursive: true, force: true })
						.catch((e) => outputChannel.appendLine(`[Forest] Remove stale directory failed: ${e.message}`));
				}
			}
		}
		for (const tree of stateManager.getTreesForRepo(await stateManager.load(), repoPath)) {
			if (tree.path && !fs.existsSync(tree.path)) {
				outputChannel.appendLine(`[Forest] Pruning orphan: ${tree.branch} (${tree.path} missing)`);
				await stateManager.removeTree(tree.repoPath, tree.branch);
				deleteWorkspaceFiles(tree);
			}
		}
		return stateManager.load();
	};

	const recoverOrphanWorktrees = async (state: ForestState): Promise<ForestState> => {
		const treesDir = getTreesDir(repoPath);
		if (!fs.existsSync(treesDir)) return state;
		const knownPaths = new Set(stateManager.getTreesForRepo(state, repoPath).map((t) => t.path).filter(Boolean));
		for (const entry of fs.readdirSync(treesDir)) {
			const dirPath = path.join(treesDir, entry);
			// statSync can throw ENOENT if the entry was deleted between
			// readdir and stat (common during activation-time reconciliation
			// when another window is also pruning). Skip such entries.
			let isDir: boolean;
			try { isDir = fs.statSync(dirPath).isDirectory(); } catch { continue; }
			if (entry.startsWith(".") || !isDir || knownPaths.has(dirPath)) continue;
			const gitFile = path.join(dirPath, ".git");
			if (!fs.existsSync(gitFile)) continue;
			try {
				const gitdir = path.resolve(dirPath, fs.readFileSync(gitFile, "utf8").trim().replace("gitdir: ", ""));
				const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
				const branch = head.startsWith("ref: refs/heads/") ? head.replace("ref: refs/heads/", "") : "";
				if (!branch) continue;
				outputChannel.appendLine(`[Forest] Recovered orphan worktree: ${branch} at ${dirPath}`);
				await stateManager.addTree(repoPath, {
					branch,
					repoPath,
					path: dirPath,
					createdAt: new Date(fs.statSync(dirPath).birthtimeMs).toISOString(),
				});
			} catch {
				outputChannel.appendLine(`[Forest] Ignoring unreadable worktree: ${dirPath}`);
			}
		}
		return stateManager.load();
	};

	const reportUnknownDirectories = (state: ForestState): ForestState => {
		const treesDir = getTreesDir(repoPath);
		if (!fs.existsSync(treesDir)) return state;
		const knownPaths = new Set(stateManager.getTreesForRepo(state, repoPath).map((t) => t.path).filter(Boolean));
		for (const entry of fs.readdirSync(treesDir)) {
			const dirPath = path.join(treesDir, entry);
			// Same ENOENT race as in recoverOrphanWorktrees.
			let isDir: boolean;
			try { isDir = fs.statSync(dirPath).isDirectory(); } catch { continue; }
			if (entry.startsWith(".") || knownPaths.has(dirPath) || !isDir) continue;
			if (!fs.existsSync(path.join(dirPath, ".git"))) outputChannel.appendLine(`[Forest] Ignoring unknown directory: ${dirPath}`);
		}
		return state;
	};

	const postPruneState = reportUnknownDirectories(await recoverOrphanWorktrees(await pruneOrphans()));
	return { postPruneState, pruneOrphans };
}

function registerCommands(
	context: vscode.ExtensionContext,
	ctx: ForestContext,
	outputChannel: vscode.OutputChannel,
): void {
	const reg = (id: string, fn: (...args: any[]) => any) =>
		context.subscriptions.push(
			vscode.commands.registerCommand(id, async (...args: any[]) => {
				try {
					return await fn(...args);
				} catch (e: any) {
					outputChannel.appendLine(`[Forest] Command ${id} failed: ${e.stack ?? e.message}`);
					outputChannel.show(true);
					notify.error(`Forest: ${e.message}`);
				}
			}),
		);
	const lookupTree = (branch?: string) =>
		branch ? ctx.stateManager.getTree(ctx.stateManager.getCached(), ctx.repoPath, branch) : undefined;
	const refreshAfter = <T>(fn: () => Promise<T>) => async () => {
		await fn();
		ctx.forestProvider.refresh();
	};

	reg("forest.create", async () => {
		if (!(await ctx.forestProvider.showCreateForm())) await createWizard(ctx);
	});
	reg("forest.start", (arg: { ticketId: string; title: string }) => start(ctx, arg));
	reg("forest.switch", (branch?: string) => switchTree(ctx, branch));
	reg("forest.ship", (branch?: string) => refreshAfter(() => ship(ctx, lookupTree(branch), false))());
	reg("forest.shipMerge", (branch?: string) => refreshAfter(() => ship(ctx, lookupTree(branch), true))());
	reg("forest.deleteTree", (branch?: string, isDone?: boolean) => deleteTree(ctx, branch, isDone ?? false));
	reg("forest.update", () => refreshAfter(() => update(ctx))());
	reg("forest.rebase", () => refreshAfter(() => rebase(ctx))());
	reg("forest.pull", () => refreshAfter(() => pull(ctx))());
	reg("forest.push", () => refreshAfter(() => push(ctx))());
	reg("forest.list", () => list(ctx));
	reg("forest.openMain", () => focusOrOpenWindow(vscode.Uri.file(ctx.repoPath)));
	reg("forest.refresh", () => ctx.forestProvider.refresh());
	reg("forest.refreshTodos", () => ctx.todosProvider?.refresh());
	reg("forest.copyBranch", () => ctx.currentTree && vscode.env.clipboard.writeText(ctx.currentTree.branch));
	reg("forest.revealInFinder", () => {
		if (ctx.currentTree?.path) vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(ctx.currentTree.path));
	});
	reg("forest.openPR", () => ctx.currentTree?.prUrl && vscode.env.openExternal(vscode.Uri.parse(ctx.currentTree.prUrl)));
	reg("forest.openTicket", async () => {
		if (!ctx.currentTree?.ticketId) return;
		try {
			const issue = await linear.getIssue(ctx.currentTree.ticketId);
			if (!issue) {
				notify.warn(`Linear ticket ${ctx.currentTree.ticketId} was not found.`);
				return;
			}
			if (!issue.url) {
				notify.warn(`Linear ticket ${ctx.currentTree.ticketId} has no URL.`);
				return;
			}
			vscode.env.openExternal(vscode.Uri.parse(issue.url));
		} catch (e: any) {
			outputChannel.appendLine(`[Forest] Open ticket failed: ${e.message}`);
			notify.warn(`Could not open Linear ticket ${ctx.currentTree.ticketId}: ${e.message}`);
		}
	});
	reg("forest.linkTicket", (branch?: string) => {
		const b = branch ?? ctx.currentTree?.branch;
		if (b) return refreshAfter(() => linkTicket(ctx, b))();
	});
	const unwrap = (arg: any) => arg instanceof ShortcutItem ? arg.shortcut : arg;
	reg("forest.openShortcut", (arg: any) => ctx.shortcutManager.open(unwrap(arg)));
	reg("forest.openShortcutExternal", (arg: any) => ctx.shortcutManager.openExternal(unwrap(arg)));
	reg("forest.openShortcutWith", (arg: any) => ctx.shortcutManager.openWith(unwrap(arg)));
	reg("forest.runShortcut", async () => {
		const shortcuts = allShortcuts(ctx.config.shortcuts);
		if (!shortcuts.length) return notify.info("No shortcuts configured.");
		const picked = await vscode.window.showQuickPick(
			shortcuts.map((sc) => ({
				label: sc.name,
				description: sc.type === "terminal" ? sc.command : sc.url,
				detail: sc.type === "terminal" ? "$(terminal) Terminal" : "$(globe) Browser",
				shortcut: sc,
			})),
			{ placeHolder: "Run a shortcut…", matchOnDescription: true },
		);
		if (picked) ctx.shortcutManager.open(picked.shortcut);
	});

	// Todos commands
	reg("forest.todoCreateTree", async (arg: any) => {
		const issue = arg instanceof TodoItem ? arg.issue : arg as linear.LinearIssue;
		if (!issue) return;
		const state = await ctx.stateManager.load();
		const existing = ctx.stateManager.findTreeByTicket(state, ctx.repoPath, issue.id);
		// Focus the existing tree instead of creating a duplicate. If the entry
		// is corrupt (no path), openTreeWindow throws instead of hiding it.
		if (existing) return openTreeWindow(existing);
		const shown = await ctx.forestProvider.showCreateFormWithIssue(issue);
		if (!shown) {
			await start(ctx, { ticketId: issue.id, title: issue.title });
			ctx.todosProvider?.refresh();
		}
	});
	reg("forest.openTodoUrl", async (arg: any) => {
		const issue = arg instanceof TodoItem ? arg.issue : arg as linear.LinearIssue;
		if (issue?.url) {
			vscode.env.openExternal(vscode.Uri.parse(issue.url));
		}
	});
}
