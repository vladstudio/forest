import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	copyConfigFiles,
	symlinkConfigDirs,
} from "../../src/commands/shared";

describe("shared command helpers", () => {
	it("copies configured files into the tree", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-shared-"));
		const repoPath = path.join(root, "repo");
		const treePath = path.join(root, "tree");
		fs.mkdirSync(path.join(repoPath, "config"), { recursive: true });
		fs.mkdirSync(treePath, { recursive: true });
		fs.writeFileSync(path.join(repoPath, "config", ".env.local"), "TOKEN=1\n");

		copyConfigFiles(
			{ copy: ["config/.env.local", "missing.txt"] } as any,
			repoPath,
			treePath,
		);

		expect(fs.readFileSync(path.join(treePath, "config", ".env.local"), "utf8")).toBe(
			"TOKEN=1\n",
		);
	});

	it("creates relative symlinks for configured directories", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-shared-"));
		const repoPath = path.join(root, "repo");
		const treePath = path.join(root, "tree");
		const source = path.join(repoPath, "node_modules");
		const target = path.join(treePath, "node_modules");
		fs.mkdirSync(source, { recursive: true });
		fs.mkdirSync(treePath, { recursive: true });

		symlinkConfigDirs({ symlink: ["node_modules"] } as any, repoPath, treePath);

		expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
		expect(path.resolve(path.dirname(target), fs.readlinkSync(target))).toBe(source);
	});

	it("refuses to replace a non-symlink target", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "forest-shared-"));
		const repoPath = path.join(root, "repo");
		const treePath = path.join(root, "tree");
		fs.mkdirSync(path.join(repoPath, "node_modules"), { recursive: true });
		fs.mkdirSync(path.join(treePath, "node_modules"), { recursive: true });

		expect(() =>
			symlinkConfigDirs({ symlink: ["node_modules"] } as any, repoPath, treePath),
		).toThrow("Refusing to replace non-symlink");
	});
});
