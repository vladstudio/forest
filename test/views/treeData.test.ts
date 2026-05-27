import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/context", () => ({
	getHostWorkspacePath: vi.fn(),
}));

vi.mock("../../src/cli/git", () => ({
	commitsAhead: vi.fn(),
	commitsBehind: vi.fn(),
	commitsBehindRemote: vi.fn(),
	localChanges: vi.fn(),
}));

vi.mock("../../src/cli/gh", () => ({
	prStatus: vi.fn(),
	repoHasAutomergeCached: vi.fn(),
}));

import { getHostWorkspacePath } from "../../src/context";
import * as gh from "../../src/cli/gh";
import * as git from "../../src/cli/git";
import { TreeDataService } from "../../src/views/treeData";

describe("TreeDataService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("groups trees, prefers current tree ordering, and caches fetches", async () => {
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "forest-repo-"));
		const paths = {
			current: path.join(repoPath, "tree-current"),
			review: path.join(repoPath, "tree-review"),
			done: path.join(repoPath, "tree-done"),
			closed: path.join(repoPath, "tree-closed"),
			deleting: path.join(repoPath, "tree-deleting"),
		};
		for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
		vi.mocked(getHostWorkspacePath).mockReturnValue(paths.current);
		vi.mocked(gh.repoHasAutomergeCached).mockReturnValue(true);
		vi.mocked(git.commitsBehind).mockImplementation(async (wt) =>
			wt === paths.current ? 1 : 0,
		);
		vi.mocked(git.commitsAhead).mockResolvedValue({ count: 2, hasTrackingRef: true });
		vi.mocked(git.commitsBehindRemote).mockResolvedValue(0);
		vi.mocked(git.localChanges).mockResolvedValue({ added: 1, removed: 0, modified: 0 });
		vi.mocked(gh.prStatus).mockImplementation(async (wt) => {
			if (wt === paths.review) return { state: "OPEN", reviewDecision: null, number: 7, url: "https://pr/7" };
			if (wt === paths.done) return { state: "MERGED", reviewDecision: null, number: 8, url: "https://pr/8" };
			if (wt === paths.closed) return { state: "CLOSED", reviewDecision: null, number: 9, url: "https://pr/9" };
			return null;
		});

		const trees = [
			{ branch: "review", repoPath, path: paths.review, createdAt: "2024-01-05T00:00:00.000Z" },
			{ branch: "current", repoPath, path: paths.current, createdAt: "2024-01-01T00:00:00.000Z" },
			{ branch: "done", repoPath, path: paths.done, createdAt: "2024-01-04T00:00:00.000Z" },
			{ branch: "closed", repoPath, path: paths.closed, createdAt: "2024-01-03T00:00:00.000Z" },
			{ branch: "deleting", repoPath, path: paths.deleting, createdAt: "2024-01-02T00:00:00.000Z", cleaning: true },
		];
		const stateManager = {
			load: vi.fn(async () => ({ version: 1, trees: {} })),
			getTreesForRepo: vi.fn(() => trees),
			updateTree: vi.fn(async () => undefined),
		};
		const service = new TreeDataService(
			stateManager as any,
			{
				ai: true,
				baseBranch: "main",
				github: { enabled: true },
				linear: { enabled: true },
			} as any,
			() => repoPath,
			() => {},
		);

		const first = await service.build();
		const second = await service.build();

		expect(first.hasAutomerge).toBe(true);
		expect(first.groups.map((group) => group.label)).toEqual([
			"In progress",
			"In review",
			"Done",
			"Closed",
			"Deleting",
		]);
		expect(first.groups[0]?.trees.map((tree) => tree.branch)).toEqual(["current"]);
		expect(first.groups[1]?.trees.map((tree) => tree.branch)).toEqual(["review"]);
		expect(stateManager.updateTree).toHaveBeenCalledWith(repoPath, "review", {
			prUrl: "https://pr/7",
		});
		expect(second.groups).toEqual(first.groups);
		expect(git.commitsBehind).toHaveBeenCalledTimes(4);
		expect(git.commitsAhead).toHaveBeenCalledTimes(4);
		expect(git.commitsBehindRemote).toHaveBeenCalledTimes(4);
		expect(git.localChanges).toHaveBeenCalledTimes(4);
		expect(gh.prStatus).toHaveBeenCalledTimes(4);
	});

	it("surfaces hasTrackingRef from commitsAhead so the webview can allow first push", async () => {
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "forest-repo-"));
		const treePath = path.join(repoPath, "tree-new");
		fs.mkdirSync(treePath, { recursive: true });
		vi.mocked(getHostWorkspacePath).mockReturnValue(treePath);
		vi.mocked(gh.repoHasAutomergeCached).mockReturnValue(false);
		vi.mocked(git.commitsBehind).mockResolvedValue(0);
		vi.mocked(git.commitsAhead).mockResolvedValue({ count: 0, hasTrackingRef: false });
		vi.mocked(git.commitsBehindRemote).mockResolvedValue(0);
		vi.mocked(git.localChanges).mockResolvedValue(null);
		vi.mocked(gh.prStatus).mockResolvedValue(null);

		const trees = [
			{ branch: "new", repoPath, path: treePath, createdAt: "2024-01-01T00:00:00.000Z" },
		];
		const stateManager = {
			load: vi.fn(async () => ({ version: 1, trees: {} })),
			getTreesForRepo: vi.fn(() => trees),
			updateTree: vi.fn(async () => undefined),
		};
		const service = new TreeDataService(
			stateManager as any,
			{ ai: false, baseBranch: "main", github: { enabled: true }, linear: { enabled: false } } as any,
			() => repoPath,
			() => {},
		);

		const data = await service.build();
		const card = data.groups[0]?.trees[0];
		expect(card?.ahead).toBe(0);
		expect(card?.hasTrackingRef).toBe(false);
	});
});
