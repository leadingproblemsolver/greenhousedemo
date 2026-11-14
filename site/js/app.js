import { runModelRow, profileHour, MODE_LABEL, C } from "./physics.js";
import { parseCsv, summarize } from "./summary.js";

const $ = (s, el = document) => el.querySelector(s);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const GOLDEN = $("#golden-hash").textContent.trim();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ── 01 · single-hour calculator ──────────────────────────────────────── */
const form = $(".calc-inputs");
const PRESETS = { "0600": 6, "1000": 10, "1400": 14 };

function renderCalc() {
  const v = Object.fromEntries(new FormData(form).entries());
  const input = {
    t_out: Number(v.t_out), t_dp: Number(v.t_dp), g_solar: Math.max(0, Number(v.g_solar)),
    pressure_hpa: Number(v.p), hour: Math.round(Number(v.hour)),
  };
  if (Object.values(input).some((x) => !Number.isFinite(x))) return;
  const r = runModelRow(input);

  const modeEl = $("#calc-mode");
  modeEl.className = `calc-mode ${r.mode}`;
  modeEl.textContent = MODE_LABEL[r.mode];
  $("#o-twb").textContent = `${f(r.t_wb)} °C`;
  $("#o-tpad").textContent = `${f(r.t_pad_out)} °C`;
  $("#o-tset").textContent = `${f(r.t_set, 1)} °C`;
  $("#o-tin").textContent = `${f(r.t_in)} °C`;
  $("#o-water").textContent = `${f(r.water, 3)} L/m²·h`;
  $("#o-qac").textContent = `${f(r.q_ac, 1)} W/m²`;
  $("#o-elec").textContent = `${f(r.elec, 1)} W/m²`;

  const tag = (ok) => `<span class="${ok ? "pass" : "fail"}">${ok ? "pass" : "fail"}</span>`;
  const items = [];
  const [dry, pad, ac] = r.trace;
  items.push(`<b>Dry Ventilation</b> ${tag(dry.ok)}: full-flow indoor <code>${f(dry.lhs)} °C</code> ${dry.ok ? "≤" : ">"} setpoint <code>${f(dry.rhs, 1)} °C</code>`);
  if (pad) {
    items.push(`<b>Fan-and-Pad</b> ${tag(pad.ok)}: wet-bulb <code>${f(pad.t_wb)} °C</code> ${pad.wbOk ? "≤" : ">"} <code>${C.T_WB_CRIT} °C</code>; full-flow indoor <code>${f(pad.tInFull)} °C</code> ${pad.tinOk ? "≤" : ">"} <code>${f(pad.limit, 1)} °C</code>`);
  } else items.push(`<span class="skip"><b>Fan-and-Pad</b>: not evaluated</span>`);
  items.push(ac ? `<b>Mechanical AC</b>: selected. House held at <code>${f(r.t_set, 1)} °C</code>.` : `<span class="skip"><b>Mechanical AC</b>: not needed</span>`);
  $("#calc-trace").innerHTML = items.map((x) => `<li>${x}</li>`).join("");
}

function applyPreset(hour) {
  const p = profileHour(hour);
  form.t_out.value = p.t_out.toFixed(1);
  form.t_dp.value = p.t_dp.toFixed(1);
  form.g_solar.value = Math.round(p.g_solar);
  form.p.value = p.pressure_hpa.toFixed(1);
  form.hour.value = hour;
  renderCalc();
}

form.addEventListener("input", renderCalc);
form.addEventListener("submit", (e) => e.preventDefault());
document.querySelectorAll("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => applyPreset(PRESETS[b.dataset.preset]))
);
applyPreset(6);

/* ── 03 · CSV viewer, 05 · summary ────────────────────────────────────── */
let rows = [];
let peakTs = null;
const daySel = $("#day-select");

function renderDay() {
  const date = daySel.value;
  const dayRows = rows.filter((r) => r.date === date);
  const nAc = dayRows.filter((r) => r.mode === "Mechanical_AC").length;
  const water = dayRows.reduce((s, r) => s + r.water_L_m2_hr, 0) * 10;
  const elec = dayRows.reduce((s, r) => s + r.elec_W_m2, 0) * 10;
  $("#day-note").textContent =
    `${nAc} of ${dayRows.length} h on AC · water ${f(water)} m³/ha · electricity ${f(elec, 0)} kWh/ha`;
  $("#csv-table tbody").innerHTML = dayRows.map((r) => `
    <tr class="${r.timestamp_ast === peakTs ? "peak" : ""}" ${r.timestamp_ast === peakTs ? 'title="Peak wet-bulb hour of the month"' : ""}>
      <td>${r.timestamp_ast}</td>
      <td>${f(r.t_out)}</td>
      <td class="${r.t_wb > C.T_WB_CRIT ? "hot" : ""}">${f(r.t_wb)}</td>
      <td>${f(r.g_solar, 1)}</td>
      <td><span class="chip ${r.mode}">${r.mode}</span></td>
      <td>${f(r.t_in)}</td>
      <td>${f(r.v_spec, 3)}</td>
      <td>${f(r.water_L_m2_hr, 4)}</td>
      <td>${f(r.q_ac_W_m2, 1)}</td>
      <td>${f(r.elec_W_m2, 1)}</td>
    </tr>`).join("");
}

function stepDay(d) {
  const i = Math.min(daySel.options.length - 1, Math.max(0, daySel.selectedIndex + d));
  daySel.selectedIndex = i;
  renderDay();
}

function renderSummary(s) {
  const c = s.climate;
  $("#climate-table tbody").innerHTML = `
    <tr><th>Outdoor dry-bulb</th><td>${f(c.t_out.mean)} °C</td><td>${f(c.t_out.max)} °C</td></tr>
    <tr><th>Outdoor wet-bulb</th><td>${f(c.t_wb.mean)} °C</td><td>${f(c.t_wb.max)} °C</td></tr>
    <tr><th>Indoor</th><td>${f(c.t_in.mean)} °C</td><td>${f(c.t_in.max)} °C</td></tr>`;
  $("#mode-table tbody").innerHTML = s.modes.map((m) => `
    <tr><th><span class="chip ${m.mode}">${MODE_LABEL[m.mode]}</span></th>
    <td>${m.hours}</td><td>${f(m.share, 1)}%</td><td>${f(m.water_m3_ha, 1)}</td><td>${f(m.elec_MWh_ha, 1)}</td></tr>`).join("");
  $("#rate-table tbody").innerHTML = `
    <tr><th>Cooling water</th><td>${f(s.water_m3_ha_day)} m³/ha·day</td></tr>
    <tr><th>Cooling electricity</th><td>${Math.round(s.elec_kWh_ha_day).toLocaleString("en-US")} kWh/ha·day</td></tr>
    <tr><th>Peak AC load</th><td>${f(s.peak_ac_MW_ha)} MW/ha</td></tr>`;

  const g = s.sg;
  const [dt, tm] = g.timestamp.split(" ");
  const [, mo, dd] = dt.split("-");
  $("#gun-text").textContent =
    `At peak wet-bulb (${f(g.t_wb, 1)}\u00a0°C on ${dt} ${tm.slice(0, 5)} AST), pad outlet reaches ` +
    `${f(g.t_pad_out, 1)}\u00a0°C, ${f(g.excess, 1)}\u00a0°C above the 25\u00a0°C target. Mechanical AC is mandatory ` +
    `for ${f(g.pct_ac, 1)}% of July daytime hours (${g.n_ac} of ${g.n}).`;

  const set = (k, v) => document.querySelectorAll(`[data-sg="${k}"]`).forEach((el) => (el.textContent = v));
  set("t_pad_out", f(g.t_pad_out, 1));
  set("t_wb", f(g.t_wb, 1));
  set("excess", f(g.excess, 1));
  set("pct_ac", f(g.pct_ac, 1));
  set("n_ac", g.n_ac);
  set("n", g.n);
  set("when", `${Number(dd)} ${MONTHS[Number(mo) - 1]} ${tm.slice(0, 5)} AST`);
}

async function loadReference() {
  const [csvText, stdout] = await Promise.all([
    fetch("/artifacts/agrico_hourly_results.csv").then((r) => r.text()),
    fetch("/artifacts/agrico_stdout.txt").then((r) => r.text()),
  ]);
  $("#ref-stdout").textContent = `$ python agrico_physics_engine.py\n${stdout}`;
  rows = parseCsv(csvText);
  const s = summarize(rows);
  peakTs = s.sg.timestamp;

  const dates = [...new Set(rows.map((r) => r.date))];
  daySel.innerHTML = dates.map((d) => `<option value="${d}">${d}</option>`).join("");
  daySel.value = peakTs.slice(0, 10);
  renderDay();
  renderSummary(s);
}

daySel.addEventListener("change", renderDay);
$("#day-prev").addEventListener("click", () => stepDay(-1));
$("#day-next").addEventListener("click", () => stepDay(1));
loadReference().catch((e) => { $("#ref-stdout").textContent = `Could not load reference artifacts: ${e}`; });

/* ── 02 · live two-run hash ───────────────────────────────────────────── */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function runOnce(panel, source) {
  const state = $("[data-state]", panel);
  const out = $("[data-stdout]", panel);
  const hashEl = $("[data-hash]", panel);
  const dl = $("[data-dl]", panel);
  state.className = "run-state";
  state.textContent = "starting";
  out.textContent = "$ python agrico_physics_engine.py\n";
  hashEl.className = "hash";
  hashEl.textContent = "–";
  dl.querySelectorAll("a").forEach((a) => URL.revokeObjectURL(a.href));
  dl.innerHTML = "";

  return new Promise((resolve) => {
    const worker = new Worker("/js/run-worker.js", { type: "module" });
    worker.onmessage = async ({ data }) => {
      if (data.type === "status") {
        state.textContent = data.text;
        out.textContent += `… ${data.text}\n`;
        return;
      }
      worker.terminate();
      if (data.type === "error") {
        state.className = "run-state err";
        state.textContent = "failed";
        out.textContent += `\n${data.text}\n`;
        resolve(null);
        return;
      }
      out.textContent = `$ python agrico_physics_engine.py\n${data.stdout}`;
      const engineHash = (data.stdout.match(/CSV sha256: ([0-9a-f]{64})/) || [])[1] || null;
      const browserHash = hex(await crypto.subtle.digest("SHA-256", data.csv));
      hashEl.textContent = browserHash;
      state.className = "run-state ok";
      state.textContent = `engine ${(data.engineMs / 1000).toFixed(1)} s · total ${(data.totalMs / 1000).toFixed(1)} s`;
      const csvUrl = URL.createObjectURL(new Blob([data.csv], { type: "text/csv" }));
      const pngUrl = URL.createObjectURL(new Blob([data.png], { type: "image/png" }));
      dl.innerHTML = `<a href="${csvUrl}" download="agrico_hourly_results.csv">agrico_hourly_results.csv</a>` +
        `<a href="${pngUrl}" download="agrico_july_proof.png">agrico_july_proof.png</a>`;
      resolve({ engineHash, browserHash, hashEl });
    };
    worker.onerror = (e) => {
      worker.terminate();
      state.className = "run-state err";
      state.textContent = "failed";
      out.textContent += `\n${e.message || "Worker error"}\n`;
      resolve(null);
    };
    worker.postMessage({ source });
  });
}

const runBtn = $("#run-btn");
runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  runBtn.textContent = "Running…";
  const verdict = $("#verdict");
  verdict.hidden = true;
  try {
    const source = await fetch("/engine/agrico_physics_engine.py").then((r) => r.text());
    const [a, b] = await Promise.all([runOnce($("#run-a"), source), runOnce($("#run-b"), source)]);
    verdict.hidden = false;
    if (!a || !b) {
      verdict.className = "verdict bad";
      verdict.textContent = "A run did not complete, so there is nothing to compare. See the panel output above.";
      return;
    }
    const same = a.browserHash === b.browserHash;
    const engineAgrees = a.engineHash === a.browserHash && b.engineHash === b.browserHash;
    const golden = a.browserHash === GOLDEN;
    for (const r of [a, b]) r.hashEl.classList.add(r.browserHash === GOLDEN ? "match" : "mismatch");
    verdict.className = `verdict ${same && engineAgrees && golden ? "ok" : "bad"}`;
    verdict.innerHTML = `<strong>${same ? "Run A and Run B produced byte-identical CSVs." : "Run A and Run B differ."}</strong>
      <ul>
        <li>Hash printed by the engine and hash computed by the browser: ${engineAgrees ? "agree in both runs" : "disagree"}.</li>
        <li>Reference hash from native CPython: ${golden ? "matches" : "does not match"} <code>${GOLDEN.slice(0, 12)}…</code></li>
      </ul>`;
  } catch (e) {
    verdict.hidden = false;
    verdict.className = "verdict bad";
    verdict.textContent = `Could not start the runs: ${e}`;
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run engine twice again";
  }
});
