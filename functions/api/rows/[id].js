// functions/api/rows/[id].js
// Handles: PATCH /api/rows/:id
// body.action = "setState" | "update" | "clearComment"

export async function onRequestPatch({ request, env, params }) {
  const id = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const existing = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Row not found" }, 404);

  const history = JSON.parse(existing.history || "[]");
  const now = Date.now();

  if (body.action === "setState") {
    const newState = body.state === "HOLD" ? "HOLD" : "START";

    if (existing.state !== newState) {
      let heldAcc = existing.held_accumulated_sec || 0;

      if (existing.state === "HOLD" && newState === "START") {
        heldAcc += elapsedWorkingSeconds(existing.state_changed_at, now);
      }

      history.push({
        type: newState,
        ts: now,
        detail: newState === "START" ? "Countdown started/resumed" : "Countdown held",
      });

      await env.DB.prepare(
        `UPDATE rows SET state = ?, state_changed_at = ?, held_accumulated_sec = ?, history = ? WHERE id = ?`
      )
        .bind(newState, now, heldAcc, JSON.stringify(history), id)
        .run();
    }
  } else if (body.action === "update") {
    const { address, wbs, stage, startDate, comment } = body;
    if (comment !== existing.comment) {
      history.push({ type: "COMMENT", ts: now, detail: comment ? comment : "(comment cleared)" });
    }
    await env.DB.prepare(
      `UPDATE rows SET address = ?, wbs = ?, stage = ?, start_date = ?, comment = ?, history = ? WHERE id = ?`
    )
      .bind(address, wbs, stage, startDate, comment ?? "", JSON.stringify(history), id)
      .run();
  } else if (body.action === "clearComment") {
    if (existing.comment) {
      history.push({ type: "CLEAR", ts: now, detail: `Cleared: "${existing.comment}"` });
      await env.DB.prepare(`UPDATE rows SET comment = '', history = ? WHERE id = ?`)
        .bind(JSON.stringify(history), id)
        .run();
    }
  } else {
    return json({ error: "Unknown action" }, 400);
  }

  const updated = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  return json(rowFromDb(updated));
}

function elapsedWorkingSeconds(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let curDay = new Date(startMs);
  curDay.setUTCHours(0, 0, 0, 0);

  while (curDay.getTime() <= endMs) {
    const dow = curDay.getUTCDay(); // 0 = Sun ... 6 = Sat
    if (dow !== 0 && dow !== 6) {
      const nextDay = new Date(curDay);
      nextDay.setUTCDate(curDay.getUTCDate() + 1);
      const dayStart = Math.max(curDay.getTime(), startMs);
      const dayEnd = Math.min(nextDay.getTime(), endMs);
      if (dayEnd > dayStart) total += (dayEnd - dayStart) / 1000;
    }
    curDay.setUTCDate(curDay.getUTCDate() + 1);
  }
  return total;
}

function rowFromDb(r) {
  return {
    id: r.id,
    no: r.no,
    address: r.address,
    wbs: r.wbs,
    stage: r.stage,
    startDate: r.start_date,
    state: r.state,
    stateChangedAt: r.state_changed_at,
    heldAccumulatedSec: r.held_accumulated_sec,
    comment: r.comment,
    history: JSON.parse(r.history || "[]"),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
