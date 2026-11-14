// Single-hour port of run_model_row() from agrico_physics_engine.py.
// Same constants, same order of tests, same arithmetic.

export const C = {
  ETA_PAD: 0.82, V_SPEC_MAX: 0.05, V_SPEC_MIN: 0.01, U_COVER: 4.2, A_RATIO: 1.15,
  TAU_SOLAR: 0.68, F_SENS: 0.45, T_SET_DAY: 25.0, T_SET_NIGHT: 19.0, T_WB_CRIT: 23.5,
  BLEED_FACTOR: 1.12, Q_INF_SPEC: 15.0, COP_AC: 3.2, FAN_SP_POWER: 18.0,
  CP_AIR: 1006.0, H_FG: 2.45e6,
};

export const satVaporPressureHpa = (T) => 6.112 * Math.exp((17.67 * T) / (T + 243.5));

export function wetBulbTemp(Tdb, Tdp, P) {
  if (Tdp > Tdb) return Tdb;
  const gamma = 0.000662 * P;
  const eActual = satVaporPressureHpa(Tdp);
  let lo = Tdp, hi = Tdb;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    const eWb = satVaporPressureHpa(mid) - gamma * (Tdb - mid);
    if (eWb < eActual) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export const airDensity = (Tdb, P) => (P * 100.0) / (287.058 * (Tdb + 273.15));
export const padOutletTemp = (Tdb, Twb, eta) => Tdb - eta * (Tdb - Twb);

export function runModelRow({ t_out, t_dp, pressure_hpa, g_solar, hour }) {
  const T_wb = wetBulbTemp(t_out, t_dp, pressure_hpa);
  const rho = airDensity(t_out, pressure_hpa);
  const UA = C.U_COVER * C.A_RATIO;
  const Q_sens = C.F_SENS * C.TAU_SOLAR * g_solar;
  const T_pad = padOutletTemp(t_out, T_wb, C.ETA_PAD);
  const T_set = hour >= 6 && hour <= 18 ? C.T_SET_DAY : C.T_SET_NIGHT;
  const capMax = rho * C.CP_AIR * C.V_SPEC_MAX;
  const base = { t_wb: T_wb, t_pad_out: T_pad, t_set: T_set };
  const trace = [];

  // Mode 1 — Dry Ventilation
  const tDryFull = t_out + Q_sens / (capMax + UA);
  const dryOk = tDryFull <= T_set;
  trace.push({ mode: "Dry_Ventilation", ok: dryOk, lhs: tDryFull, rhs: T_set });
  if (dryOk) {
    const v = C.V_SPEC_MIN;
    return { ...base, trace, mode: "Dry_Ventilation", v_spec: v,
      t_in: t_out + Q_sens / (rho * C.CP_AIR * v + UA),
      water: 0, q_ac: 0, elec: C.FAN_SP_POWER * (v / C.V_SPEC_MAX) ** 2 };
  }

  // Mode 2 — Fan-and-Pad
  const tInFull = T_pad + (Q_sens + UA * (t_out - T_pad)) / (rho * C.CP_AIR * C.V_SPEC_MAX + UA);
  const wbOk = T_wb <= C.T_WB_CRIT;
  const tinOk = tInFull <= T_set + 1.5;
  trace.push({ mode: "Fan_and_Pad", ok: wbOk && tinOk, wbOk, tinOk, t_wb: T_wb, tInFull, limit: T_set + 1.5 });
  if (wbOk && tinOk) {
    const v = C.V_SPEC_MAX;
    const dw = (C.CP_AIR * (t_out - T_pad)) / C.H_FG;
    return { ...base, trace, mode: "Fan_and_Pad", v_spec: v,
      t_in: T_pad + (Q_sens + UA * (t_out - T_pad)) / (rho * C.CP_AIR * v + UA),
      water: rho * v * dw * 3600.0 * C.BLEED_FACTOR, q_ac: 0,
      elec: C.FAN_SP_POWER * (v / C.V_SPEC_MAX) ** 2 };
  }

  // Mode 3 — Mechanical AC
  const Q_AC = Math.max(0, C.TAU_SOLAR * g_solar + UA * (t_out - T_set) + C.Q_INF_SPEC);
  trace.push({ mode: "Mechanical_AC", ok: true });
  return { ...base, trace, mode: "Mechanical_AC", v_spec: 0, t_in: T_set,
    water: 0, q_ac: Q_AC, elec: Q_AC / C.COP_AC + 4.0 };
}

// Noise-free synthetic profile for a given hour (06–14), as in generate_synthetic_profile().
export function profileHour(hour) {
  const frac = (hour - 6) / 8;
  const s = Math.sin(0.5 * Math.PI * frac);
  return {
    t_out: 30 + 12 * s,
    t_dp: 20 + 6 * s,
    g_solar: 950 * Math.sin(Math.PI * frac) ** 0.7,
    pressure_hpa: 1013,
    hour,
  };
}

export const MODE_LABEL = {
  Dry_Ventilation: "Dry Ventilation",
  Fan_and_Pad: "Fan-and-Pad",
  Mechanical_AC: "Mechanical AC",
};
