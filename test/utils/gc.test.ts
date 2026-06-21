import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForestState, TreeState } from "../../src/state";
import { gcForestFiles } from "../../src/utils/gc";
import { workspaceFilePath } from "../../src/commands/shared";

const ws = (file: string, treePath: string) =>
	fs.writeFileSync(file, JSON.stringify({ folders: [{ path: treePath }] }));

describe("gcForestFiles", () => {
	const originalHome = process.env.HOME;
	let home = "";
	let logs: string[] = [];

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "forest-home-"));
		process.env.HOME = home;
		logs = [];
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
		if (originalHome) process.env.HOME = originalHome;
		else delete process.env.HOME;
	});

	function state(tree: TreeState): ForestState {
		return { version: 1, trees: { [`${tree.repoPath}:${tree.branch}`]: tree } };
	}

	it("removes stale and duplicate workspaces", () => {
		const tree = { repoPath: "/repo", branch: "feature", path: path.join(home, ".forest/trees/repo/feature"), createdAt: "now" };
		fs.mkdirSync(tree.path, { recursive: true });
		fs.mkdirSync(path.join(home, ".forest/workspaces"), { recursive: true });
		const canonical = workspaceFilePath(tree);
		const duplicate = path.join(home, ".forest/workspaces/old.code-workspace");
		const missing = path.join(home, ".forest/workspaces/missing.code-workspace");
		ws(canonical, tree.path);
		ws(duplicate, tree.path);
		ws(missing, path.join(home, "missing"));

		gcForestFiles(state(tree), (m) => logs.push(m));

		expect(fs.existsSync(canonical)).toBe(true);
		expect(fs.existsSync(duplicate)).toBe(false);
		expect(fs.existsSync(missing)).toBe(false);
	});

	it("removes only empty unknown tree buckets", () => {
		const tree = { repoPath: "/repo", branch: "feature", path: path.join(home, ".forest/trees/repo/feature"), createdAt: "now" };
		const empty = path.join(home, ".forest/trees/repo-empty/nested");
		const nonEmpty = path.join(home, ".forest/trees/repo-full");
		fs.mkdirSync(tree.path, { recursive: true });
		fs.mkdirSync(empty, { recursive: true });
		fs.mkdirSync(nonEmpty, { recursive: true });
		fs.writeFileSync(path.join(nonEmpty, "keep"), "x");

		gcForestFiles(state(tree), (m) => logs.push(m));

		expect(fs.existsSync(path.dirname(empty))).toBe(false);
		expect(fs.existsSync(nonEmpty)).toBe(true);
		expect(fs.existsSync(tree.path)).toBe(true);
	});
});
