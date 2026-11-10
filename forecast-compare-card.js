/*
 * Forecast Compare Card for Home Assistant
 * A table comparing daily snapshot values of several "comparison" entities
 * against one main entity, over a rolling window of days.
 *
 * Values come from the recorder history, so nothing needs to be stored and
 * the window rolls forward on its own: when a new snapshot time passes, the
 * newest day is added on the right and the oldest drops off the left.
 *
 * https://github.com/Boffy35/forecast-compare-card  ·  MIT licence  ·  (c) 2026 Boffy35
 */
const CARD_TAG = "forecast-compare-card";
const EDITOR_TAG = "forecast-compare-card-editor";
const VERSION = "0.5.0";

const DEFAULTS = {
  snapshot_time: "06:00:00",
  days: 7,
  decimals: 1,
  delta_mode: "absolute",
  show_main_row: true,
  color_deltas: false,
  newest_first: true,
  highlight_closest: true,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function atTime(date, timeStr) {
  const [h = 0, m = 0, s = 0] = String(timeStr || "0:0").split(":").map((n) => parseInt(n, 10) || 0);
  const d = new Date(date);
  d.setHours(h, m, s, 0);
  return d;
}

/* The last `days` snapshot moments, oldest first. */
function snapshotDays(cfg, now = new Date()) {
  const last = atTime(now, cfg.snapshot_time);
  if (last > now) last.setDate(last.getDate() - 1);
  const out = [];
  for (let i = cfg.days - 1; i >= 0; i--) {
    const snap = new Date(last);
    snap.setDate(last.getDate() - i);
    const main = cfg.main_time ? atTime(snap, cfg.main_time) : snap;
    out.push({ snap, main, prevSnap: dayBefore(snap), prevMain: dayBefore(main) });
  }
  return out;
}

/* Same clock time on the previous calendar day (DST-safe, unlike subtracting 24h). */
function dayBefore(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - 1);
  return x;
}

/* Read a (possibly nested) attribute: "forecast" or "detailedForecast.0.pv_estimate". */
function getPath(obj, path) {
  return String(path)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const entryTime = (e) =>
  e.lu != null ? e.lu * 1000 : e.lc != null ? e.lc * 1000 : Date.parse(e.last_updated || e.last_changed);

const entryValue = (e, attribute) => {
  const raw = attribute ? getPath(e.a ?? e.attributes, attribute) : e.s ?? e.state;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : null;
};

/* Numeric state (or attribute, if given) of an entity at time ts (ms), from a history series. */
function valueAt(series, ts, attribute) {
  if (!series || !series.length) return null;
  let found = null;
  for (const e of series) {
    if (entryTime(e) <= ts) found = e;
    else break;
  }
  return found ? entryValue(found, attribute) : null;
}

const GLITCH_WINDOW_MS = 60 * 60 * 1000;

/*
 * How much a total_increasing meter moved between t0 and t1 (ms).
 * Returns { value, notes } or null when there is no data.
 *
 * - Increases are summed against a high-water mark.
 * - A dip of less than 10% is noise (rounding, a source briefly missing) and is
 *   ignored; this matches Home Assistant's own reset rule.
 * - A larger drop is a meter reset (the new reading counts from zero), unless the
 *   meter climbs back to its previous level within an hour, which makes it a glitch.
 * - Unavailable/non-numeric readings are skipped.
 */
function movementBetween(series, t0, t1, attribute) {
  if (!series || !series.length) return null;
  let prev = valueAt(series, t0, attribute);
  // All numeric readings after t0 (including after t1, so a glitch near t1 can be checked).
  const pts = [];
  for (const e of series) {
    const t = entryTime(e);
    if (t <= t0) continue;
    const v = entryValue(e, attribute);
    if (v != null) pts.push({ t, v });
  }
  let total = 0;
  let seen = prev != null;
  const notes = [];
  const clock = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  for (let i = 0; i < pts.length && pts[i].t <= t1; i++) {
    const { t, v } = pts[i];
    seen = true;
    if (prev == null) {
      prev = v;
      continue;
    }
    if (v >= prev) {
      total += v - prev;
      prev = v;
      continue;
    }
    if (v >= 0.9 * prev) continue; // small dip: keep the high-water mark
    const level = prev;
    const recovers = pts.slice(i + 1).some((p) => p.t - t <= GLITCH_WINDOW_MS && p.v >= 0.9 * level);
    if (recovers) {
      notes.push(`${clock(t)}: ignored glitch ${level} → ${v}`);
      continue;
    }
    notes.push(`${clock(t)}: meter reset ${level} → ${v}`);
    total += v;
    prev = v;
  }
  return seen ? { value: total, notes } : null;
}

/*
 * Relabel a unit after scaling: ÷1000 moves one SI prefix up (Wh → kWh → MWh),
 * ×1000 moves one down (MWh → kWh → Wh). Units it can't relabel get a marker instead.
 */
const PREFIX_UP = { "": "k", k: "M", M: "G" };
const PREFIX_DOWN = { k: "", M: "k", G: "M" };
const PREFIXABLE = /^(W|Wh|VA|VAh|var|varh|g|m|B)$/;

function scaledUnit(unit, scale) {
  if (scale === 1) return unit;
  const marker = scale === 1000 ? "×1000" : scale === 0.001 ? "÷1000" : `×${scale}`;
  if (!unit) return marker;
  const m = unit.match(/^([kMG]?)(.+)$/);
  if (m && PREFIXABLE.test(m[2])) {
    const table = scale === 0.001 ? PREFIX_UP : scale === 1000 ? PREFIX_DOWN : null;
    if (table && m[1] in table) return table[m[1]] + m[2];
  }
  return `${unit} ${marker}`;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === "" || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Card                                                               */
/* ------------------------------------------------------------------ */
class ForecastCompareCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig(hass) {
    const sensors = Object.keys(hass?.states || {}).filter((e) => e.startsWith("sensor."));
    return {
      title: "Forecast vs actual",
      main_entity: sensors[0] || "",
      snapshot_time: "06:00:00",
      entities: sensors[1] ? [{ entity: sensors[1] }] : [],
    };
  }

  setConfig(config) {
    if (!config.main_entity) throw new Error("main_entity is required");
    const entities = (config.entities || []).map((e) => (typeof e === "string" ? { entity: e } : e));
    this._config = {
      ...DEFAULTS,
      ...config,
      entities,
      days: Math.max(1, Math.min(14, parseInt(config.days ?? DEFAULTS.days, 10) || DEFAULTS.days)),
      decimals: Math.max(0, Math.min(6, parseInt(config.decimals ?? DEFAULTS.decimals, 10))),
    };
    this._history = null;
    this._days = null;
    this._key = null;
    this._fetchedAt = 0;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
    this._maybeFetch();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._render();
    this._maybeFetch();
  }

  getCardSize() {
    return 3 + (this._config?.entities?.length || 0);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  _maybeFetch() {
    if (!this._hass || !this._config || this._loading) return;
    const c = this._config;
    const days = snapshotDays(c);
    const latest = days[days.length - 1];
    const key = JSON.stringify([
      c.main_entity, c.main_attribute, c.main_calc, c.entities.map((e) => [e.entity, e.attribute, e.calc]),
      c.snapshot_time, c.main_time, c.days, latest.snap.getTime(),
    ]);
    const now = Date.now();
    // A main-entity time that has passed since the last fetch (when main_time is later than snapshot_time).
    const pending = days.some((d) => d.main.getTime() > this._fetchedAt && d.main.getTime() <= now);
    if (key === this._key && !pending) return;
    this._key = key;
    this._fetch(days);
  }

  async _fetch(days) {
    const c = this._config;
    const sources = [{ entity: c.main_entity, attribute: c.main_attribute }, ...c.entities].filter((e) => e.entity);
    // Entities read via an attribute need full history with attributes; the rest can use the lighter state-only query.
    const attrIds = [...new Set(sources.filter((e) => e.attribute).map((e) => e.entity))];
    const stateIds = [...new Set(sources.map((e) => e.entity))].filter((id) => !attrIds.includes(id));
    // One day further back than the first column, so daily movement has a starting reading.
    const start = new Date(Math.min(days[0].prevSnap.getTime(), days[0].prevMain.getTime()) - 1000);
    const base = {
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: new Date().toISOString(),
      include_start_time_state: true,
      significant_changes_only: false,
    };
    this._loading = true;
    try {
      const [plain, withAttrs] = await Promise.all([
        stateIds.length
          ? this._hass.callWS({ ...base, entity_ids: stateIds, minimal_response: true, no_attributes: true })
          : {},
        attrIds.length
          ? this._hass.callWS({ ...base, entity_ids: attrIds, minimal_response: false, no_attributes: false })
          : {},
      ]);
      this._history = { ...plain, ...withAttrs };
      this._days = days;
      this._error = null;
      this._fetchedAt = Date.now();
    } catch (e) {
      this._error = e?.message || String(e);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const c = this._config;
    const hass = this._hass;
    const chrono = this._days || snapshotDays(c); // oldest first
    const days = c.newest_first === false ? chrono : [...chrono].reverse(); // display order
    const h = this._history || {};
    const now = Date.now();
    const lang = hass?.locale?.language || undefined;

    const fmt = (v) => (v == null ? "—" : v.toFixed(c.decimals));
    const fmtDelta = (v) => {
      if (v == null) return "—";
      const s = (v > 0 ? "+" : "") + v.toFixed(c.decimals);
      return c.delta_mode === "percent" ? s + "%" : s;
    };
    const nameOf = (id, override, attr) => {
      if (override) return override;
      const base = hass?.states?.[id]?.attributes?.friendly_name || id;
      return attr ? `${base} · ${attr}` : base;
    };
    // "auto" uses daily movement for total_increasing sensors (state only; state_class describes the state, not attributes).
    const isMovement = (id, attr, calc) =>
      calc === "movement" ||
      ((calc ?? "auto") === "auto" && !attr && hass?.states?.[id]?.attributes?.state_class === "total_increasing");
    // The entity's unit describes its state, not its attributes, so it's only shown for state values.
    const unitOf = (id, attr, movement, scale) => {
      let u = attr ? "" : hass?.states?.[id]?.attributes?.unit_of_measurement || "";
      u = scaledUnit(u, parseFloat(scale) || 1);
      return movement ? `${u ? u + " " : ""}/day` : u;
    };
    const dayLabel = (d) => d.snap.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" });
    // Returns { v, notes } so cells can explain resets/glitches on hover. Scale is applied after
    // the calculation, so movement is worked out on raw readings (glitch notes show raw values).
    const read = (id, attr, movement, t, tPrev, scale) => {
      const k = parseFloat(scale) || 1;
      if (!movement) {
        const v = valueAt(h[id], t.getTime(), attr);
        return { v: v == null ? null : v * k, notes: [] };
      }
      const r = movementBetween(h[id], tPrev.getTime(), t.getTime(), attr);
      return r ? { v: r.value * k, notes: r.notes } : { v: null, notes: [] };
    };
    const tip = (notes) => (notes.length ? ` title="${esc(notes.join("\n"))}"` : "");
    const flag = (notes) => (notes.length ? ` flag` : "");

    const mainMove = isMovement(c.main_entity, c.main_attribute, c.main_calc);
    const mainReads = days.map((d) =>
      d.main.getTime() > now ? { v: null, notes: [] } : read(c.main_entity, c.main_attribute, mainMove, d.main, d.prevMain, c.main_scale)
    );
    const mainVals = mainReads.map((r) => r.v);
    const mainName = nameOf(c.main_entity, c.main_name, c.main_attribute);

    let body = "";
    if (!hass || (!this._history && !this._error)) {
      body = `<div class="msg">Loading history…</div>`;
    } else if (this._error) {
      body = `<div class="msg err">Couldn't load history: ${esc(this._error)}</div>`;
    } else {
      const head1 =
        `<th class="name" rowspan="2">Entity</th>` +
        days.map((d) => `<th class="day" colspan="2">${esc(dayLabel(d))}</th>`).join("");
      const head2 = days.map(() => `<th class="sub v">Value</th><th class="sub">Δ${c.delta_mode === "percent" ? " %" : ""}</th>`).join("");

      let rows = "";
      if (c.show_main_row) {
        rows +=
          `<tr class="mainrow"><td class="name" data-id="${esc(c.main_entity)}">${esc(mainName)}` +
          `<span class="unit">${esc(unitOf(c.main_entity, c.main_attribute, mainMove, c.main_scale))}</span></td>` +
          mainReads.map((r) => `<td class="v${flag(r.notes)}"${tip(r.notes)}>${fmt(r.v)}</td><td class="muted">·</td>`).join("") +
          `</tr>`;
      }
      // Work out every cell first, so each day's closest entity is known before drawing.
      const grid = c.entities
        .filter((e) => e.entity)
        .map((e) => {
          const move = isMovement(e.entity, e.attribute, e.calc);
          const cells = days.map((d, i) => {
            const r = read(e.entity, e.attribute, move, d.snap, d.prevSnap, e.scale);
            const v = r.v;
            const m = mainVals[i];
            let delta = null;
            if (v != null && m != null) {
              delta = c.delta_mode === "percent" ? (m === 0 ? null : ((v - m) / Math.abs(m)) * 100) : v - m;
            }
            const gap = v != null && m != null ? Math.abs(v - m) : null;
            return { v, delta, gap, notes: r.notes };
          });
          return { e, move, cells };
        });

      // Smallest gap per day, compared at display precision so ties shown as equal are both highlighted.
      const round = (x) => Number(x.toFixed(c.decimals));
      const best = days.map((_, i) => {
        const gaps = grid.map((row) => row.cells[i].gap).filter((g) => g != null);
        return grid.length > 1 && gaps.length ? round(Math.min(...gaps)) : null;
      });

      for (const { e, move, cells } of grid) {
        const html = cells
          .map(({ v, delta, gap, notes }, i) => {
            const win = c.highlight_closest !== false && best[i] != null && gap != null && round(gap) === best[i];
            const w = win ? " best" : "";
            const cls = c.color_deltas && delta != null && delta !== 0 ? (delta > 0 ? " pos" : " neg") : "";
            const winTip = win ? ["Closest to " + mainName + " this day"] : [];
            return (
              `<td class="v${w}${flag(notes)}"${tip([...winTip, ...notes])}>${fmt(v)}</td>` +
              `<td class="d${w}${cls}">${fmtDelta(delta)}</td>`
            );
          })
          .join("");
        rows +=
          `<tr><td class="name" data-id="${esc(e.entity)}">${esc(nameOf(e.entity, e.name, e.attribute))}` +
          `<span class="unit">${esc(unitOf(e.entity, e.attribute, move, e.scale))}</span></td>${html}</tr>`;
      }
      if (!c.entities.length) {
        rows += `<tr><td class="msg" colspan="${1 + days.length * 2}">Add comparison entities in the card editor.</td></tr>`;
      }

      const mainNote = c.main_time ? ` · main entity at ${esc(String(c.main_time).slice(0, 5))}` : "";
      body =
        `<div class="wrap"><table><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${rows}</tbody></table></div>` +
        `<div class="foot">Snapshot ${esc(String(c.snapshot_time).slice(0, 5))}${mainNote} · Δ = entity − ${esc(mainName)}</div>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding-bottom: 8px; overflow: hidden; }
        .title { padding: 16px 16px 8px; font-size: 1.25em; }
        .wrap { overflow-x: auto; padding: 0 8px; }
        table { border-collapse: collapse; width: 100%; font-size: 0.875em; font-variant-numeric: tabular-nums; }
        th, td { padding: 4px 6px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--divider-color); }
        th { color: var(--secondary-text-color); font-weight: 500; }
        th.day { text-align: center; border-left: 1px solid var(--divider-color); }
        th.sub { font-size: 0.85em; }
        .v { border-left: 1px solid var(--divider-color); }
        .name {
          text-align: left; position: sticky; left: 0; z-index: 1; max-width: 180px;
          overflow: hidden; text-overflow: ellipsis;
          background: var(--ha-card-background, var(--card-background-color, #fff));
        }
        td.name { cursor: pointer; }
        .unit { color: var(--secondary-text-color); font-size: 0.8em; margin-left: 4px; }
        tr.mainrow td { font-weight: 600; background: var(--secondary-background-color); }
        tr.mainrow td.name { background: var(--secondary-background-color); }
        .muted { color: var(--secondary-text-color); }
        td.best { background: rgba(67, 160, 71, 0.22); background: color-mix(in srgb, var(--success-color, #43a047) 24%, transparent); font-weight: 600; }
        td.flag { text-decoration: underline dotted var(--warning-color, #ffa600); text-underline-offset: 3px; cursor: help; }
        .pos { color: var(--success-color, #43a047); }
        .neg { color: var(--error-color, #db4437); }
        .msg { padding: 12px 16px; color: var(--secondary-text-color); text-align: left; }
        .err { color: var(--error-color, #db4437); }
        .foot { padding: 6px 16px 0; font-size: 0.75em; color: var(--secondary-text-color); }
      </style>
      <ha-card>
        ${c.title ? `<div class="title">${esc(c.title)}</div>` : ""}
        ${body}
      </ha-card>`;

    this.shadowRoot.querySelectorAll("td.name[data-id]").forEach((td) =>
      td.addEventListener("click", () => this._moreInfo(td.dataset.id))
    );
  }
}

/* ------------------------------------------------------------------ */
/* Visual editor                                                      */
/* ------------------------------------------------------------------ */
const CALC_SELECTOR = {
  select: {
    mode: "dropdown",
    options: [
      { value: "auto", label: "Auto (daily movement if total increasing)" },
      { value: "value", label: "Value at snapshot" },
      { value: "movement", label: "Daily movement" },
    ],
  },
};

const SCALE_SELECTOR = {
  select: {
    mode: "dropdown",
    options: [
      { value: "1", label: "×1 (as is)" },
      { value: "1000", label: "×1000" },
      { value: "0.001", label: "÷1000" },
    ],
  },
};

const MAIN_SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    type: "grid", name: "", schema: [
      { name: "main_entity", required: true, selector: { entity: {} } },
      { name: "main_attribute", selector: { attribute: {} }, context: { filter_entity: "main_entity" } },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "main_name", selector: { text: {} } },
      { name: "main_calc", selector: CALC_SELECTOR },
      { name: "main_scale", selector: SCALE_SELECTOR },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "snapshot_time", selector: { time: {} } },
      { name: "main_time", selector: { time: {} } },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "days", selector: { number: { min: 1, max: 14, mode: "box" } } },
      { name: "decimals", selector: { number: { min: 0, max: 6, mode: "box" } } },
      {
        name: "delta_mode", selector: {
          select: { mode: "dropdown", options: [
            { value: "absolute", label: "Absolute" },
            { value: "percent", label: "Percent" },
          ] },
        },
      },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "show_main_row", selector: { boolean: {} } },
      { name: "color_deltas", selector: { boolean: {} } },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "newest_first", selector: { boolean: {} } },
      { name: "highlight_closest", selector: { boolean: {} } },
    ],
  },
];

const ROW_SCHEMA = [
  {
    type: "grid", name: "", schema: [
      { name: "entity", selector: { entity: {} } },
      { name: "attribute", selector: { attribute: {} }, context: { filter_entity: "entity" } },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "name", selector: { text: {} } },
      { name: "calc", selector: CALC_SELECTOR },
      { name: "scale", selector: SCALE_SELECTOR },
    ],
  },
];

const LABELS = {
  title: "Title",
  main_entity: "Main entity (actual)",
  main_name: "Main entity name (optional)",
  main_attribute: "Main attribute (optional, uses state if empty)",
  attribute: "Attribute (optional, uses state if empty)",
  main_calc: "Main calculation",
  calc: "Calculation",
  main_scale: "Main scale",
  scale: "Scale",
  snapshot_time: "Daily snapshot time",
  main_time: "Main entity time (optional, defaults to snapshot time)",
  days: "Days",
  decimals: "Decimals",
  delta_mode: "Delta",
  show_main_row: "Show main entity row",
  color_deltas: "Colour deltas",
  newest_first: "Newest day on the left",
  highlight_closest: "Highlight closest entity each day",
  entity: "Comparison entity",
  name: "Name (overrides entity name)",
};

class ForecastCompareCardEditor extends HTMLElement {
  setConfig(config) {
    const json = JSON.stringify(config);
    if (json === this._lastJson) return; // our own change echoed back; don't re-render (keeps focus)
    this._config = {
      ...config,
      entities: (config.entities || []).map((e) => (typeof e === "string" ? { entity: e } : { ...e })),
    };
    this._lastJson = json;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
  }

  _commit(rerender) {
    const { entities, ...rest } = this._config;
    this._config = { ...clean(rest), entities: entities.map((e) => clean(e)) };
    this._lastJson = JSON.stringify(this._config);
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
    if (rerender) this._render();
  }

  _form(schema, data, onChange) {
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.data = data;
    f.schema = schema;
    f.computeLabel = (s) => LABELS[s.name] || s.name;
    f.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const v = ev.detail.value;
      f.data = v;
      onChange(v);
    });
    return f;
  }

  _render() {
    if (!this._config) return;
    this.innerHTML = `
      <style>
        .section { margin: 16px 0 8px; font-weight: 500; }
        .row { display: flex; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid var(--divider-color); }
        .row ha-form { flex: 1; }
        .btns { display: flex; flex-direction: column; gap: 4px; }
        button {
          font: inherit; cursor: pointer; border-radius: 6px; padding: 4px 10px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);
        }
        button:disabled { opacity: 0.4; cursor: default; }
        button.add { margin-top: 8px; color: var(--primary-color); border-color: var(--primary-color); }
      </style>
      <div class="main"></div>
      <div class="section">Comparison entities</div>
      <div class="rows"></div>
      <button class="add">+ Add entity</button>`;

    const { entities, ...mainData } = this._config;
    this.querySelector(".main").appendChild(
      this._form(MAIN_SCHEMA, { ...DEFAULTS, ...mainData }, (v) => {
        this._config = { ...this._config, ...v, entities: this._config.entities };
        this._commit(false);
      })
    );

    const rows = this.querySelector(".rows");
    this._config.entities.forEach((ent, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.appendChild(
        this._form(ROW_SCHEMA, ent, (v) => {
          const list = [...this._config.entities];
          list[i] = v;
          this._config = { ...this._config, entities: list };
          this._commit(false);
        })
      );
      const btns = document.createElement("div");
      btns.className = "btns";
      const mk = (label, title, disabled, fn) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener("click", fn);
        btns.appendChild(b);
      };
      const move = (to) => {
        const list = [...this._config.entities];
        [list[i], list[to]] = [list[to], list[i]];
        this._config = { ...this._config, entities: list };
        this._commit(true);
      };
      mk("↑", "Move up", i === 0, () => move(i - 1));
      mk("↓", "Move down", i === this._config.entities.length - 1, () => move(i + 1));
      mk("✕", "Remove", false, () => {
        this._config = { ...this._config, entities: this._config.entities.filter((_, j) => j !== i) };
        this._commit(true);
      });
      row.appendChild(btns);
      rows.appendChild(row);
    });

    this.querySelector(".add").addEventListener("click", () => {
      this._config = { ...this._config, entities: [...this._config.entities, { entity: "" }] };
      this._commit(true);
    });
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, ForecastCompareCard);
if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, ForecastCompareCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Forecast Compare Card",
    description: "Daily snapshot table comparing forecast entities against a main (actual) entity over a rolling window.",
    preview: false,
    documentationURL: "https://github.com/Boffy35/forecast-compare-card",
  });
}
console.info(`%c FORECAST-COMPARE-CARD %c v${VERSION} `, "background:#03a9f4;color:#fff", "background:#444;color:#fff");
