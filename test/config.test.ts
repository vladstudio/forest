import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/context", () => ({
	getHostWorkspacePath: vi.fn(),
	resolveMainRepo: vi.fn(),
}));

vi.mock("../src/notify", () => ({
	notify: {
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

import { getHostWorkspacePath, resolveMainRepo } from "../src/context";
import { loadConfig } from "../src/config";
import { notify } from "../src/notify";

describe("loadConfig", () => {
	beforeEach(() => {
		vi.mocked(getHostWorkspacePath).mockReset();
		vi.mocked(resolveMainRepo).mockReset();
		vi.mocked(notify.error).mockReset();
		vi.mocked(notify.warn).mockReset();
	});

	it("merges config and local overrides with normalization", async () => {
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "forest-config-"));
		fs.mkdirSync(path.join(repoPath, ".forest"), { recursive: true });
		fs.writeFileSync(
			path.join(repoPath, ".forest", "config.json"),
			JSON.stringify({
				version: 1,
				baseBranch: " origin/trunk ",
				github: true,
				shortcuts: {
					cli: [{ name: "dev", command: "bun dev" }],
					files: [{ name: "notes", path: "docs/NOTES.md" }],
				},
			}),
		);
		fs.writeFileSync(
			path.join(repoPath, ".forest", "local.json"),
			JSON.stringify({
				github: false,
				linear: { apiKey: "lin_api_123" },
				browser: "Firefox",
				terminal: "Ghostty",
				shortcuts: {
					cli: [
						{ name: "dev", env: { PORT: "3000" } },
						{ name: "shell" },
					],
				},
			}),
		);
		vi.mocked(getHostWorkspacePath).mockReturnValue(repoPath);
		vi.mocked(resolveMainRepo).mockReturnValue(repoPath);

		const config = await loadConfig();

		expect(config).not.toBeNull();
		expect(config?.baseBranch).toBe("trunk");
		expect(config?.github.enabled).toBe(false);
		expect(config?.linear.enabled).toBe(true);
		expect(config?.browser).toEqual(["Firefox"]);
		expect(config?.terminal).toEqual(["Ghostty"]);
		expect(config?.shortcuts.cli).toEqual([
			{
				name: "dev",
				command: "bun dev",
				env: { PORT: "3000" },
				type: "terminal",
			},
			{ name: "shell", type: "terminal" },
		]);
		expect((config?.shortcuts as any).files).toBeUndefined();
	});

	it("returns null for invalid config paths", async () => {
		const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "forest-config-"));
		fs.mkdirSync(path.join(repoPath, ".forest"), { recursive: true });
		fs.writeFileSync(
			path.join(repoPath, ".forest", "config.json"),
			JSON.stringify({
				version: 1,
				copy: ["../secrets"],
			}),
		);
		vi.mocked(getHostWorkspacePath).mockReturnValue(repoPath);
		vi.mocked(resolveMainRepo).mockReturnValue(repoPath);

		await expect(loadConfig()).resolves.toBeNull();
		expect(notify.error).toHaveBeenCalledWith(
			expect.stringContaining("copy/symlink path cannot contain"),
		);
	});
});
