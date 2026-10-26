// Codex single-quota guard. Free-plan accounts expose one long (~30d) quota
// window and no weekly window, so once it is exhausted the connection stays
// useless until that window resets. Instead of re-probing it after every
// cooldown, the connection is disabled (isActive=false) with a marker, and a
// daily recheck (03:00 Asia/Ho_Chi_Minh) re-enables it once quota is back.
// Connections disabled by the user carry no marker and are never touched.

import { getSettings, updateSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { CODEX_QUOTA_GUARD_CONFIG } from "@/shared/constants/config";
import * as log from "../utils/logger.js";

const C = CODEX_QUOTA_GUARD_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__codexQuotaGuard ??= {
  interval: null,
  running: false,
  lastRunDate: null,
  inFlight: new Set(),
});

function buildProxyOptions(cfg = {}) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: cfg.strictProxy === true,
  };
}

/** One quota window only (session) and no weekly window → Free-plan style account. */
export function isSingleQuotaUsage(usage) {
  const quotas = usage?.quotas;
  return Boolean(quotas?.session) && !quotas.weekly;
}

function isSessionExhausted(usage) {
  return usage?.limitReached === true || usage?.quotas?.session?.remaining <= 0;
}

function connLabel(conn, fallbackId) {
  return conn?.email || conn?.displayName || conn?.name || String(fallbackId || "").slice(0, 8);
}

async function loadRefreshCredentials() {
  // Lazy: the usage route pulls in the executor graph, only needed by the daily job.
  const { refreshAndUpdateCredentials } = await import("@/app/api/usage/[connectionId]/route.js");
  return refreshAndUpdateCredentials;
}

function createDefaultDeps() {
  return {
    getSettings,
    updateSettings,
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    getCodexUsage,
    refreshAndUpdateCredentials: async (...args) => (await loadRefreshCredentials())(...args),
  };
}

/**
 * Called after a Codex 429 usage_limit_reached. Confirms via the usage API that the
 * account has a single exhausted quota window before disabling it; any doubt
 * (usage API down, weekly window present, quota left) leaves the connection alone
 * and the regular modelLock cooldown applies.
 * @returns {Promise<boolean>} true when the connection was disabled
 */
export async function handleCodexQuotaExhausted({ connectionId, accessToken, providerSpecificData, connectionName }, deps = createDefaultDeps()) {
  if (!connectionId || !accessToken || g.inFlight.has(connectionId)) return false;
  g.inFlight.add(connectionId);
  try {
    const usage = await deps.getCodexUsage(accessToken, buildProxyOptions(providerSpecificData));
    if (!isSingleQuotaUsage(usage) || !isSessionExhausted(usage)) return false;

    await deps.updateProviderConnection(connectionId, {
      isActive: false,
      autoDisabledReason: C.disabledReason,
      autoDisabledAt: new Date().toISOString(),
    });
    log.warn("CODEX_QUOTA", `${connectionName || connectionId.slice(0, 8)} single quota exhausted → disabled until ${usage.quotas.session.resetAt || "reset"}`);
    return true;
  } catch (e) {
    log.warn("CODEX_QUOTA", `${connectionName || connectionId.slice(0, 8)} quota check failed: ${e.message}`);
    return false;
  } finally {
    g.inFlight.delete(connectionId);
  }
}

/**
 * Re-enable auto-disabled Codex connections whose quota has reset.
 * Only connections carrying the auto-disable marker are checked.
 * @returns {Promise<{ checked: number, enabled: number }>}
 */
export async function runCodexQuotaRecheck(deps = createDefaultDeps()) {
  const conns = await deps.getProviderConnections({ provider: "codex", isActive: false });
  const targets = conns.filter((c) => c.autoDisabledReason === C.disabledReason);
  let enabled = 0;

  for (const conn of targets) {
    const label = connLabel(conn, conn.id);
    try {
      const proxyOptions = buildProxyOptions(await deps.resolveConnectionProxyConfig(conn.providerSpecificData || {}));
      const { connection } = await deps.refreshAndUpdateCredentials(conn, false, proxyOptions);
      const usage = await deps.getCodexUsage(connection.accessToken, proxyOptions);

      // Usage API unavailable → keep disabled, next daily run retries.
      if (!usage?.quotas?.session) {
        log.warn("CODEX_QUOTA", `${label} recheck: usage unavailable, kept disabled`);
        continue;
      }
      if (isSessionExhausted(usage)) {
        log.info("CODEX_QUOTA", `${label} recheck: still exhausted until ${usage.quotas.session.resetAt || "unknown"}`);
        continue;
      }

      // testStatus "active" also clears leftover modelLock_* / error state in the repo.
      await deps.updateProviderConnection(conn.id, {
        isActive: true,
        testStatus: "active",
        autoDisabledReason: null,
        autoDisabledAt: null,
      });
      enabled += 1;
      log.info("CODEX_QUOTA", `${label} recheck: quota available → re-enabled`);
    } catch (e) {
      log.warn("CODEX_QUOTA", `${label} recheck failed: ${e.message}`);
    }
  }

  return { checked: targets.length, enabled };
}

/** Local date (YYYY-MM-DD) and hour in the configured time zone. */
export function getZonedDateHour(nowMs, timeZone = C.timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/**
 * Returns today's local date when the daily recheck is due, else null.
 * Due once per local day at/after recheckHour, so a server that was down at
 * 03:00 catches up on its next tick that day.
 */
export function getDueRecheckDate(lastRunDate, nowMs = Date.now()) {
  const { date, hour } = getZonedDateHour(nowMs);
  if (hour < C.recheckHour || lastRunDate === date) return null;
  return date;
}

export async function runCodexQuotaGuardTick(deps = createDefaultDeps(), nowMs = Date.now(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    // Clock + in-memory check first: most ticks never touch the DB.
    if (!getDueRecheckDate(state.lastRunDate, nowMs)) return;
    const settings = await deps.getSettings();
    const dueDate = getDueRecheckDate(settings?.[C.lastRunSettingsKey], nowMs);
    if (!dueDate) {
      state.lastRunDate = settings?.[C.lastRunSettingsKey] || null;
      return;
    }

    // Mark the day first so a crash mid-run never loops the recheck.
    await deps.updateSettings({ [C.lastRunSettingsKey]: dueDate });
    state.lastRunDate = dueDate;
    const { checked, enabled } = await runCodexQuotaRecheck(deps);
    if (checked > 0) log.info("CODEX_QUOTA", `daily recheck ${dueDate}: ${enabled}/${checked} re-enabled`);
  } catch (e) {
    log.warn("CODEX_QUOTA", `tick error: ${e.message}`);
  } finally {
    state.running = false;
  }
}

export function startCodexQuotaGuard() {
  if (g.interval) return;
  runCodexQuotaGuardTick().catch(() => {});
  g.interval = setInterval(() => { runCodexQuotaGuardTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopCodexQuotaGuard() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
}
