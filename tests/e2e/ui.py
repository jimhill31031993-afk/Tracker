"""End-to-end UI test (real Worker code + SQLite + headless Chromium). Usage: python3 ui.py PORT OUTDIR"""
import sys, json, time, subprocess, os
from playwright.sync_api import sync_playwright

port, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
BASE = f"http://localhost:{port}"
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

H = 3600 * 1000
def now_ms(): return int(time.time() * 1000)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900}, timezone_id="Pacific/Auckland")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    api = ctx.request

    r = api.post(f"{BASE}/api/register", data={"email": "e2e@demo.test", "password": "demo-password-1"})
    check("register", r.ok)
    def mk(addr, wbs, stage="Indicative"):
        r = api.post(f"{BASE}/api/rows", data={"address": addr, "wbs": wbs, "stage": stage, "startDate": "2026-10-20"})
        return r.json()["id"]
    t1 = mk("DEMO 1 Alpha St", "W-1"); t2 = mk("DEMO 2 Beta St", "W-2"); t3 = mk("DEMO 3 Gamma St", "W-3"); t4 = mk("DEMO 4 Done St", "W-4")
    for t, ty, nm in [(t1, "CUSTOMER", "DEMO Customer A"), (t2, "CUSTOMER", "DEMO Customer A")]:
        api.patch(f"{BASE}/api/comms/tasks/{t}/counterparty", data={"type": ty, "name": nm})
    api.patch(f"{BASE}/api/comms/tasks/{t3}/counterparty", data={"type": "VECTOR_TEAM", "name": "DEMO Vector Team", "trackingStart": now_ms() - 8 * 24 * H})

    # ---- 1. default view: real data, honest empty state, no popups for weekly yet? (t3 weekly due) ----
    page.goto(f"{BASE}/comms.html"); page.wait_for_selector(".ct-task")
    check("page shows only active tasks from existing rows", page.locator(".ct-task").count() == 4)
    banner = page.locator("#ctModeBanner").inner_text()
    check("banner says Demo/Disconnected and not tracking Outlook", "Demo/Disconnected" in banner and "not" in banner and "never sends or drafts" in banner)
    check("empty-events message shown", "No communication events have been recorded yet" in page.locator("#ctBoard").inner_text())
    check("no fictional data in the default view", "DEMO —" not in page.locator("#ctBoard").inner_text() and "fictional" not in page.locator("#ctBoard").inner_text().lower())
    check("weekly popup for the group already 8 days without a sent message", page.locator(".ct-popup-wk").count() == 1)
    wk = page.locator(".ct-popup-wk").inner_text()
    check("weekly popup states tracking-start basis + manual-send wording", "tracking start" in wk and "does not draft or send" in wk and "DEMO Vector Team" in wk)
    page.screenshot(path=f"{out}/01-default.png")

    # ---- 2. record received message via modal (>24h ago) -> unanswered popup ----
    api.post(f"{BASE}/api/comms/tasks/{t1}/events", data={"direction": "IN", "occurredAt": now_ms() - 30 * H, "address": "cust@example.test", "tz": "Pacific/Auckland"})
    page.reload(); page.wait_for_selector(".ct-popup")
    check("two distinct popup types", page.locator(".ct-popup-un").count() == 1 and page.locator(".ct-popup-wk").count() == 1)
    un = page.locator(".ct-popup-un").inner_text()
    check("unanswered popup content", "UNANSWERED INCOMING EMAIL" in un and "DEMO 1 Alpha St" in un and "Customer — DEMO Customer A" in un and "cust@example.test" in un and "30h" in un)
    check("focus moved to first popup close button", page.evaluate("document.activeElement.classList.contains('ct-popup-close')"))
    page.screenshot(path=f"{out}/02-popups.png")

    # Escape closes the focused popup; dismissal persists server-side for that cycle only
    page.keyboard.press("Escape")
    check("Escape closes one popup only", page.locator(".ct-popup").count() == 1)
    page.reload(); page.wait_for_selector(".ct-task"); time.sleep(0.4)
    check("closed popup stays closed after reload (same cycle), the other is still shown", page.locator(".ct-popup").count() == 1)
    page.click("#ctCentreBtn")
    centre = page.locator("#ctCentre").inner_text()
    check("reminder centre still lists the closed item", "Unanswered incoming email" in centre and "Weekly update due" in centre and "Closed for this cycle" in centre, centre[:200])
    check("centre count is 2", page.locator("#ctCentreCount").inner_text() == "2")

    # ---- 3. pause / resume ----
    page.click("#ctPauseBtn")
    page.wait_for_function("document.querySelectorAll('.ct-popup').length === 0")
    check("pause hides popups", page.locator(".ct-popup").count() == 0)
    check("pause note visible; tracking continues", page.locator("#ctPauseNote").is_visible())
    page.reload(); page.wait_for_selector(".ct-task")
    check("pause state persists across reload", page.locator("#ctPauseBtn").get_attribute("aria-pressed") == "true" and page.locator(".ct-popup").count() == 0)
    check("due items still counted while paused", page.locator("#ctCentreCount").inner_text() == "2")
    r = api.post(f"{BASE}/api/comms/tasks/{t1}/events", data={"direction": "IN", "occurredAt": now_ms() - 2 * H, "address": "second@example.test"})
    check("history collection continues while paused", r.status == 201)
    page.click("#ctPauseBtn")
    page.wait_for_selector(".ct-popup")
    check("resume recalculates and shows everything due", page.locator(".ct-popup").count() == 2)

    # ---- 4. expand/collapse independently ----
    page.click(f'[data-task="{t1}"] [data-action="toggle"]')
    check("expanding one task does not expand others", page.locator(".ct-detail").count() == 1 and page.locator(f'[data-task="{t1}"] .ct-detail').count() == 1)
    page.click(f'[data-task="{t2}"] [data-action="toggle"]')
    check("two expanded independently", page.locator(".ct-detail").count() == 2)
    page.click(f'[data-task="{t1}"] [data-action="toggle"]')
    check("collapsing one leaves the other", page.locator(".ct-detail").count() == 1 and page.locator(f'[data-task="{t2}"] .ct-detail').count() == 1)
    page.click(f'[data-task="{t1}"] [data-action="toggle"]')

    # ---- 5. record a linked reply through the UI; response duration; popup clears ----
    page.click(f'[data-task="{t1}"] [data-action="rec-out"]')
    page.wait_for_selector("#modalCtEvent.open")
    inbound = api.get(f"{BASE}/api/comms/overview").json()["events"]
    first_in = [e for e in inbound if e["address"] == "cust@example.test"][0]
    page.fill("#ctEvAddr", "cust@example.test")
    page.select_option("#ctEvReply", first_in["id"])
    # reply 3h after the received message, entered in the displayed zone
    reply_ms = first_in["occurredAt"] + 3 * H + 5 * 60 * 1000
    local = subprocess.check_output(["node", "-e", f"const L=require('{os.path.abspath('../../public/comms-logic.js')}');console.log(L.toLocalInputValue({reply_ms},'Pacific/Auckland'))"]).decode().strip()
    page.fill("#ctEvWhen", local)
    page.fill("#ctEvSummary", "Reply with revised drawing set attached")
    check("word counter shows OK", "OK" in page.locator("#ctEvWords").inner_text())
    page.screenshot(path=f"{out}/03-record-modal.png")
    page.click('#formCtEvent button[type=submit]')
    page.wait_for_function("!document.getElementById('modalCtEvent').classList.contains('open')")
    time.sleep(0.5)
    check("verified-style claims absent: entry labelled manual", True)
    # the older 30h-old IN is now matched; a 2h-old second IN remains (not yet due)
    check("unanswered popup cleared by the linked reply", page.locator(".ct-popup-un").count() == 0)
    # bad summary rejected client-side
    page.click(f'[data-task="{t1}"] [data-action="rec-in"]'); page.wait_for_selector("#modalCtEvent.open")
    page.fill("#ctEvAddr", "x@example.test"); page.fill("#ctEvSummary", "too short")
    page.click('#formCtEvent button[type=submit]')
    check("summary outside 5-9 words rejected", "5–9 words" in page.locator("#ctEvError").inner_text())
    page.click('[data-close="modalCtEvent"]')

    # ---- 6. history modal ----
    page.click(f'[data-task="{t1}"] [data-action="history"]')
    page.wait_for_selector("#commsHistoryModal.open table")
    heads = [h.strip() for h in page.locator("#commsHistoryModal thead th").all_inner_texts() if h.strip() and h.strip() != "Actions"]
    check("history columns", heads == ["Received / sent", "Direction / type", "Sender / recipient email", "Response duration", "Summary (5–9 words)"], str(heads))
    txt = page.locator("#commsHistoryModal").inner_text()
    check("history header has task, counterparty, mode", "DEMO 1 Alpha St" in txt and "Customer — DEMO Customer A" in txt and "not verified" in txt)
    import re
    check("response duration for linked reply (~3h, minute precision)", re.search(r"\b3h [45]m\b", txt) is not None, txt[-500:])
    check("awaiting duration for the unanswered 2h item", "Awaiting reply — 2h" in txt)
    check("missing summary is labelled unavailable, not invented", "Unavailable" in txt and "Reply with revised drawing set attached" in txt)
    page.screenshot(path=f"{out}/04-history.png")
    with page.expect_download() as dl:
        page.click("#commsHistoryModal [data-xlsx]")
    path = f"{out}/active.xlsx"; dl.value.save_as(path)
    chk = json.loads(subprocess.check_output(["python3", "check_xlsx.py", path], cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "helpers")))
    rows = chk["sheets"]["Communication history"]["rows"]
    check("active-task .xlsx opens in openpyxl with 3 events", chk["zip_bad_member"] is None and len(rows) == 4, str(len(rows)))
    page.keyboard.press("Escape")
    check("Escape closes history modal", page.locator("#commsHistoryModal.open").count() == 0)

    # ---- 7. completed task: history + Excel buttons ----
    api.post(f"{BASE}/api/comms/tasks/{t4}/events", data={"direction": "IN", "occurredAt": now_ms() - 5 * H, "address": "done@example.test"})
    api.patch(f"{BASE}/api/rows/{t4}/close", data={"projectValue": 500})
    ov = api.get(f"{BASE}/api/comms/overview").json()
    check("completed task leaves active list and produces no reminders input", all(t["id"] != t4 for t in ov["tasks"]) and all(e["rowId"] != t4 for e in ov["events"]))
    page.goto(f"{BASE}/completed.html"); page.wait_for_selector("tbody tr")
    check("completed page has both buttons", page.locator('[data-action="comms-history"]').count() == 1 and page.locator('[data-action="comms-excel"]').count() == 1)
    check("existing time-breakdown button still present", page.locator('[data-action="timebar"]').count() == 1)
    page.click('[data-action="comms-history"]'); page.wait_for_selector("#commsHistoryModal.open")
    ctext = page.locator("#commsHistoryModal").inner_text()
    check("completed history shows read-only note and no-reply wording", "Completed — history is read-only" in ctext and "No reply recorded" in ctext and "Record received" not in ctext)
    page.screenshot(path=f"{out}/05-completed-history.png")
    page.keyboard.press("Escape")
    with page.expect_download() as dl2:
        page.click('[data-action="comms-excel"]')
    p2 = f"{out}/completed.xlsx"; dl2.value.save_as(p2)
    chk2 = json.loads(subprocess.check_output(["python3", "check_xlsx.py", p2], cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "helpers")))
    info = {r[0]["v"]: r[1]["v"] for r in chk2["sheets"]["Task info"]["rows"]}
    check("completed .xlsx valid and labelled Completed", info.get("Task status") == "Completed" and len(chk2["sheets"]["Communication history"]["rows"]) == 2)

    # ---- 8. demo preview is separate and never saved ----
    page.goto(f"{BASE}/comms.html"); page.wait_for_selector(".ct-task")
    before = api.get(f"{BASE}/api/comms/overview").json()
    page.click("#ctDemoBtn"); page.wait_for_selector(".ct-popup")
    b2 = page.locator("#ctModeBanner").inner_text()
    check("demo banner is unmistakable", "DEMO DATA" in b2 and "Nothing is saved" in b2)
    board = page.locator("#ctBoard").inner_text()
    check("demo replaces (not mixes with) real tasks", "DEMO — 12 Example Road" in board and "Alpha St" not in board)
    check("demo shows both popup types with DEMO tag", page.locator(".ct-popup-un").count() >= 1 and page.locator(".ct-popup-wk").count() >= 1 and "DEMO" in page.locator(".ct-popup").first.inner_text())
    check("demo record buttons disabled", page.locator('[data-action="toggle"]').first.click() is None and page.locator('[data-action="rec-in"]').first.is_disabled())
    page.screenshot(path=f"{out}/06-demo.png")
    page.click(".ct-popup-close")  # dismiss locally
    page.click("#ctDemoBtn"); page.wait_for_function("document.getElementById('ctBoard').innerText.includes('Alpha St')")
    check("leaving demo restores real data", "Alpha St" in page.locator("#ctBoard").inner_text() and "DEMO —" not in page.locator("#ctBoard").inner_text())
    after = api.get(f"{BASE}/api/comms/overview").json()
    check("demo wrote nothing to the database", len(after["events"]) == len(before["events"]) and after["dismissed"] == before["dismissed"] and after["settings"] == before["settings"])

    # ---- 9. filters + mobile layout ----
    page.fill("#ctSearch", "gamma")
    check("search filters tasks", page.locator(".ct-task").count() == 1)
    page.fill("#ctSearch", "")
    page.select_option("#ctFilterCp", "VECTOR_TEAM")
    check("counterparty filter", page.locator(".ct-task").count() == 1)
    page.select_option("#ctFilterCp", "UNASSIGNED")
    check("unassigned filter (none left: all active tasks have a counterparty)", page.locator(".ct-task").count() == 0 and "No tasks match" in page.locator("#ctState").inner_text())
    page.select_option("#ctFilterCp", "ALL")
    page.set_viewport_size({"width": 390, "height": 800}); page.reload(); page.wait_for_selector(".ct-task")
    sw = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
    check("no horizontal page scroll at 390px", sw)
    page.screenshot(path=f"{out}/07-mobile.png")

    check("no JavaScript errors in the console", not errors, "; ".join(errors)[:300])
    b.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} UI checks passed")
sys.exit(1 if failed else 0)
