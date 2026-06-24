import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/notify", () => ({
	notify: {
		warn: vi.fn(),
	},
}));

import { clearCache, configure, getIssue } from "../../src/cli/linear";

describe("linear cli helpers", () => {
	beforeEach(() => {
		clearCache();
		configure("lin_api_test");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null when Linear returns no issue", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({ data: { issue: null } }),
		})) as any);

		await expect(getIssue("KAD-1")).resolves.toBeNull();
	});

	it("throws on API failures instead of silently returning null", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			text: async () => "boom",
		})) as any);

		await expect(getIssue("KAD-1")).rejects.toThrow("Linear API 500");
	});
});
