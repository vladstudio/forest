import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/notify", () => ({
  notify: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/commands/create", () => ({
  pickIssue: vi.fn(),
  createIssue: vi.fn(),
}));

// Keep updateLinear inert; it runs via runStep → ctx.outputChannel.
vi.mock("../../src/cli/linear", () => ({
  isAvailable: () => false,
}));

import { notify } from "../../src/notify";
import { pickIssue } from "../../src/commands/create";
import { linkTicket } from "../../src/commands/linkTicket";
import type { ForestContext } from "../../src/context";

function ctx(repoPath: string, trees: any[]): ForestContext {
  const state = {
    version: 1 as const,
    trees: Object.fromEntries(
      trees.map((t) => [`${t.repoPath}:${t.branch}`, t]),
    ),
  };
  return {
    repoPath,
    stateManager: {
      load: vi.fn(async () => state),
      getTreesForRepo: (s: typeof state, rp: string) =>
        Object.values(s.trees).filter((t: any) => t.repoPath === rp),
      findTreeByTicket: (
        s: typeof state,
        rp: string,
        ticketId: string,
        opts?: { excludeBranch?: string },
      ) =>
        Object.values(s.trees).find(
          (t: any) =>
            t.repoPath === rp &&
            t.ticketId === ticketId &&
            (!opts?.excludeBranch || t.branch !== opts.excludeBranch),
        ),
      updateTree: vi.fn(),
    },
    config: { linear: { statuses: { onNew: "started" } } } as any,
  } as any;
}

describe("linkTicket", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks linking a ticket already used by another branch", async () => {
    vi.mocked(pickIssue).mockResolvedValue({ ticketId: "KAD-1", title: "x" });
    const c = ctx("/repo", [
      { repoPath: "/repo", branch: "other", ticketId: "KAD-1", path: "/t/other" },
    ]);

    await linkTicket(c, "mine", "select");

    expect(notify.error).toHaveBeenCalledWith(
      expect.stringContaining('Tree for ticket "KAD-1" already exists'),
    );
    expect(c.stateManager.updateTree).not.toHaveBeenCalled();
  });

  it("allows re-linking the same ticket on the branch that already has it", async () => {
    vi.mocked(pickIssue).mockResolvedValue({ ticketId: "KAD-1", title: "x" });
    const c = ctx("/repo", [
      { repoPath: "/repo", branch: "mine", ticketId: "KAD-1", path: "/t/mine" },
    ]);

    await linkTicket(c, "mine", "select");

    expect(notify.error).not.toHaveBeenCalled();
    expect(c.stateManager.updateTree).toHaveBeenCalledWith(
      "/repo",
      "mine",
      expect.objectContaining({ ticketId: "KAD-1" }),
    );
  });
});
