import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cli/git", () => ({
	branchExists: vi.fn(),
	checkoutWorktree: vi.fn(),
	createWorktree: vi.fn(),
	deleteBranch: vi.fn(),
	removeWorktree: vi.fn(),
	resolveRef: vi.fn(),
	stashApply: vi.fn(),
	stashDrop: vi.fn(),
}));

import { clearTreesDirCache, getTreesDir } from "../../src/config";
import * as git from "../../src/cli/git";
import { createTree } from "../../src/commands/shared";

const config = {
	baseBranch: "main",
	copy: [],
	maxTrees: 10,
	shortcuts: { cli: [], web: [] },
	symlink: [],
} as any;

function stateManager(trees: any[] = []) {
	const state = {
		version: 1 as const,
		trees: Object.fromEntries(
			trees.map((tree) => [`${tree.repoPath}:${tree.branch}`, tree]),
		),
	};
	return {
		addTree: vi.fn(async (repoPath: string, tree: any) => {
			state.trees[`${repoPath}:${tree.branch}`] = tree;
		}),
		getTree: (s: typeof state, repoPath: string, branch: string) =>
			s.trees[`${repoPath}:${branch}`],
		getTreesForRepo: (s: typeof state, repoPath: string) =>
			Object.values(s.trees).filter((tree: any) => tree.repoPath === repoPath),
		findTreeByTicket: (
			s: typeof state,
			repoPath: string,
			ticketId: string,
			opts?: { excludeBranch?: string },
		) =>
			Object.values(s.trees).find(
				(tree: any) =>
					tree.repoPath === repoPath &&
					tree.ticketId === ticketId &&
					(!opts?.excludeBranch || tree.branch !== opts.excludeBranch),
		),
		load: vi.fn(async () => state),
		removeTree: vi.fn(async (repoPath: string, branch: string) => {
			delete state.trees[`${repoPath}:${branch}`];
		}),
	};
}

describe("createTree", () => {
	const originalHome = process.env.HOME;
	let home = "";

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "forest-home-"));
		process.env.HOME = home;
		clearTreesDirCache();
		vi.resetAllMocks();
		vi.mocked(git.branchExists).mockResolvedValue(false);
		vi.mocked(git.deleteBranch).mockResolvedValue();
		vi.mocked(git.removeWorktree).mockResolvedValue();
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		if (originalHome) process.env.HOME = originalHome;
		else delete process.env.HOME;
		clearTreesDirCache();
	});

	it("rejects duplicate ticket ids before touching git", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-create-"));
		const repoPath = path.join(root, "repo");
		fs.mkdirSync(repoPath, { recursive: true });
		const manager = stateManager([
			{
				branch: "old-branch",
				createdAt: new Date().toISOString(),
				path: path.join(root, "old-tree"),
				repoPath,
				ticketId: "KAD-1",
			},
		]);

		await expect(
			createTree({
				branch: "new-branch",
				config,
				repoPath,
				stateManager: manager as any,
				ticketId: "KAD-1",
			}),
		).rejects.toThrow('Tree for ticket "KAD-1" already exists');
		expect(git.createWorktree).not.toHaveBeenCalled();
		expect(git.removeWorktree).not.toHaveBeenCalled();
	});

	it("does not remove a worktree when creation never succeeded", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-create-"));
		const repoPath = path.join(root, "repo");
		fs.mkdirSync(repoPath, { recursive: true });
		const manager = stateManager();
		vi.mocked(git.createWorktree).mockRejectedValue(new Error("boom"));

		await expect(
			createTree({
				branch: "new-branch",
				config,
				repoPath,
				stateManager: manager as any,
			}),
		).rejects.toThrow("boom");
		expect(git.removeWorktree).not.toHaveBeenCalled();
		expect(manager.removeTree).not.toHaveBeenCalled();
	});

	it("rejects when the tree path is already claimed by another tree", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-create-"));
		const repoPath = path.join(root, "repo");
		fs.mkdirSync(repoPath, { recursive: true });
		// Pre-claim createTree's path for KAD-2 without a ticketId, so the ticket check doesn't short-circuit.
		const claimedPath = path.join(getTreesDir(repoPath), "KAD-2");
		const manager = stateManager([
			{
				branch: "old-branch",
				createdAt: new Date().toISOString(),
				path: claimedPath,
				repoPath,
			},
		]);

		await expect(
			createTree({
				branch: "new-branch",
				ticketId: "KAD-2",
				config,
				repoPath,
				stateManager: manager as any,
			}),
		).rejects.toThrow("Tree path is already in use");
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("rejects when the tree path already exists on disk", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-create-"));
		const repoPath = path.join(root, "repo");
		fs.mkdirSync(repoPath, { recursive: true });
		// Pre-create the git path to simulate a leftover from an aborted run.
		const leftover = path.join(getTreesDir(repoPath), "KAD-9");
		fs.mkdirSync(leftover, { recursive: true });
		const manager = stateManager();

		await expect(
			createTree({
				branch: "new-branch",
				ticketId: "KAD-9",
				config,
				repoPath,
				stateManager: manager as any,
			}),
		).rejects.toThrow("Tree path already exists");
		expect(git.createWorktree).not.toHaveBeenCalled();
	});

	it("cleans up a partially-created worktree directory on failure", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-create-"));
		const repoPath = path.join(root, "repo");
		fs.mkdirSync(repoPath, { recursive: true });
		const manager = stateManager();
		// Simulate an interrupted create: git writes the worktree dir, then throws.
		// Rollback must still clean it up.
		vi.mocked(git.createWorktree).mockImplementation(
			async (_repo: string, treePath: string) => {
				fs.mkdirSync(treePath, { recursive: true });
				throw new Error("interrupted");
			},
		);

		await expect(
			createTree({
				branch: "partial-branch",
				config,
				repoPath,
				stateManager: manager as any,
			}),
		).rejects.toThrow("interrupted");
		expect(git.removeWorktree).toHaveBeenCalledWith(
			repoPath,
			expect.stringContaining("partial-branch"),
		);
	});
});
