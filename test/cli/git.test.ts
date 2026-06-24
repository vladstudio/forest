import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWorktree,
	deleteBranch,
	diffFilesBetweenRefs,
	listBranches,
	removeWorktree,
	stash,
	stashApply,
	stashDrop,
} from "../../src/cli/git";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-git-"));
	const home = path.join(root, "home");
	const origin = path.join(root, "origin.git");
	const repo = path.join(root, "repo");
	fs.mkdirSync(home, { recursive: true });
	execFileSync("git", ["init", "--bare", origin], { encoding: "utf8" });
	execFileSync("git", ["clone", origin, repo], { encoding: "utf8" });
	git(repo, "config", "user.name", "Forest Tests");
	git(repo, "config", "user.email", "forest@example.com");
	fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "initial");
	git(repo, "branch", "-M", "main");
	git(repo, "push", "-u", "origin", "main");
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
		cwd: origin,
		encoding: "utf8",
	});
	return { home, repo };
}

describe.sequential("git cli helpers", () => {
	let originalHome = "";

	beforeEach(() => {
		originalHome = process.env.HOME ?? os.homedir();
	});

	afterEach(() => {
		process.env.HOME = originalHome;
	});

	it("creates and removes worktrees", async () => {
		const { home, repo } = makeRepo();
		process.env.HOME = home;
		const worktreePath = path.join(home, ".forest", "trees", "repo", "feature-one");
		fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

		await createWorktree(repo, worktreePath, "feature-one", "main");
		expect(fs.existsSync(path.join(worktreePath, ".git"))).toBe(true);

		await removeWorktree(repo, worktreePath);
		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	it("lists local and remote branches but excludes active worktrees and base", async () => {
		const { repo } = makeRepo();
		git(repo, "branch", "feature-local");
		git(repo, "checkout", "-b", "feature-remote");
		git(repo, "push", "-u", "origin", "feature-remote");
		git(repo, "checkout", "main");
		git(repo, "branch", "-D", "feature-remote");
		git(repo, "branch", "feature-active");
		const activePath = path.join(path.dirname(repo), "active-worktree");
		git(repo, "worktree", "add", activePath, "feature-active");

		const branches = await listBranches(repo, "main");

		expect(branches).toContain("feature-local");
		expect(branches).toContain("feature-remote");
		expect(branches).not.toContain("feature-active");
		expect(branches).not.toContain("main");
	});

	it("stashes, applies to a worktree, and drops the stash", async () => {
		const { home, repo } = makeRepo();
		process.env.HOME = home;
		fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
		fs.writeFileSync(path.join(repo, "note.txt"), "draft\n");

		const ref = await stash(repo, "carry-test");
		const worktreePath = path.join(home, ".forest", "trees", "repo", "carry-branch");
		fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
		await createWorktree(repo, worktreePath, "carry-branch", "main");
		await stashApply(worktreePath, ref);
		await stashDrop(repo, ref);

		expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe(
			"changed\n",
		);
		expect(fs.readFileSync(path.join(worktreePath, "note.txt"), "utf8")).toBe(
			"draft\n",
		);
		expect(git(repo, "stash", "list")).not.toContain("carry-test");
	});

	it("detects renames in diffs", async () => {
		const { repo } = makeRepo();
		fs.writeFileSync(path.join(repo, "old.txt"), "one\n");
		git(repo, "add", "old.txt");
		git(repo, "commit", "-m", "add file");
		git(repo, "mv", "old.txt", "new.txt");
		git(repo, "commit", "-m", "rename file");

		const changes = await diffFilesBetweenRefs(repo, "HEAD^", "HEAD");

		expect(changes).toEqual([
			{ status: "R", originalPath: "old.txt", path: "new.txt" },
		]);
	});

	it("treats missing remote branch during delete as success", async () => {
		const { repo } = makeRepo();
		git(repo, "checkout", "-b", "feature-missing-remote");
		git(repo, "push", "-u", "origin", "feature-missing-remote");
		git(repo, "checkout", "main");
		git(repo, "push", "origin", "--delete", "feature-missing-remote");

		await expect(deleteBranch(repo, "feature-missing-remote")).resolves.toBeUndefined();
		expect(git(repo, "branch", "--list", "feature-missing-remote")).toBe("");
	});

	it("rejects dangerous worktree paths before deleting", async () => {
		const { home, repo } = makeRepo();
		process.env.HOME = home;

		await expect(
			removeWorktree(repo, path.join(home, ".forest", "trees", "repo-only")),
		).rejects.toThrow("refusing dangerous path");
	});
});
