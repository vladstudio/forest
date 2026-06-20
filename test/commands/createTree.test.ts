import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
		load: vi.fn(async () => state),
		removeTree: vi.fn(async (repoPath: string, branch: string) => {
			delete state.trees[`${repoPath}:${branch}`];
		}),
	};
}

describe("createTree", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(git.branchExists).mockResolvedValue(false);
		vi.mocked(git.deleteBranch).mockResolvedValue();
		vi.mocked(git.removeWorktree).mockResolvedValue();
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
});
