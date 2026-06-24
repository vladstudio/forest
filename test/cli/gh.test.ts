import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/exec", () => ({
	exec: vi.fn(),
	commandExists: vi.fn(),
}));

vi.mock("../../src/notify", () => ({
	notify: {
		warn: vi.fn(),
	},
}));

import { notify } from "../../src/notify";
import * as exec from "../../src/utils/exec";
import { clearCache, prStatus } from "../../src/cli/gh";

describe("gh cli helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearCache();
	});

	it("returns null when gh reports no PR for the branch", async () => {
		vi.mocked(exec.exec).mockRejectedValue({ stderr: "no pull requests found for branch \"feature\"" });

		await expect(prStatus("/repo")).resolves.toBeNull();
		expect(notify.warn).not.toHaveBeenCalled();
	});

	it("warns on auth errors and throws instead of silently returning null", async () => {
		vi.mocked(exec.exec).mockRejectedValue({ stderr: "run gh auth login to authenticate" });

		await expect(prStatus("/repo")).rejects.toThrow("GitHub PR status failed");
		expect(notify.warn).toHaveBeenCalledWith(
			expect.stringContaining("gh auth login"),
		);
	});
});
