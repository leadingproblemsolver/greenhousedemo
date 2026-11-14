// Parses the engine CSV and reproduces the stdout summary from it.
import { C } from "./physics.js";

const NUM = ["t_out", "t_wb", "g_solar", "t_in", "v_spec", "water_L_m2_hr", "q_ac_W_m2", "elec_W_m2"];

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    head.forEach((h, i) => { row[h] = NUM.includes(h) ? Number(cells[i]) : cells[i]; });
    row.date = row.timestamp_ast.slice(0, 10);
    row.hour = Number(row.timestamp_ast.slice(11, 13));
    row.t_pad_out = row.t_out - C.ETA_PAD * (row.t_out - row.t_wb);
    return row;
  });
}

const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => sum(a) / a.length;
const max = (a) => Math.max(...a);

export function summarize(rows) {
  const day = rows.filter((r) => r.hour >= 6 && r.hour <= 14);
  const nDays = new Set(day.map((r) => r.date)).size;
  const col = (k, rs = day) => rs.map((r) => r[k]);

  const modes = ["Dry_Ventilation", "Fan_and_Pad", "Mechanical_AC"].map((mode) => {
    const m = day.filter((r) => r.mode === mode);
    return {
      mode, hours: m.length, share: (100 * m.length) / day.length,
      water_m3_ha: sum(col("water_L_m2_hr", m)) * 10,
      elec_MWh_ha: (sum(col("elec_W_m2", m)) * 10) / 1000,
    };
  });

  // peak wet-bulb row (first occurrence, as pandas idxmax)
  let peak = day[0];
  for (const r of day) if (r.t_wb > peak.t_wb) peak = r;
  const nAc = day.filter((r) => r.mode === "Mechanical_AC").length;

  return {
    n: day.length, nDays,
    climate: {
      t_out: { mean: mean(col("t_out")), max: max(col("t_out")) },
      t_wb: { mean: mean(col("t_wb")), max: max(col("t_wb")) },
      t_in: { mean: mean(col("t_in")), max: max(col("t_in")) },
    },
    modes,
    water_m3_ha_day: (sum(col("water_L_m2_hr")) * 10) / nDays,
    elec_kWh_ha_day: (sum(col("elec_W_m2")) * 10) / nDays,
    peak_ac_MW_ha: (max(col("q_ac_W_m2")) * 10) / 1000,
    sg: {
      t_wb: peak.t_wb, t_pad_out: peak.t_pad_out, excess: peak.t_pad_out - C.T_SET_DAY,
      timestamp: peak.timestamp_ast, n_ac: nAc, n: day.length, pct_ac: (100 * nAc) / day.length,
    },
  };
}
