"""Static HTML dashboard generated from a snapshot.

Self-contained: no external scripts, no build step, no server. Open the file
or send it to a phone and it works.

Charts are CSS bars rather than SVG. At phone width, SVG text has to be
measured and positioned manually and labels collide; HTML text wraps and
reflows on its own. The one SVG is the net-worth line, where the geometry is
the point.

Colors come from the validated reference palette: single-hue blue for
magnitude, and the documented blue/red diverging pair for gains and losses.
Both pairs pass the CVD and contrast gates in light and dark.
"""

from __future__ import annotations

import html
import json
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .analytics import Concentration, TagSet
from .portfolio import Snapshot

FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
         'family=IBM+Plex+Mono:wght@500;600&'
         'family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">')

# --- palette (validated: see tests and scripts/validate_palette.js) --------
CSS = """
:root {
  color-scheme: light;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
  --pos: #2a78d6;
  --neg: #e34948;
  --bar: #2a78d6;
  --good: #006300;
  --critical: #d03b3b;
  --warning: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
    --pos: #3987e5;
    --neg: #e66767;
    --bar: #3987e5;
    --good: #0ca30c;
    --critical: #d03b3b;
    --warning: #fab219;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255,255,255,0.10);
  --pos: #3987e5;
  --neg: #e66767;
  --bar: #3987e5;
  --good: #0ca30c;
  --critical: #d03b3b;
  --warning: #fab219;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 400 15px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
header { margin-bottom: 28px; display: flex; justify-content: space-between;
         align-items: flex-start; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; }
button.theme {
  background: var(--surface); color: var(--ink-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer;
}
button.theme:hover { color: var(--ink); }

.tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
         margin-bottom: 28px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
        padding: 16px 18px; }
.tile .label { font-size: 12px; color: var(--muted); text-transform: uppercase;
               letter-spacing: 0.05em; margin-bottom: 6px; }
/* Figures in mono: this is a page of columns that must line up, and the
   monospaced face makes the digits align without special-casing each table. */
.tile .value { font-size: 26px; font-weight: 600; letter-spacing: -0.03em;
               font-family: var(--mono); font-variant-numeric: tabular-nums; }
.tile .note { font-size: 12px; color: var(--ink-2); margin-top: 4px; }
.tile.hero .value { font-size: 34px; }

section { background: var(--surface); border: 1px solid var(--border);
          border-radius: 12px; padding: 20px; margin-bottom: 16px; }
h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.hint { font-size: 12px; color: var(--muted); margin: 0 0 16px; }

.rows { display: flex; flex-direction: column; gap: 2px; }
.row { display: grid; grid-template-columns: minmax(96px, 150px) 1fr auto;
       gap: 12px; align-items: center; padding: 3px 0; }
.row .name { font-size: 13px; color: var(--ink-2); overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }
.track { background: var(--grid); border-radius: 4px; height: 18px; position: relative;
         overflow: hidden; }
.fill { height: 100%; border-radius: 0 4px 4px 0; background: var(--bar);
        min-width: 2px; transition: width .3s ease; }
/* .div-row carries the same value cell, so both selectors are listed --
   styling only .row silently left the gain/loss figures unstyled. */
.row .val, .div-row .val { font-size: 12.5px; font-family: var(--mono);
            font-variant-numeric: tabular-nums; color: var(--ink);
            white-space: nowrap; }
.row .pct { font-size: 12px; color: var(--muted); font-family: var(--sans); }

/* diverging: a centre baseline with arms either side */
.div-row { display: grid; grid-template-columns: minmax(96px, 150px) 1fr auto;
           gap: 12px; align-items: center; padding: 3px 0; }
.div-track { position: relative; height: 18px; background: var(--grid);
             border-radius: 4px; }
.div-zero { position: absolute; top: -2px; bottom: -2px; width: 1px;
            background: var(--axis); }
.div-fill { position: absolute; top: 0; height: 100%; min-width: 2px; }
.div-fill.pos { background: var(--pos); border-radius: 0 4px 4px 0; }
.div-fill.neg { background: var(--neg); border-radius: 4px 0 0 4px; }

.legend { display: flex; gap: 16px; margin-bottom: 14px; font-size: 12px;
          color: var(--ink-2); flex-wrap: wrap; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }

/* The positions table has eight columns and cannot fit a phone. It scrolls
   inside its own box so the page itself never scrolls sideways. */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch;
              margin: 0 -4px; padding: 0 4px; }
table { width: 100%; border-collapse: collapse; font-size: 13px;
        min-width: 680px; }
th, td { text-align: right; padding: 7px 8px; border-bottom: 1px solid var(--grid);
         font-family: var(--mono); font-variant-numeric: tabular-nums;
         font-size: 12.5px; }
th:first-child, td:first-child { text-align: left; font-family: var(--sans);
                                 font-variant-numeric: normal; }
th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
     letter-spacing: 0.05em; font-family: var(--sans); }
td.neg { color: var(--neg); }
td.pos { color: var(--good); }
details { margin-top: 8px; }
summary { cursor: pointer; font-size: 13px; color: var(--ink-2); padding: 6px 0; }
summary:hover { color: var(--ink); }

.issue { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--grid);
         font-size: 13px; align-items: baseline; }
.issue:last-child { border-bottom: 0; }
.badge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
         letter-spacing: 0.03em; flex-shrink: 0; }
.badge.error { background: var(--critical); color: #fff; }
.badge.warn { background: var(--warning); color: #0b0b0b; }
.badge.note { background: var(--grid); color: var(--ink-2); }
.callout { border-left: 3px solid var(--warning); padding: 10px 14px; margin: 14px 0 0;
           background: var(--page); border-radius: 0 8px 8px 0; font-size: 13px;
           color: var(--ink-2); }

.tip { position: fixed; pointer-events: none; opacity: 0; transition: opacity .12s;
       background: var(--ink); color: var(--page); padding: 6px 9px; border-radius: 6px;
       font-size: 12px; z-index: 50; white-space: nowrap;
       font-variant-numeric: tabular-nums; }
.tip.on { opacity: 1; }

svg .gridline { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--axis); stroke-width: 1; }
svg .series { fill: none; stroke: var(--bar); stroke-width: 2;
              stroke-linejoin: round; stroke-linecap: round; }
svg .marker { fill: var(--bar); stroke: var(--surface); stroke-width: 2; }
svg text { fill: var(--muted); font-size: 11px; }

@media (max-width: 560px) {
  .wrap { padding: 20px 16px 48px; }
  .row, .div-row { grid-template-columns: minmax(72px, 104px) 1fr auto; gap: 8px; }
  .row .name { font-size: 12px; }
  .tile.hero .value { font-size: 28px; }
}
"""

JS = """
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme');
  function current() {
    return root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function apply(mode) {
    root.setAttribute('data-theme', mode);
    btn.textContent = mode === 'dark' ? 'Light' : 'Dark';
    try { localStorage.setItem('fin-theme', mode); } catch (e) {}
  }
  try {
    var saved = localStorage.getItem('fin-theme');
    if (saved) apply(saved); else btn.textContent = current() === 'dark' ? 'Light' : 'Dark';
  } catch (e) { btn.textContent = 'Dark'; }
  btn.addEventListener('click', function () {
    apply(current() === 'dark' ? 'light' : 'dark');
  });

  // Hover layer: every mark carries data-tip.
  var tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  function show(e, text) {
    tip.textContent = text;
    tip.classList.add('on');
    var pad = 12;
    var x = e.clientX + pad, y = e.clientY + pad;
    var box = tip.getBoundingClientRect();
    if (x + box.width > window.innerWidth - 8) x = e.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = e.clientY - box.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  document.addEventListener('mousemove', function (e) {
    var el = e.target.closest('[data-tip]');
    if (el) { show(e, el.getAttribute('data-tip')); }
    else { tip.classList.remove('on'); }
  });
  document.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
})();
"""


def _esc(text: object) -> str:
    return html.escape(str(text), quote=True)


def _money(value: float, dp: int = 0) -> str:
    return f"{value:,.{dp}f}"


def _bar_rows(items: Sequence[Tuple[str, float]], total: float,
              base: str) -> str:
    """Single-series magnitude bars.

    One colour: length already encodes magnitude, and colouring each row
    differently would imply a categorical distinction that isn't there.
    """
    if not items:
        return '<p class="hint">No data.</p>'
    peak = max(abs(v) for _, v in items) or 1.0
    out = ['<div class="rows">']
    for name, value in items:
        width = max(abs(value) / peak * 100.0, 0.6)
        share = (value / total * 100.0) if total else 0.0
        tip = f"{name}: {base} {_money(value)} ({share:.1f}%)"
        # A negative entry (cash overdrawn by missing deposits) must not draw
        # as an ordinary positive bar -- length alone would read as a holding.
        style = ("width:%.2f%%;background:var(--neg)" % width if value < 0
                 else "width:%.2f%%" % width)
        out.append(
            f'<div class="row" data-tip="{_esc(tip)}">'
            f'<div class="name" title="{_esc(name)}">{_esc(name)}</div>'
            f'<div class="track"><div class="fill" style="{style}"></div></div>'
            f'<div class="val">{_money(value)} <span class="pct">{share:.1f}%</span></div>'
            f"</div>"
        )
    out.append("</div>")
    return "".join(out)


def _diverging_rows(items: Sequence[Tuple[str, float]], base: str) -> str:
    """Gains and losses around a shared zero.

    Sign is polarity, so this is the one place a diverging pair belongs. Every
    row is directly labelled with a signed value, so identity never rests on
    colour alone.
    """
    if not items:
        return '<p class="hint">No data.</p>'
    peak = max(abs(v) for _, v in items) or 1.0
    out = [
        '<div class="legend">'
        f'<span><i class="swatch" style="background:var(--pos)"></i>Gain</span>'
        f'<span><i class="swatch" style="background:var(--neg)"></i>Loss</span>'
        "</div>",
        '<div class="rows">',
    ]
    for name, value in items:
        extent = abs(value) / peak * 50.0
        tip = f"{name}: {base} {value:+,.0f}"
        if value >= 0:
            fill = (f'<div class="div-fill pos" style="left:50%;'
                    f'width:{max(extent, 0.4):.2f}%"></div>')
        else:
            fill = (f'<div class="div-fill neg" style="right:50%;'
                    f'width:{max(extent, 0.4):.2f}%"></div>')
        out.append(
            f'<div class="div-row" data-tip="{_esc(tip)}">'
            f'<div class="name" title="{_esc(name)}">{_esc(name)}</div>'
            f'<div class="div-track"><div class="div-zero" style="left:50%"></div>'
            f"{fill}</div>"
            f'<div class="val">{value:+,.0f}</div>'
            f"</div>"
        )
    out.append("</div>")
    return "".join(out)


def _sparkline(series: Sequence[Tuple[date, float]], base: str) -> str:
    """Net worth over time.

    With fewer than two observations there is no line to draw, and drawing a
    single point as if it were a trend would be worse than saying so.
    """
    if len(series) < 2:
        return ('<p class="hint">The net-worth series needs a second '
                "observation before a trend exists. It starts accumulating "
                "from the first run, so this fills in on its own.</p>")
    width, height, pad = 720, 200, 28
    values = [v for _, v in series]
    lo, hi = min(values), max(values)
    span = (hi - lo) or (hi or 1.0)
    lo -= span * 0.12
    hi += span * 0.12
    span = hi - lo

    n = len(series)
    def x_at(i: int) -> float:
        return pad + (width - pad * 2) * (i / (n - 1))

    def y_at(v: float) -> float:
        return height - pad - (height - pad * 2) * ((v - lo) / span)

    points = " ".join(f"{x_at(i):.1f},{y_at(v):.1f}"
                      for i, (_, v) in enumerate(series))
    parts = [
        f'<svg viewBox="0 0 {width} {height}" width="100%" '
        f'role="img" aria-label="Net worth over time" '
        f'preserveAspectRatio="none" style="max-height:200px">'
    ]
    for frac in (0.0, 0.5, 1.0):
        y = pad + (height - pad * 2) * frac
        parts.append(f'<line class="gridline" x1="{pad}" y1="{y:.1f}" '
                     f'x2="{width - pad}" y2="{y:.1f}"/>')
    parts.append(f'<polyline class="series" points="{points}"/>')
    for i, (when, value) in enumerate(series):
        parts.append(
            f'<circle class="marker" cx="{x_at(i):.1f}" cy="{y_at(value):.1f}" r="4" '
            f'data-tip="{_esc(when.isoformat())}: {base} {_money(value)}"/>'
        )
    first, last = series[0], series[-1]
    parts.append(f'<text x="{pad}" y="{height - 6}">{first[0].isoformat()}</text>')
    parts.append(f'<text x="{width - pad}" y="{height - 6}" '
                 f'text-anchor="end">{last[0].isoformat()}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _positions_table(snapshot: Snapshot) -> str:
    base = snapshot.base_currency
    rows = [
        "<div class='table-wrap'><table><thead><tr>"
        "<th>Position</th><th>Kind</th><th>Qty</th><th>Mark</th>"
        f"<th>{base}</th><th>Cost</th><th>Unrealised</th><th>Mark source</th>"
        "</tr></thead><tbody>"
    ]
    for p in snapshot.positions:
        if p.is_marked:
            cls = "pos" if p.unrealised > 0 else ("neg" if p.unrealised < 0 else "")
            unreal = f"{p.unrealised:+,.0f}"
            mark = f"{p.mark:,.4g}"
        else:
            cls, unreal, mark = "", "n/m", "—"
        rows.append(
            f"<tr><td>{_esc(p.account_id)} / {_esc(p.symbol)}</td>"
            f"<td>{_esc(p.kind.value)}</td>"
            f"<td>{p.quantity:,.6g}</td>"
            f"<td>{mark}</td>"
            f"<td>{_money(p.market_value_base)}</td>"
            f"<td>{_money(p.cost_basis_base)}</td>"
            f'<td class="{cls}">{unreal}</td>'
            f"<td>{_esc(p.mark_source)}</td></tr>"
        )
    rows.append("</tbody></table></div>")
    return "".join(rows)


def render(snapshot: Snapshot,
           history: Optional[Sequence[Tuple[date, float]]] = None,
           cagr: Optional[float] = None,
           conc: Optional[Concentration] = None,
           tags: Optional[TagSet] = None,
           standalone: bool = True,
           title: str = "Portfolio") -> str:
    """Render the dashboard.

    `standalone=True` produces a complete document for the local file.
    `standalone=False` omits the doctype/html/head/body wrapper, which the
    Artifact host supplies itself -- emitting our own would nest a second
    document inside theirs.
    """
    base = snapshot.base_currency
    total = snapshot.net_worth
    negative_cash = snapshot.unexplained_negative_cash()
    loans = snapshot.margin_loans()

    kinds = sorted(snapshot.by_kind().items(), key=lambda x: -x[1])
    currencies = sorted(snapshot.by_currency().items(), key=lambda x: -x[1])
    top = [(f"{p.account_id} / {p.symbol}", p.market_value_base)
           for p in snapshot.positions[:12]]
    # An unmarked position has a market value of zero, which subtracts its
    # whole cost and reads as a total loss. It is unvalued, not down 100%, so
    # it is excluded here and reported as a NO_MARK warning instead.
    pnl = sorted(
        ((f"{p.account_id} / {p.symbol}", p.unrealised)
         for p in snapshot.positions
         if abs(p.unrealised) >= 1 and p.mark != 0),
        key=lambda x: -abs(x[1]))[:12]

    errors = [i for i in snapshot.issues if i.severity == "error"]
    warnings = [i for i in snapshot.issues if i.severity == "warning"]

    parts: List[str] = []
    add = parts.append

    if standalone:
        add("<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>")
        add("<meta name='viewport' content='width=device-width, initial-scale=1'>")
        add(f"<title>{_esc(title)}</title>{FONTS}")
        add(f"<style>{CSS}</style></head><body>")
    else:
        add(f"<title>{_esc(title)}</title>{FONTS}")
        add(f"<style>{CSS}</style>")
    add("<div class='wrap'>")

    add("<header><div>")
    add("<h1>Portfolio</h1>")
    add(f"<div class='sub'>As of {snapshot.as_of.isoformat()} · "
        f"reported in {base}</div>")
    add("</div><button class='theme' id='theme'>Dark</button></header>")

    # --- stat tiles ---
    add("<div class='tiles'>")
    floor_note = ("floor — missing deposit history"
                  if negative_cash else "securities and cash")
    add(f"<div class='tile hero'><div class='label'>Net worth</div>"
        f"<div class='value'>{_money(total)}</div>"
        f"<div class='note'>{base} · {floor_note}</div></div>")
    add(f"<div class='tile'><div class='label'>Securities</div>"
        f"<div class='value'>{_money(snapshot.securities_value)}</div>"
        f"<div class='note'>{len(snapshot.positions)} positions</div></div>")
    cash_note = (f"{len(negative_cash)} account(s) negative" if negative_cash
                 else f"net · margin loans {_money(-snapshot.margin_loans_base())}" if loans
                 else "net")
    add(f"<div class='tile'><div class='label'>Cash</div>"
        f"<div class='value'>{_money(snapshot.cash_value)}</div>"
        f"<div class='note'>{cash_note}</div></div>")
    if cagr is not None:
        add(f"<div class='tile'><div class='label'>Net worth CAGR</div>"
            f"<div class='value'>{cagr * 100:.1f}%</div>"
            f"<div class='note'>since series start</div></div>")
    elif conc is not None:
        add(f"<div class='tile'><div class='label'>Concentration</div>"
            f"<div class='value'>{conc.top_5 * 100:.0f}%</div>"
            f"<div class='note'>top 5 · {conc.verdict}</div></div>")
    add("</div>")

    if negative_cash:
        add("<div class='callout'><strong>Net worth is a floor, not a figure.</strong> "
            "Purchases were recorded without the deposits that paid for them, so "
            f"cash reads negative in {len(negative_cash)} currencies. Recording "
            "the deposits or the stated balances raises this total.</div>")

    # --- allocation ---
    add("<section><h2>Allocation by asset kind</h2>")
    add(f"<p class='hint'>Share of net worth. Percentages are of {base} "
        f"{_money(total)}.</p>")
    add(_bar_rows(kinds, total, base))
    add("</section>")

    add("<section><h2>Currency exposure</h2>")
    add("<p class='hint'>Where the money sits before translation to "
        f"{base}.</p>")
    add(_bar_rows(currencies, total, base))
    add("</section>")

    add("<section><h2>Largest positions</h2>")
    add(f"<p class='hint'>Top {len(top)} by market value.</p>")
    add(_bar_rows(top, total, base))
    add("</section>")

    add("<section><h2>Unrealised gain and loss</h2>")
    add("<p class='hint'>Against cost basis.</p>")
    add(_diverging_rows(pnl, base))
    add("</section>")

    add("<section><h2>Net worth over time</h2>")
    add("<p class='hint'>One observation per run.</p>")
    add(_sparkline(list(history or []), base))
    add("</section>")

    if tags:
        # Driven by whatever dimensions the tag file actually defines, so
        # adding or splitting one (sector from region, say) shows up here
        # without touching this code.
        for dimension in tags.dimensions:
            grouped = sorted(tags.group(snapshot.positions, dimension).items(),
                             key=lambda x: -x[1])
            if len(grouped) < 2:
                continue
            add(f"<section><h2>By {_esc(dimension)}</h2>")
            add("<p class='hint'>Your own classification (tags.csv). "
                "Percentages are of net worth; cash carries no tags.</p>")
            add(_bar_rows(grouped, total, base))
            add("</section>")

    # --- reconciliation ---
    add("<section><h2>Reconciliation</h2>")
    add(f"<p class='hint'>{len(errors) + len(negative_cash)} error(s), "
        f"{len(warnings) + (1 if snapshot.unmarked else 0)} warning(s).</p>")
    for issue in errors:
        add(f"<div class='issue'><span class='badge error'>ERROR</span>"
            f"<span>{_esc(issue.code)} — {_esc(issue.detail)}</span></div>")
    for (acct, ccy), bal in sorted(negative_cash):
        add(f"<div class='issue'><span class='badge error'>ERROR</span>"
            f"<span>NEGATIVE_CASH — {_esc(acct)}/{_esc(ccy)}: "
            f"{_money(bal, 2)}</span></div>")
    for (acct, ccy), bal in loans:
        add(f"<div class='issue'><span class='badge note'>NOTE</span>"
            f"<span>MARGIN_LOAN — {_esc(acct)}/{_esc(ccy)}: "
            f"{_money(bal, 2)} (stated by statement)</span></div>")
    for issue in warnings:
        add(f"<div class='issue'><span class='badge warn'>WARN</span>"
            f"<span>{_esc(issue.code)} — {_esc(issue.detail)}</span></div>")
    if snapshot.unmarked:
        add(f"<div class='issue'><span class='badge warn'>WARN</span>"
            f"<span>NO_MARK — {_esc(', '.join(snapshot.unmarked))}</span></div>")
    for note in snapshot.notes:
        add(f"<div class='issue'><span class='badge note'>NOTE</span>"
            f"<span>{_esc(note)}</span></div>")
    add("</section>")

    add("<section><h2>All positions</h2>")
    add("<p class='hint'>The table the charts are drawn from.</p>")
    add("<details open><summary>Show table</summary>")
    add(_positions_table(snapshot))
    add("</details></section>")

    add(f"<p class='sub'>Generated {snapshot.as_of.isoformat()} · "
        "figures are as fresh as their marks.</p>")
    add(f"</div><script>{JS}</script>")
    if standalone:
        add("</body></html>")
    return "".join(parts)


def write(snapshot: Snapshot, path: Path, **kwargs) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(snapshot, **kwargs), encoding="utf-8")
    return path
