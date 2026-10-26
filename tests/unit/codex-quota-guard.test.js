import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

const {
  isSingleQuotaUsage,
  handleCodexQuotaExhausted,
  runCodexQuotaRecheck,
  getDueRecheckDate,
  runCodexQuotaGuardTick,
} = await import("../../src/sse/services/codexQuotaGuard.js");

const FREE_EXHAUSTED = {
  plan: "free",
  limitReached: true,
  quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-11-20T00:00:00.000Z" } },
};
const FREE_AVAILABLE = {
  plan: "free",
  limitReached: false,
  quotas: { session: { used: 0, total: 100, remaining: 100, resetAt: "2026-11-25T00:00:00.000Z" } },
};
const PLUS_EXHAUSTED = {
  plan: "plus",
  limitReached: true,
  quotas: {
    session: { used: 100, total: 100, remaining: 0 },
    weekly: { used: 40, total: 100, remaining: 60 },
  },
};

function makeDeps(overrides = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
    getProviderConnections: vi.fn().mockResolvedValue([]),
    updateProviderConnection: vi.fn().mockResolvedValue({}),
    resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
    getCodexUsage: vi.fn(),
    refreshAndUpdateCredentials: vi.fn(async (conn) => ({ connection: { ...conn, accessToken: "fresh" } })),
    ...overrides,
  };
}

describe("isSingleQuotaUsage", () => {
  it("is true only for a session window without weekly", () => {
    expect(isSingleQuotaUsage(FREE_EXHAUSTED)).toBe(true);
    expect(isSingleQuotaUsage(PLUS_EXHAUSTED)).toBe(false);
    expect(isSingleQuotaUsage({ message: "Usage API temporarily unavailable (500)." })).toBe(false);
  });
});

describe("handleCodexQuotaExhausted", () => {
  let deps;
  beforeEach(() => { deps = makeDeps(); });

  it("disables a single-quota account whose quota is exhausted, with the marker", async () => {
    deps.getCodexUsage.mockResolvedValue(FREE_EXHAUSTED);
    const disabled = await handleCodexQuotaExhausted({ connectionId: "c1", accessToken: "tok" }, deps);

    expect(disabled).toBe(true);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("c1", expect.objectContaining({
      isActive: false,
      autoDisabledReason: "codex_quota",
    }));
  });

  it("leaves accounts with a weekly window (Plus/Pro) to the regular cooldown", async () => {
    deps.getCodexUsage.mockResolvedValue(PLUS_EXHAUSTED);
    expect(await handleCodexQuotaExhausted({ connectionId: "c1", accessToken: "tok" }, deps)).toBe(false);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not disable when usage shows quota left or the usage API fails", async () => {
    deps.getCodexUsage.mockResolvedValueOnce(FREE_AVAILABLE);
    expect(await handleCodexQuotaExhausted({ connectionId: "c1", accessToken: "tok" }, deps)).toBe(false);

    deps.getCodexUsage.mockRejectedValueOnce(new Error("network"));
    expect(await handleCodexQuotaExhausted({ connectionId: "c1", accessToken: "tok" }, deps)).toBe(false);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("runCodexQuotaRecheck", () => {
  it("only rechecks auto-disabled connections and re-enables those with quota back", async () => {
    const deps = makeDeps({
      getProviderConnections: vi.fn().mockResolvedValue([
        { id: "auto-ok", provider: "codex", isActive: false, autoDisabledReason: "codex_quota" },
        { id: "auto-empty", provider: "codex", isActive: false, autoDisabledReason: "codex_quota" },
        { id: "manual", provider: "codex", isActive: false },
      ]),
      getCodexUsage: vi.fn(),
    });
    deps.refreshAndUpdateCredentials.mockImplementation(async (conn) => ({ connection: { ...conn, accessToken: `tok-${conn.id}` } }));
    deps.getCodexUsage.mockImplementation(async (token) => (token === "tok-auto-ok" ? FREE_AVAILABLE : FREE_EXHAUSTED));

    const result = await runCodexQuotaRecheck(deps);

    expect(deps.getProviderConnections).toHaveBeenCalledWith({ provider: "codex", isActive: false });
    expect(result).toEqual({ checked: 2, enabled: 1 });
    expect(deps.refreshAndUpdateCredentials).not.toHaveBeenCalledWith(expect.objectContaining({ id: "manual" }), expect.anything(), expect.anything());
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("auto-ok", {
      isActive: true,
      testStatus: "active",
      autoDisabledReason: null,
      autoDisabledAt: null,
    });
  });

  it("keeps the connection disabled when refresh fails or usage is unavailable", async () => {
    const deps = makeDeps({
      getProviderConnections: vi.fn().mockResolvedValue([
        { id: "a", isActive: false, autoDisabledReason: "codex_quota" },
        { id: "b", isActive: false, autoDisabledReason: "codex_quota" },
      ]),
      getCodexUsage: vi.fn().mockResolvedValue({ message: "Usage API temporarily unavailable (503)." }),
    });
    deps.refreshAndUpdateCredentials.mockRejectedValueOnce(new Error("Refresh token invalid"));

    const result = await runCodexQuotaRecheck(deps);

    expect(result).toEqual({ checked: 2, enabled: 0 });
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("daily schedule (Asia/Ho_Chi_Minh, 03:00)", () => {
  // 2026-10-26T19:59Z = 02:59 on 2026-10-27 in HCM (UTC+7)
  const BEFORE = Date.parse("2026-10-26T19:59:00Z");
  const AT = Date.parse("2026-10-26T20:00:00Z");

  it("is due once per local day at/after 03:00", () => {
    expect(getDueRecheckDate(null, BEFORE)).toBeNull();
    expect(getDueRecheckDate(null, AT)).toBe("2026-10-27");
    expect(getDueRecheckDate("2026-10-27", AT)).toBeNull();
    expect(getDueRecheckDate("2026-10-26", AT + 6 * 3600_000)).toBe("2026-10-27");
  });

  it("tick records the run date before rechecking and skips the rest of the day", async () => {
    const state = { running: false, lastRunDate: null };
    const deps = makeDeps();

    await runCodexQuotaGuardTick(deps, BEFORE, state);
    expect(deps.getSettings).not.toHaveBeenCalled();

    await runCodexQuotaGuardTick(deps, AT, state);
    expect(deps.updateSettings).toHaveBeenCalledWith({ codexQuotaRecheckLastRun: "2026-10-27" });
    expect(deps.getProviderConnections).toHaveBeenCalledTimes(1);

    await runCodexQuotaGuardTick(deps, AT + 60_000, state);
    expect(deps.getSettings).toHaveBeenCalledTimes(1);
    expect(deps.getProviderConnections).toHaveBeenCalledTimes(1);
  });

  it("does not rerun when another process already ran today", async () => {
    const state = { running: false, lastRunDate: null };
    const deps = makeDeps({ getSettings: vi.fn().mockResolvedValue({ codexQuotaRecheckLastRun: "2026-10-27" }) });

    await runCodexQuotaGuardTick(deps, AT, state);
    expect(deps.updateSettings).not.toHaveBeenCalled();
    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(state.lastRunDate).toBe("2026-10-27");
  });
});
