import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const STATE_PATH = path.resolve(".state/codex-reset-wechat-v3.json");
const BASE_URL = "https://codex-resets.com";
const STATUS_URL = `${BASE_URL}/api/v1/status`;
const RESETS_URL = `${BASE_URL}/api/v1/resets?limit=30`;
const SITE_URL = `${BASE_URL}/zh-CN`;

const sendKey = process.env.SERVERCHAN_SENDKEY || "";
const sendTest = String(process.env.SEND_TEST || "false").toLowerCase() === "true";
const sendCurrent = String(process.env.SEND_CURRENT || "false").toLowerCase() === "true";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "codex-reset-wechat-monitor/3.0",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) await sleep(1200);
    }
  }
  throw lastError;
}

export function unwrapStatus(payload) {
  if (
    payload?.data &&
    !Array.isArray(payload.data) &&
    typeof payload.data === "object" &&
    (
      "latest_reset" in payload.data ||
      "scheduled_reset" in payload.data ||
      "active_watch" in payload.data ||
      "stats" in payload.data
    )
  ) {
    return payload.data;
  }
  return payload || {};
}

export function unwrapHistory(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.resets)) return payload.resets;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.events)) return payload.events;
  return [];
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

function stableId(record) {
  if (!record) return "unknown";
  return String(
    record.id ||
    record.post_id ||
    record.source?.id ||
    record.source_record_id ||
    sha(JSON.stringify(record))
  );
}

function textOf(record) {
  return (
    record?.translation?.text ||
    record?.text ||
    record?.summary ||
    record?.message ||
    record?.reason ||
    ""
  ).trim();
}

function sourceUrlOf(record) {
  return record?.source?.url || record?.source_url || record?.url || SITE_URL;
}

function parseTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function beijingTime(value) {
  const d = parseTime(value);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function announcedAtOf(record) {
  return record?.announced_at || record?.timestamp || record?.created_at || record?.date || null;
}

function scheduledForOf(record) {
  return record?.scheduled_for || record?.scheduled_at || record?.scheduledAt || null;
}

function quote(text) {
  if (!text) return "_站点没有返回公告正文_";
  const clipped = text.length > 1400 ? `${text.slice(0, 1400)}…` : text;
  return clipped.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function commonLines(record) {
  const lines = [];
  const announced = beijingTime(announcedAtOf(record));
  if (announced) lines.push(`**公告时间（北京时间）：** ${announced}`);
  const source = sourceUrlOf(record);
  if (textOf(record)) {
    lines.push("", "**公告正文：**", quote(textOf(record)));
  }
  lines.push("", `**原始来源：** ${source}`, `**追踪页面：** ${SITE_URL}`);
  return lines;
}

function pendingEvent(record, reason) {
  const id = stableId(record);
  return {
    key: `pending:${id}`,
    kind: "possible",
    title: "🟡 Codex 可能/即将重置",
    occurredAt: announcedAtOf(record),
    body: [
      "**状态：** codex-resets.com 已出现待执行重置信号，但暂未给出确定时间。",
      `**依据：** ${reason}`,
      ...commonLines(record),
      "",
      "_这是第三方追踪站点的当前状态，不是 OpenAI 对具体到账时间的保证。_",
    ].join("\n"),
  };
}

function scheduledEvent(record) {
  const id = stableId(record);
  const when = scheduledForOf(record);
  return {
    key: `scheduled:${id}:${when}`,
    kind: "scheduled",
    title: "🟠 Codex 已公布重置时间",
    occurredAt: announcedAtOf(record),
    body: [
      "**状态：** codex-resets.com 已给出待执行重置时间。",
      `**预计北京时间：** ${beijingTime(when) || String(when)}`,
      ...commonLines(record),
      "",
      "_时间来自第三方追踪站点；若原帖表达的是“最迟到账/时间窗口”，实际到账可能并非精确到这一分钟。_",
    ].join("\n"),
  };
}

function regularEvent(record) {
  const id = stableId(record);
  return {
    key: `regular:${id}`,
    kind: "regular",
    title: "🟢 Codex 已经重置",
    occurredAt: announcedAtOf(record),
    body: [
      "**状态：** codex-resets.com 新增了一条 regular/global reset 记录。",
      ...commonLines(record),
      "",
      "_全局记录不等于你的账户已在同一秒到账；最终以 Codex → Profile → Usage 为准。_",
    ].join("\n"),
  };
}

function bankedEvent(record) {
  const id = stableId(record);
  return {
    key: `banked:${id}`,
    kind: "banked",
    title: "🔵 Codex Banked Reset 重置卡",
    occurredAt: announcedAtOf(record),
    body: [
      "**状态：** codex-resets.com 新增了一条 Banked Reset 记录。",
      ...commonLines(record),
      "",
      "**核实位置：** Codex → Profile → Usage → 查看是否有可 Redeem 的 reset。",
      "_Banked Reset 通常需要手动兑换，资格与到账时间以你的账户页面为准。_",
    ].join("\n"),
  };
}

function dedupeEvents(events) {
  const map = new Map();
  for (const event of events) {
    if (event && !map.has(event.key)) map.set(event.key, event);
  }
  return [...map.values()];
}

export function collectStatusEvents(status) {
  const events = [];
  const scheduled = status?.scheduled_reset || null;
  const watch = status?.active_watch || null;

  // 站点自己的 scheduled_reset 是最直接的待执行状态。
  if (scheduled) {
    if (scheduledForOf(scheduled)) {
      events.push(scheduledEvent(scheduled));
    } else {
      events.push(pendingEvent(scheduled, "站点标记了 scheduled reset，但时间仍为待公布"));
    }
  }

  // active_watch 是站点自己给出的“可能重置”观察信号；不自行做关键词推断。
  if (watch) {
    events.push(pendingEvent(watch, "站点 active_watch 正在生效"));
  }

  return dedupeEvents(events);
}

export function collectHistoryEvents(records) {
  const events = [];
  for (const record of records) {
    const type = String(record?.reset_type || record?.kind || record?.type || "").toLowerCase();

    if (type === "regular" || type === "automatic" || type === "global" || type === "hard_reset") {
      events.push(regularEvent(record));
      continue;
    }

    if (type === "banked" || type === "banked_reset" || type === "credit") {
      events.push(bankedEvent(record));
      continue;
    }

    // codex-resets.com 还会有 no_reset 一类；明确忽略，不再用正文关键词猜测。
  }
  return dedupeEvents(events);
}

function eventEpoch(event) {
  const d = parseTime(event.occurredAt);
  return d ? d.getTime() : 0;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed.initialized),
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
    };
  } catch {
    return { initialized: false, seen: [] };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const trimmed = [...new Set(state.seen)].slice(-800);
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify({ initialized: true, seen: trimmed, updated_at: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function serverChanUrl(key) {
  if (/^sctp\d+t/i.test(key)) {
    const match = key.match(/^sctp(\d+)t/i);
    return `https://${match[1]}.push.ft07.com/send/${key}.send`;
  }
  return `https://sctapi.ftqq.com/${key}.send`;
}

async function sendWeChat(title, body) {
  if (!sendKey) throw new Error("Missing GitHub secret SERVERCHAN_SENDKEY");

  const response = await fetch(serverChanUrl(sendKey), {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({ title, desp: body }),
    signal: AbortSignal.timeout(15000),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`ServerChan HTTP ${response.status}: ${raw.slice(0, 300)}`);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`ServerChan returned non-JSON: ${raw.slice(0, 300)}`);
  }

  const code = payload?.code ?? payload?.data?.errno ?? 0;
  if (Number(code) !== 0) throw new Error(`ServerChan rejected request: ${raw.slice(0, 500)}`);
}

function combinedBody(events) {
  return events.map((event, index) => [
    `## ${index + 1}. ${event.title}`,
    "",
    event.body,
  ].join("\n")).join("\n\n---\n\n");
}

async function main() {
  if (sendTest) {
    await sendWeChat(
      "✅ Codex 微信监控测试",
      [
        "如果你看到这条消息，说明 **GitHub Actions → Server酱 → 微信** 正常。",
        "",
        `当前唯一监控源：${SITE_URL}`,
        "",
        "之后只有 codex-resets.com 出现新的待执行、定时、regular reset 或 banked reset 状态时才会推送。",
      ].join("\n")
    );
    console.log("Test notification sent.");
  }

  const [statusPayload, historyPayload] = await Promise.all([
    fetchJson(STATUS_URL),
    fetchJson(RESETS_URL),
  ]);

  const status = unwrapStatus(statusPayload);
  const history = unwrapHistory(historyPayload);

  if (
    !("latest_reset" in status) &&
    !("scheduled_reset" in status) &&
    !("active_watch" in status) &&
    !("stats" in status) &&
    history.length === 0
  ) {
    throw new Error("codex-resets.com API schema is not recognized; refusing to silently miss alerts.");
  }

  const statusEvents = collectStatusEvents(status);
  const historyEvents = collectHistoryEvents(history);
  const allEvents = dedupeEvents([...statusEvents, ...historyEvents]);

  console.log(`Source: ${BASE_URL}`);
  console.log(`Detected ${statusEvents.length} active status event(s) and ${historyEvents.length} history event(s).`);

  const state = await loadState();

  if (!state.initialized) {
    // 升级/首次部署不回放历史，避免刷屏。
    state.seen.push(...allEvents.map((e) => e.key));

    if (sendCurrent) {
      const latestHistory = [...historyEvents].sort((a, b) => eventEpoch(b) - eventEpoch(a))[0];
      const current = dedupeEvents([...statusEvents, ...(latestHistory ? [latestHistory] : [])]);
      if (current.length > 0) {
        await sendWeChat(
          current.length === 1 ? current[0].title : `Codex Reset 当前状态（${current.length}项）`,
          current.length === 1 ? current[0].body : combinedBody(current)
        );
        console.log(`Sent ${current.length} current event(s).`);
      }
    }

    await saveState(state);
    console.log("State initialized; old history was not replayed.");
    return;
  }

  const seen = new Set(state.seen);
  const fresh = allEvents
    .filter((event) => !seen.has(event.key))
    .sort((a, b) => eventEpoch(a) - eventEpoch(b));

  if (fresh.length === 0) {
    console.log("No new codex-resets.com events.");
    await saveState(state);
    return;
  }

  // 同一次检查出现多条新事件时合并成 1 条微信，节省 Server酱每日额度。
  await sendWeChat(
    fresh.length === 1 ? fresh[0].title : `Codex Reset 更新（${fresh.length}项）`,
    fresh.length === 1 ? fresh[0].body : combinedBody(fresh)
  );

  state.seen.push(...fresh.map((event) => event.key));
  await saveState(state);
  console.log(`Sent ${fresh.length} new event(s) in one WeChat notification.`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
