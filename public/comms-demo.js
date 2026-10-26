/* =========================================================
   comms-demo.js — FICTIONAL preview data for the Communication
   Tracker. Built in memory on demand, relative to "now".

   * Never written to the database and never sent to the server.
   * Never merged with the user's real tasks or events: the page
     swaps the whole data set while demo preview is on.
   * Every name and address is fictional (example.test is a
     reserved, non-routable domain).
   ========================================================= */
(function () {
  "use strict";
  const H = 3600e3;
  const D = 24 * H;

  function build(now) {
    const task = (id, no, address, wbs, stage, startDaysAgo, state, cpType, cpName, trackedDaysAgo) => ({
      id,
      no,
      address: `DEMO — ${address} (fictional)`,
      wbs,
      stage,
      startDate: new Date(now - startDaysAgo * D).toISOString().slice(0, 10),
      state,
      stateChangedAt: now - 2 * D,
      heldAccumulatedSec: 0,
      status: "ACTIVE",
      closedAt: null,
      counterpartyType: cpType,
      counterpartyName: cpName,
      trackingStart: cpType ? now - trackedDaysAgo * D : null,
    });

    const tasks = [
      task("demo-1", 1, "12 Example Road", "DEMO-001", "Detail Design", 3, "START", "CUSTOMER", "DEMO Customer A (fictional)", 20),
      task("demo-2", 2, "7 Sample Avenue", "DEMO-002", "Pricing", 1, "HOLD", "CUSTOMER", "DEMO Customer A (fictional)", 20),
      task("demo-3", 3, "40 Placeholder Lane", "DEMO-003", "Indicative", 9, "START", "VECTOR_TEAM", "DEMO Vector Team (fictional)", 30),
      task("demo-4", 4, "3 Imaginary Crescent", "DEMO-004", "Tender", 2, null, "CUSTOMER", "DEMO Customer B (fictional)", 9),
      task("demo-5", 5, "99 Unassigned Street", "DEMO-005", "Not Selected", 0, null, null, null, 0),
    ];

    let n = 0;
    const ev = (rowId, direction, ago, address, extra) => ({
      id: `demo-e${++n}`,
      rowId,
      direction,
      occurredAt: now - ago,
      tz: null,
      address,
      summary: null,
      summaryBasis: "UNAVAILABLE",
      source: "DEMO",
      verified: false,
      replyToId: null,
      threadRef: null,
      notAReply: false,
      ...extra,
    });

    const events = [];
    // demo-1: one answered (linked reply, 2h 14m) + one unanswered for 26h 10m
    const a1 = ev("demo-1", "IN", 52 * H, "contact-a@example.test", { summary: "Customer requests revised connection drawings", summaryBasis: "MANUAL" });
    events.push(a1);
    events.push(ev("demo-1", "OUT", 52 * H - (2 * H + 14 * 60e3), "contact-a@example.test", { replyToId: a1.id, summary: "Drawings revision issued with updated notes", summaryBasis: "MANUAL" }));
    events.push(ev("demo-1", "IN", 26 * H + 10 * 60e3, "contact-a@example.test"));
    // demo-2: sent message to the same address with no link -> needs manual review (not paired)
    events.push(ev("demo-2", "IN", 10 * H, "pm-a@example.test", { summary: "Customer asks about pricing timeline", summaryBasis: "MANUAL" }));
    events.push(ev("demo-2", "OUT", 9 * H, "pm-a@example.test"));
    // demo-3 (Vector team): matched pair long ago; last sent 6.5 days ago; unanswered 31h
    const v1 = ev("demo-3", "IN", 7 * D, "vector-lead@example.test");
    events.push(v1);
    events.push(ev("demo-3", "OUT", 6.5 * D, "vector-lead@example.test", { replyToId: v1.id }));
    events.push(ev("demo-3", "IN", 31 * H, "vector-lead@example.test", { summary: "Vector team queries indicative scope assumptions", summaryBasis: "MANUAL" }));
    // demo-4 and demo-5: nothing recorded (weekly for demo-4 counted from tracking start)

    return { tasks, events, tz: null };
  }

  window.CommsDemo = { build };
})();
