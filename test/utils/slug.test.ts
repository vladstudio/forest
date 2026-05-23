import { describe, expect, it } from "vitest";
import {
	formatBranch,
	sanitizeBranch,
	shellEscape,
} from "../../src/utils/slug";

describe("slug utils", () => {
	it("sanitizes branch names", () => {
		expect(sanitizeBranch(" ./Feature  Name//part..two ")).toBe(
			"Feature-Name/part-two",
		);
	});

	it("formats branches from template", () => {
		expect(formatBranch("${ticketId}-${slug}", "ENG-42", "Fix Login Bug")).toBe(
			"ENG-42-fix-login-bug",
		);
	});

	it("escapes shell values", () => {
		expect(shellEscape("plain/path")).toBe("plain/path");
		expect(shellEscape("")).toBe("''");
		expect(shellEscape("it's tricky")).toBe("'it'\\''s tricky'");
	});
});
