import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as git from "../cli/git";
import * as linear from "../cli/linear";
import { allShortcuts, type ForestConfig, getTreesDir } from "../config";
import type { ForestContext } from "../context";
import { notify } from "../notify";
import {
	displayName,
	type StateManager,
	TREE_OPERATION_HEARTBEAT_MS,
	type TreeState,
} from "../state";
import { exec, execShell } from "../utils/exec";
import { repoHash, safeRelativePath, tryUnlinkSync } from "../utils/fs";

/** Resolve tree from arg or current context, showing an error if not found or missing path. */
export function requireTree(
	ctx: ForestContext,
	arg: TreeState | string | undefined,
	action: string,
): (TreeState & { path: string }) | undefined {
	const tree =
		typeof arg === "string"
			? ctx.stateManager.getTree(
					ctx.stateManager.getCached(),
					ctx.repoPath,
					arg,
				)
			: (arg ?? ctx.currentTree);
	if (!tree) {
		notify.error(
			`No tree to ${action}. Run from a tree window or select from sidebar.`,
		);
		return undefined;
	}
	if (!tree.path) {
		notify.error(`Cannot ${action}: tree has no worktree path.`);
		return undefined;
	}
	return tree as TreeState & { path: string };
}

export async function getBlockingTreeOperation(
	ctx: ForestContext,
	tree: Pick<TreeState, "repoPath" | "branch">,
): Promise<string | undefined> {
	const latest = ctx.stateManager.getTree(
		await ctx.stateManager.load(),
		tree.repoPath,
		tree.branch,
	);
	if (!latest) return undefined;
	if (latest.cleaning) return "deleting";
	return latest.busyOperation;
}

export async function ensureTreeIdle(
	ctx: ForestContext,
	tree: TreeState,
): Promise<boolean> {
	const active = await getBlockingTreeOperation(ctx, tree);
	if (!active) return true;
	notify.info(`${displayName(tree)} is already ${active}.`);
	return false;
}

export async function withTreeOperation<T>(
	ctx: ForestContext,
	tree: TreeState & { path: string },
	busyOperation: string,
	fn: () => Promise<T> | Thenable<T>,
): Promise<T | undefined> {
	const { started, active } = await ctx.stateManager.tryStartTreeOperation(
		tree.repoPath,
		tree.branch,
		busyOperation,
	);
	if (!started) {
		notify.info(`${displayName(tree)} is already ${active ?? "busy"}.`);
		return undefined;
	}

	const heartbeat = setInterval(() => {
			ctx.stateManager
				.touchTreeOperation(tree.repoPath, tree.branch, busyOperation)
				.catch((e) => ctx.outputChannel.appendLine(`[Forest] Operation heartbeat failed: ${e.message}`));
	}, TREE_OPERATION_HEARTBEAT_MS);

	try {
		return await fn();
	} finally {
		clearInterval(heartbeat);
			await ctx.stateManager
				.clearTreeOperation(tree.repoPath, tree.branch, busyOperation)
				.catch((e) => ctx.outputChannel.appendLine(`[Forest] Clear operation failed: ${e.message}`));
	}
}

/** Filter out issues that already have trees in the given repo. */
export function filterUnlinkedIssues<T extends { id: string }>(
	issues: T[],
	stateManager: StateManager,
	state: import("../state").ForestState,
	repoPath: string,
): T[] {
	const existingTickets = new Set(
		stateManager
			.getTreesForRepo(state, repoPath)
			.filter((t) => t.ticketId)
			.map((t) => t.ticketId),
	);
	return issues.filter((i) => !existingTickets.has(i.id));
}

/** Run an async step, log to output channel, show error notification on failure. */
export async function runStep(
	ctx: ForestContext,
	label: string,
	fn: () => Promise<void>,
): Promise<boolean> {
	try {
		await fn();
		ctx.outputChannel.appendLine(`[Forest] ${label}: done`);
		return true;
	} catch (e: any) {
		ctx.outputChannel.appendLine(`[Forest] ${label}: FAILED — ${e.message}`);
		ctx.outputChannel.show(true);
		notify.error(`${label}: ${e.message}`);
		return false;
	}
}

/** Pick a team key for issue creation. Returns undefined if cancelled. */
export async function pickTeam(teams?: string[]): Promise<string | undefined> {
	if (!teams?.length) {
		notify.error(
			'Forest: No Linear teams configured. Set "teams" in .forest/config.json.',
		);
		return undefined;
	}
	if (teams.length === 1) return teams[0];
	const pick = await vscode.window.showQuickPick(
		teams.map((t) => ({ label: t })),
		{ placeHolder: "Which team?" },
	);
	return pick?.label;
}

export async function updateLinear(
	ctx: ForestContext,
	ticketId: string,
	status: string | undefined,
): Promise<void> {
	if (!status) return;
	if (!ctx.config.linear.enabled) return;
	if (!linear.isAvailable()) return;
	await runStep(ctx, `Linear ${ticketId} → ${status}`, () =>
		linear.updateIssueState(ticketId, status),
	);
}

export function copyConfigFiles(
	config: ForestConfig,
	repoPath: string,
	treePath: string,
): void {
	for (const file of config.copy) {
		const src = safeRelativePath(repoPath, file, "copy path");
		const dst = safeRelativePath(treePath, file, "copy destination");
		try {
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.cpSync(src, dst, { recursive: true });
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
		}
	}
}

/** Create symlinks from tree to main repo for configured directories. */
export function symlinkConfigDirs(
	config: ForestConfig,
	repoPath: string,
	treePath: string,
): void {
	for (const dir of config.symlink) {
		const src = safeRelativePath(repoPath, dir, "symlink path");
		const dst = safeRelativePath(treePath, dir, "symlink destination");
		// Only create if the source exists in the main repo
		if (!fs.existsSync(src)) continue;
		// Remove existing (dir, file, or stale symlink) in the tree
		if (fs.existsSync(dst) && !fs.lstatSync(dst).isSymbolicLink()) {
			throw new Error(`Refusing to replace non-symlink: ${dst}`);
		}
		try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* may not exist */ }
		// Ensure parent directory exists
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		// Create relative symlink for portability
		const relative = path.relative(path.dirname(dst), src);
		fs.symlinkSync(relative, dst);
	}
}

type ProgressReporter = { report(value: { message?: string }): void };

/** Common post-worktree-creation setup: copy files, run direnv. */
async function postWorktreeSetup(
	config: ForestConfig,
	repoPath: string,
	treePath: string,
	tree: TreeState,
	progress?: ProgressReporter,
): Promise<void> {
	progress?.report({ message: "Copying config files..." });
	copyConfigFiles(config, repoPath, treePath);
	progress?.report({ message: "Creating symlinks..." });
	symlinkConfigDirs(config, repoPath, treePath);
	ensureWorkspaceFile(tree);

	const hasDirenv = fs.existsSync(path.join(treePath, ".envrc"));
	if (hasDirenv) {
		progress?.report({ message: "Running direnv allow..." });
		await execShell("direnv allow", { cwd: treePath, timeout: 10_000 }).catch(
			() => {
				/* non-fatal */
			},
		);
	}
}

/** Sanitize branch name for use as filename. */
function sanitizeBranchForPath(branch: string): string {
	return branch
		.replace(/\.\./g, "")
		.replace(/\//g, "--")
		.replace(/[<>:"|?*\x00-\x1f]/g, "-");
}

function resolveTreePath(
	repoPath: string,
	branch: string,
	ticketId?: string,
): string {
	const treesDir = getTreesDir(repoPath);
	fs.mkdirSync(treesDir, { recursive: true });
	return path.join(treesDir, ticketId ?? sanitizeBranchForPath(branch));
}

function checkMaxTrees(
	stateManager: StateManager,
	state: import("../state").ForestState,
	repoPath: string,
	max: number,
): void {
	const active = stateManager
		.getTreesForRepo(state, repoPath)
		.filter((t) => t.path);
	if (active.length >= max)
		throw new Error(`Max trees (${max}) reached. Clean up some trees first.`);
}

/** If there are uncommitted changes, ask what to do. Returns stash ref, false if clean/discarded, undefined if cancelled. */
export async function promptUncommittedChanges(
	repoPath: string,
): Promise<string | false | undefined> {
	if (!(await git.hasUncommittedChanges(repoPath))) return false;
	const pick = await vscode.window.showQuickPick(
		[
			{ label: "Carry to new tree", id: "carry" },
			{ label: "Discard changes", id: "discard" },
		],
		{ placeHolder: "You have uncommitted changes" },
	);
	if (!pick) return undefined;
	if (pick.id === "carry")
		return git.stash(repoPath, `forest-carry-${Date.now()}`);
	await git.discardChanges(repoPath);
	return false;
}

const createInProgress = new Set<string>();

/** Shared tree creation logic. */
export async function createTree(opts: {
	branch: string;
	config: ForestConfig;
	stateManager: StateManager;
	repoPath: string;
	ticketId?: string;
	title?: string;
	existingBranch?: boolean;
	carryChanges?: string | false;
	useDevcontainer?: boolean;
	outputChannel?: vscode.OutputChannel;
}): Promise<TreeState> {
	const {
		branch,
		config,
		stateManager,
		repoPath,
		ticketId,
		title,
		existingBranch,
		carryChanges,
		useDevcontainer,
		outputChannel,
	} = opts;
	const log = (msg: string) => outputChannel?.appendLine(`[Forest] ${msg}`);
	const createKey = `${repoPath}:${branch}`;
	if (createInProgress.has(createKey))
		throw new Error("Tree creation already in progress.");
	createInProgress.add(createKey);
	try {
		// Check existing
		const state = await stateManager.load();
		if (stateManager.getTree(state, repoPath, branch)) {
			throw new Error(`Tree for branch "${branch}" already exists`);
		}
		if (!existingBranch && (await git.branchExists(repoPath, branch))) {
			throw new Error(
				`Branch "${branch}" already exists. Use "Select branch" instead.`,
			);
		}

		checkMaxTrees(stateManager, state, repoPath, config.maxTrees);
		const treePath = resolveTreePath(repoPath, branch, ticketId);

		const hasNewTreeShortcuts = allShortcuts(config.shortcuts).some(
			(s) => s.onNewTree,
		);
		const tree: TreeState = {
			branch,
			repoPath,
			path: treePath,
			createdAt: new Date().toISOString(),
			...(ticketId ? { ticketId } : {}),
			...(title ? { title } : {}),
			...(hasNewTreeShortcuts ? { needsSetup: true } : {}),
			...(useDevcontainer ? { useDevcontainer: true } : {}),
		};

		// Defer state persistence until after worktree creation succeeds.
		// The in-memory createInProgress guard prevents duplicates within this
		// process; the file lock in modify() prevents duplicates across windows.
		let stateSaved = false;

		try {
			return await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Creating tree for ${displayName(tree)}...`,
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: "Creating worktree..." });
					if (existingBranch) {
						await git.checkoutWorktree(repoPath, treePath, branch);
					} else {
						// Carrying: base the new tree on the same commit the stash was made
						// against, so the patch applies cleanly. Otherwise local HEAD vs
						// origin/baseBranch drift produces 3-way conflicts.
						const from = carryChanges
							? await git.resolveRef(repoPath, `${carryChanges}^1`)
							: undefined;
						await git.createWorktree(
							repoPath,
							treePath,
							branch,
							config.baseBranch,
							from ? { from } : undefined,
						);
					}
					// Worktree created successfully — now persist state.
					await stateManager.addTree(repoPath, tree);
					stateSaved = true;

					if (carryChanges) {
						try {
							// Worktree was created from the stash's parent (see `from` above),
							// so the worktree's HEAD matches the stash's base — `git stash apply`
							// restores tracked + index + untracked changes cleanly.
							await git.stashApply(treePath, carryChanges);
						} catch (e: any) {
							const detail = (e?.stderr || e?.message || String(e))
								.trim()
								.split("\n")
								.slice(0, 4)
								.join(" ");
							throw new Error(
								`Could not apply uncommitted changes. Run "git stash pop" in your main repo to recover. (${detail})`,
							);
						}
							await git.stashDrop(repoPath, carryChanges).catch((e) =>
								log(`Drop carry stash failed: ${e.message}`),
							);
					}

					await postWorktreeSetup(config, repoPath, treePath, tree, progress);

					progress.report({ message: "Opening window..." });
					await openTreeWindow(tree, { forceNewWindow: true });

					return tree;
				},
			);
		} catch (e: any) {
			if (stateSaved) await stateManager.removeTree(repoPath, branch);
			await git.removeWorktree(repoPath, treePath).catch((err) =>
				log(`Rollback remove worktree failed: ${err.message}`),
			);
			if (!existingBranch)
				await git.deleteBranch(repoPath, branch).catch((err) =>
					log(`Rollback delete branch failed: ${err.message}`),
				);
			throw e;
		}
	} finally {
		createInProgress.delete(createKey);
	}
}

export function workspaceFilePath(
	tree: Pick<TreeState, "repoPath" | "branch" | "ticketId">,
): string {
	// Include repo identity so identical branch/ticket names across repos do not collide.
	const repoName = path.basename(tree.repoPath);
	const fileName = `${repoName}-${repoHash(tree.repoPath)}-${tree.ticketId ?? sanitizeBranchForPath(tree.branch)}.code-workspace`;
	return path.join(os.homedir(), ".forest", "workspaces", fileName);
}

function legacyWorkspaceFilePath(
	tree: Pick<TreeState, "branch" | "ticketId">,
): string {
	return path.join(
		os.homedir(),
		".forest",
		"workspaces",
		`${tree.ticketId ?? sanitizeBranchForPath(tree.branch)}.code-workspace`,
	);
}

export function deleteWorkspaceFiles(
	tree: Pick<TreeState, "repoPath" | "branch" | "ticketId">,
): void {
	for (const wsPath of [
		workspaceFilePath(tree),
		legacyWorkspaceFilePath(tree),
	]) {
		tryUnlinkSync(wsPath);
	}
}

export function ensureWorkspaceFile(tree: TreeState): string {
	if (!tree.path) throw new Error("Tree has no worktree path.");
	const wsPath = workspaceFilePath(tree);
	fs.mkdirSync(path.dirname(wsPath), { recursive: true });
	const name = displayName(tree);
	const workspace = {
		folders: [{ path: tree.path }],
		settings: {
			"window.title": `${name}\${separator}\${activeEditorShort}`,
			"terminal.integrated.enablePersistentSessions": false,
		},
	};
	fs.writeFileSync(wsPath, JSON.stringify(workspace, null, 2));
	// Remove the pre-repo-scoped filename so reopened trees converge on the new path.
	const legacyPath = legacyWorkspaceFilePath(tree);
	if (legacyPath !== wsPath) {
		tryUnlinkSync(legacyPath);
	}
	return wsPath;
}

/** Open a tree's window, dispatching to Dev Containers if the tree opted in. */
export async function openTreeWindow(
	tree: TreeState,
	opts?: { forceNewWindow?: boolean },
): Promise<void> {
	if (!tree.path) throw new Error("Tree has no worktree path.");
	const devcontainerJson = path.join(
		tree.path,
		".devcontainer",
		"devcontainer.json",
	);
	if (tree.useDevcontainer && fs.existsSync(devcontainerJson)) {
		const cmds = await vscode.commands.getCommands(true);
		if (cmds.includes("remote-containers.openFolder")) {
			// Always new window: Dev Containers has no focus-existing-window equivalent of `open -a Code`.
			await vscode.commands.executeCommand(
				"remote-containers.openFolder",
				vscode.Uri.file(tree.path),
				{
					forceNewWindow: true,
				},
			);
			return;
		}
		notify.warn(
			"Dev Containers extension not installed — opening without sandbox.",
		);
	}
	const wsFile = ensureWorkspaceFile(tree);
	if (opts?.forceNewWindow) {
		await vscode.commands.executeCommand(
			"vscode.openFolder",
			vscode.Uri.file(wsFile),
			{ forceNewWindow: true },
		);
	} else {
		await focusOrOpenWindow(vscode.Uri.file(wsFile));
	}
}

/** On macOS, `open -a` deduplicates windows natively. Falls back to forceNewWindow elsewhere. */
export async function focusOrOpenWindow(uri: vscode.Uri): Promise<void> {
	if (process.platform === "darwin") {
		try {
			const appPath = process.execPath.replace(/\/Contents\/.*$/, "");
			await exec("open", ["-a", appPath, uri.fsPath], { timeout: 10_000 });
			return;
		} catch {
			/* fall through */
		}
	}
	await vscode.commands.executeCommand("vscode.openFolder", uri, {
		forceNewWindow: true,
	});
}
