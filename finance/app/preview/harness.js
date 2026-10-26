// Renders the Money app's tabs from a JSON snapshot, without crypto or the bot.
// URL parameters: data (JSON path, default the synthetic fixture), tab, scheme
// (light|dark), and optional view state: flow (month|last3|all), mode
// (categories|groups), node (start of a Sankey node's name: opens its sheet), month, kind,
// sheet (line|group|category|rec|recmonth; group=<label>, cat=<label>, item=<name>, col=<n>), sec.

import { icon, wireSheet, dayName, closeSheet } from "/ui.js";
import { TABS, renderTab } from "/views.js";

const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
if (q.get("scheme")) document.documentElement.dataset.scheme = q.get("scheme");

const V = {};
if (q.get("flow")) V.flowSel = q.get("flow");
if (q.get("mode")) V.flowMode = q.get("mode");
if (q.get("month")) V.month = q.get("month");
if (q.get("kind")) V.kind = q.get("kind");
if (q.get("travel")) V.dayTravel = q.get("travel"); // with | ex (Everyday tab)
if (q.get("tracker")) V.tracker = q.get("tracker"); // food | fun | shopping | travel
if (q.get("month")) V.dayMonth = q.get("month");
if (q.get("sec")) V.recSec = q.get("sec"); // a Recurring section
const queue = [];
let data = null;
let tab = TABS.some(([t]) => t === q.get("tab")) ? q.get("tab") : "overview";

function render() {
  for (const b of document.querySelectorAll("#tabs [role=tab]")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    if (b.dataset.tab === tab) b.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  renderTab(tab, $("view"), data, {
    st: V, rerender: render, w: Math.max(288, Math.min(680, document.documentElement.clientWidth) - 24), queue,
    recategorise: (t, c) => { queue.push({ ref: t.id }); t.category = c; closeSheet(); render(); },
  });
  $("sub").textContent = `As of ${dayName(data.as_of)}`;
  $("asof").textContent = `Snapshot generated ${data.generated_at}`;
  $("pending").hidden = !queue.length;
  $("pending").textContent = `${queue.length} for the bot`;
}

async function main() {
  for (const el of document.querySelectorAll("[data-icon]")) el.replaceWith(icon(el.dataset.icon, el.className));
  wireSheet();
  for (const b of document.querySelectorAll("#tabs [role=tab]")) b.addEventListener("click", () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); });
  data = await (await fetch(q.get("data") || "/data/fixture.json")).json();
  render();
  const node = q.get("node");
  if (node) { // a Sankey node, by the start of its label
    const target = [...document.querySelectorAll(".sankey .node")].find((x) => (x.getAttribute("aria-label") || "").startsWith(node));
    if (target) target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  if (q.get("sheet") === "line") { const r = document.querySelector("#view .rows button.row"); if (r) r.click(); }
  if (q.get("sheet") === "group") { // the spending donut's legend row, by group label
    const r = [...document.querySelectorAll("#view .lg-row")].find((x) => x.textContent.startsWith(q.get("group") || "Day-to-day"));
    if (r) r.click();
  }
  if (q.get("sheet") === "category") { // a category bar, by its label (inside the group sheet when group= is given)
    const scope = q.get("group") ? "#sheet-body" : "#view";
    const r = [...document.querySelectorAll(`${scope} .hb-row.tap`)].find((x) => x.textContent.startsWith(q.get("cat") || ""));
    if (r) r.click();
  }
  if (q.get("sheet") === "rec") { // a Recurring row, by the start of its name (first row if none)
    const r = [...document.querySelectorAll("#view .rows button.row")].find((x) => x.textContent.startsWith(q.get("item") || ""));
    if (r) r.click();
  }
  if (q.get("sheet") === "recmonth") { const c = document.querySelectorAll("#view .col")[Number(q.get("col") || 3)]; if (c) c.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(render, 120); });
  document.body.dataset.ready = "1";
}

main().catch((e) => { $("view").textContent = `Preview failed: ${e.message}`; document.body.dataset.ready = "1"; });
