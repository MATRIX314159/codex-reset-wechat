import test from "node:test";
import assert from "node:assert/strict";
import {
  unwrapStatus,
  unwrapHistory,
  collectStatusEvents,
  collectHistoryEvents,
  beijingTime,
} from "../scripts/monitor.mjs";

test("unwraps direct and wrapped codex-resets payloads", () => {
  const directStatus = { latest_reset: null, scheduled_reset: null, active_watch: null, stats: {} };
  assert.equal(unwrapStatus(directStatus), directStatus);
  assert.deepEqual(unwrapStatus({ data: directStatus }), directStatus);

  const records = [{ id: "1", reset_type: "regular" }];
  assert.equal(unwrapHistory(records), records);
  assert.deepEqual(unwrapHistory({ data: records }), records);
});

test("maps site status to yellow/orange without text guessing", () => {
  const pending = collectStatusEvents({
    scheduled_reset: {
      id: "a",
      announced_at: "2026-09-22T04:31:00Z",
      scheduled_for: null,
      text: "See you soon",
    },
    active_watch: null,
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "possible");

  const scheduled = collectStatusEvents({
    scheduled_reset: {
      id: "a",
      announced_at: "2026-09-22T04:31:00Z",
      scheduled_for: "2026-09-23T01:00:00Z",
      text: "Reset later",
    },
    active_watch: null,
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].kind, "scheduled");
  assert.match(scheduled[0].body, /2026-09-23 09:00:00/);
});

test("maps only structured regular/banked history and ignores no_reset", () => {
  const events = collectHistoryEvents([
    { id: "r1", reset_type: "regular", announced_at: "2026-09-26T18:17:54Z", text: "done" },
    { id: "b1", reset_type: "banked", announced_at: "2026-09-22T18:23:00Z", text: "banked" },
    { id: "n1", reset_type: "no_reset", announced_at: "2026-09-20T18:23:00Z", text: "reset maybe" },
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.kind).sort(), ["banked", "regular"]);
});

test("converts UTC to Beijing time", () => {
  assert.equal(beijingTime("2026-09-26T18:17:54Z"), "2026-09-27 02:17:54");
});
