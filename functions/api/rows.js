// functions/api/rows.js
// Handles: GET /api/rows  (list everything)
//          POST /api/rows (create a new project row)

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM rows ORDER BY no ASC").all();
  return json(results.map(rowFromDb));
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { address, wbs, stage, startDate } = body;
  if (!address || !wbs || !stage || !startDate) {
    return json({ error: "address, wbs, stage and startDate are all required" }, 400);
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  const maxNoRow = await env.DB.prepare("SELECT MAX(no) AS maxNo FROM rows").first();
  const no = (maxNoRow && maxNoRow.maxNo ? maxNoRow.maxNo : 0) + 1;

  const history = [{ type: "CREATED", ts: now, detail: `Project logged — stage: ${stage}` }];

  await env.DB.prepare(
    `INSERT INTO rows
       (id, no, address, wbs, stage, start_date, state, state_changed_at, held_accumulated_sec, comment, history, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, no, address, wbs, stage, startDate, null, now, 0, "", JSON.stringify(history), now)
    .run();

  const row = await env.DB.prepare("SELECT * FROM rows WHERE id = ?").bind(id).first();
  return json(rowFromDb(row), 201);
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
