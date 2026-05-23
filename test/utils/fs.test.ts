import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeRelativePath } from "../../src/utils/fs";

describe("fs utils", () => {
	it("resolves safe relative paths", () => {
		expect(safeRelativePath("/repo", "a/b.txt", "file")).toBe(
			path.resolve("/repo", "a/b.txt"),
		);
	});

	it("rejects absolute paths", () => {
		expect(() => safeRelativePath("/repo", "/etc/passwd", "file")).toThrow(
			"file must be a relative path",
		);
	});

	it("rejects traversal", () => {
		expect(() => safeRelativePath("/repo", "a/../b", "file")).toThrow(
			'file cannot contain ".."',
		);
	});
});
