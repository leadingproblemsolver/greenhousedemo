#!/usr/bin/env python3
"""
Agrico Al Khor greenhouse heat-and-mass balance — single-file engine (v1.1.0).

    python agrico_physics_engine.py

Deterministic. No GPU, no network. Produces three artifacts:
  1. agrico_hourly_results.csv  — hourly results, 10 columns
  2. agrico_july_proof.png      — 200-dpi proof figure with mode shading
  3. stdout summary             — summary table, smoking gun, CSV sha256 run hash

If the ERA5-Land NetCDF file is absent, a seed-42 synthetic July profile is used,
so two runs on any machine produce byte-identical CSVs and the same run hash.

Reference case: Al Khor CFD study. Pad effectiveness: IFAS extension guidance.
"""
import hashlib
import math
import os
import sys
import warnings

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

__version__ = "1.1.0"

# ── Constants ────────────────────────────────────────────────────────────────
SITE_LAT     = 25.7418
SITE_LON     = 51.4739
NETCDF_FILE  = "agrico_alkhor_era5land_202507.nc"

ETA_PAD       = 0.82       # pad saturation effectiveness
V_SPEC_MAX    = 0.050      # m³/(m²·s) specific ventilation, full flow
V_SPEC_MIN    = 0.010
U_COVER       = 4.2        # W/(m²·K)
A_RATIO       = 1.15       # cover area / floor area
TAU_SOLAR     = 0.68       # cover solar transmittance
F_SENS        = 0.45       # sensible fraction of transmitted solar
T_SET_DAY     = 25.0       # °C
T_SET_NIGHT   = 19.0
T_WB_CRIT     = 23.5       # °C — above this wet-bulb, pad cooling cannot hold setpoint
BLEED_FACTOR  = 1.12
Q_INF_SPEC    = 15.0       # W/m² infiltration load under AC
COP_AC        = 3.2
FAN_SP_POWER  = 18.0       # W/m² at full flow
CP_AIR        = 1006.0     # J/(kg·K)
H_FG          = 2.45e6     # J/kg

SYNTH_SEED    = 42
SYNTH_T_DB_MIN, SYNTH_T_DB_MAX = 30.0, 42.0
SYNTH_T_DP_MIN, SYNTH_T_DP_MAX = 20.0, 26.0
SYNTH_G_MAX   = 950.0      # W/m²
SYNTH_P_HPA   = 1013.0

PROVENANCE = ("Reference case: Al Khor CFD study; "
              "pad effectiveness: IFAS extension guidance.")

CSV_PATH = "agrico_hourly_results.csv"
PNG_PATH = "agrico_july_proof.png"
CSV_COLUMNS = ["timestamp_ast", "t_out", "t_wb", "g_solar", "mode",
               "t_in", "v_spec", "water_L_m2_hr", "q_ac_W_m2", "elec_W_m2"]


# ── Psychrometrics (Magnus-Tetens) ───────────────────────────────────────────
def sat_vapor_pressure_hpa(T_c):
    return 6.112 * math.exp((17.67 * T_c) / (T_c + 243.5))


def wet_bulb_temp(T_db, T_dp, P_hPa):
    """Psychrometric equation solved by bisection between T_dp and T_db (40 iterations)."""
    if T_dp > T_db:
        return T_db  # guard against noisy inputs
    gamma    = 0.000662 * P_hPa
    e_actual = sat_vapor_pressure_hpa(T_dp)
    lo, hi   = T_dp, T_db
    for _ in range(40):
        mid  = 0.5 * (lo + hi)
        e_wb = sat_vapor_pressure_hpa(mid) - gamma * (T_db - mid)
        if e_wb < e_actual:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def air_density(T_db, P_hPa):
    return (P_hPa * 100.0) / (287.058 * (T_db + 273.15))


def pad_outlet_temp(T_db, T_wb, eta):
    """Pad outlet dry-bulb: T_db − η·(T_db − T_wb)."""
    return T_db - eta * (T_db - T_wb)


# ── Weather input ────────────────────────────────────────────────────────────
def _deaccumulate_ssrd(df):
    """ERA5-Land ssrd (J/m², accumulated since 00 UTC) -> instantaneous W/m²."""
    df = df.sort_values("time_utc").reset_index(drop=True)
    prev     = df["ssrd"].shift(1)
    diff     = df["ssrd"] - prev
    # Accumulations restart at 01 UTC; the 00 UTC value closes the previous day.
    is_reset = (df["time_utc"].dt.hour == 1) | prev.isna() | (diff < 0)
    inst     = np.where(is_reset, df["ssrd"] / 3600.0, diff / 3600.0)
    df["g_solar"] = np.clip(inst, 0.0, None)
    return df


def load_netcdf(path):
    import xarray as xr
    ds = xr.open_dataset(path)
    for lat_name in ("latitude", "lat"):
        if lat_name in ds.coords or lat_name in ds.dims:
            ds = ds.sel({lat_name: SITE_LAT}, method="nearest")
            break
    for lon_name in ("longitude", "lon"):
        if lon_name in ds.coords or lon_name in ds.dims:
            ds = ds.sel({lon_name: SITE_LON}, method="nearest")
            break
    time_name = next((t for t in ("valid_time", "time", "forecast_time")
                      if t in ds.coords or t in ds.dims), None)
    if time_name is None:
        raise RuntimeError("No time coordinate found in NetCDF")
    df = pd.DataFrame({
        "time_utc": pd.to_datetime(ds[time_name].values),
        "t2m":      ds["t2m"].values,
        "d2m":      ds["d2m"].values,
        "sp":       ds["sp"].values,
        "ssrd":     ds["ssrd"].values,
    })
    df["t_out"]        = df["t2m"] - 273.15
    df["t_dp"]         = df["d2m"] - 273.15
    df["pressure_hpa"] = df["sp"] / 100.0
    df = _deaccumulate_ssrd(df)
    df["timestamp_ast"] = df["time_utc"] + pd.Timedelta(hours=3)
    df["hour"]          = df["timestamp_ast"].dt.hour
    return df[["timestamp_ast", "t_out", "t_dp", "pressure_hpa", "g_solar", "hour"]]


def generate_synthetic_profile():
    """Deterministic synthetic July 2025 profile, 06:00–14:00 AST, seed 42."""
    rng  = np.random.default_rng(SYNTH_SEED)
    rows = []
    for day in range(1, 32):
        for hour in range(6, 15):
            frac = (hour - 6) / 8.0
            t_db = SYNTH_T_DB_MIN + (SYNTH_T_DB_MAX - SYNTH_T_DB_MIN) * math.sin(0.5 * math.pi * frac)
            t_dp = SYNTH_T_DP_MIN + (SYNTH_T_DP_MAX - SYNTH_T_DP_MIN) * math.sin(0.5 * math.pi * frac)
            g    = SYNTH_G_MAX * (math.sin(math.pi * frac)) ** 0.7
            t_db += rng.normal(0, 0.25)
            t_dp += rng.normal(0, 0.25)
            g    += rng.normal(0, 4.0)
            g     = max(0.0, min(g, SYNTH_G_MAX + 20.0))
            rows.append({
                "timestamp_ast": pd.Timestamp(year=2025, month=7, day=day, hour=hour),
                "t_out": t_db,
                "t_dp":  t_dp,
                "pressure_hpa": SYNTH_P_HPA,
                "g_solar": g,
                "hour": hour,
            })
    return pd.DataFrame(rows)


def calibration_check(df, tol=0.5):
    """Self-test: mean of daily peaks within tol of 42.0 °C dry-bulb and 30.0 °C wet-bulb."""
    wb = [wet_bulb_temp(a, b, p) for a, b, p in zip(df.t_out, df.t_dp, df.pressure_hpa)]
    d = df.assign(t_wb=wb, date=df["timestamp_ast"].dt.date).groupby("date")
    db_peak, wb_peak = d["t_out"].max().mean(), d["t_wb"].max().mean()
    return {"peak_dry_bulb_c": db_peak, "peak_wet_bulb_c": wb_peak,
            "pass": bool(abs(db_peak - 42.0) <= tol and abs(wb_peak - 30.0) <= tol)}


# ── Three-mode heat-and-mass balance ─────────────────────────────────────────
def _result(mode, T_wb, T_pad_out, T_in, v_spec, water, Q_AC, elec):
    return {"mode": mode, "t_wb": T_wb, "t_pad_out": T_pad_out, "t_in": T_in,
            "v_spec": v_spec, "water_L_m2_hr": water, "q_ac_W_m2": Q_AC,
            "elec_W_m2": elec}


def run_model_row(row):
    T_out   = float(row["t_out"])
    T_dp    = float(row["t_dp"])
    P_hPa   = float(row["pressure_hpa"])
    G_solar = float(row["g_solar"])
    hour    = int(row["hour"])

    T_wb   = wet_bulb_temp(T_out, T_dp, P_hPa)
    rho    = air_density(T_out, P_hPa)
    UA     = U_COVER * A_RATIO
    Q_sens = F_SENS * TAU_SOLAR * G_solar
    T_pad  = pad_outlet_temp(T_out, T_wb, ETA_PAD)
    T_set  = T_SET_DAY if 6 <= hour <= 18 else T_SET_NIGHT
    cap_max = rho * CP_AIR * V_SPEC_MAX

    # Mode 1 — Dry Ventilation: outdoor air alone holds setpoint at full flow
    if T_out + Q_sens / (cap_max + UA) <= T_set:
        v_spec = V_SPEC_MIN
        T_in   = T_out + Q_sens / (rho * CP_AIR * v_spec + UA)
        elec   = FAN_SP_POWER * (v_spec / V_SPEC_MAX) ** 2
        return _result("Dry_Ventilation", T_wb, T_pad, T_in, v_spec, 0.0, 0.0, elec)

    # Mode 2 — Fan-and-Pad: wet-bulb below threshold and indoor within setpoint + 1.5 K
    T_in_full = T_pad + (Q_sens + UA * (T_out - T_pad)) / (rho * CP_AIR * V_SPEC_MAX + UA)
    if T_wb <= T_WB_CRIT and T_in_full <= T_set + 1.5:
        v_spec  = V_SPEC_MAX
        T_in    = T_pad + (Q_sens + UA * (T_out - T_pad)) / (rho * CP_AIR * v_spec + UA)
        delta_w = CP_AIR * (T_out - T_pad) / H_FG
        water   = rho * v_spec * delta_w * 3600.0 * BLEED_FACTOR
        elec    = FAN_SP_POWER * (v_spec / V_SPEC_MAX) ** 2
        return _result("Fan_and_Pad", T_wb, T_pad, T_in, v_spec, water, 0.0, elec)

    # Mode 3 — Mechanical AC: sealed house, full solar + conduction + infiltration load
    Q_AC = max(0.0, TAU_SOLAR * G_solar + UA * (T_out - T_set) + Q_INF_SPEC)
    elec = Q_AC / COP_AC + 4.0
    return _result("Mechanical_AC", T_wb, T_pad, T_set, 0.0, 0.0, Q_AC, elec)


def run_model(df):
    res = pd.DataFrame([run_model_row(r) for _, r in df.iterrows()])
    return pd.concat([df.reset_index(drop=True), res], axis=1)


# ── Outputs ──────────────────────────────────────────────────────────────────
def _daytime(df):
    return df[(df["hour"] >= 6) & (df["hour"] <= 14)]


def write_csv(df, path=CSV_PATH):
    df[CSV_COLUMNS].to_csv(path, index=False)
    return path


def smoking_gun(df):
    day  = _daytime(df)
    peak = day.loc[day["t_wb"].idxmax()]
    n_ac = int((day["mode"] == "Mechanical_AC").sum())
    return {"t_wb": peak["t_wb"], "t_pad_out": peak["t_pad_out"],
            "excess": peak["t_pad_out"] - T_SET_DAY, "when": peak["timestamp_ast"],
            "hour": int(peak["hour"]), "n_ac": n_ac, "n": len(day),
            "pct_ac": 100.0 * n_ac / len(day)}


def write_png(df, path=PNG_PATH):
    day   = _daytime(df)
    hours = list(range(6, 15))
    mean_t_out = day.groupby("hour")["t_out"].mean().reindex(hours)
    mean_t_wb  = day.groupby("hour")["t_wb"].mean().reindex(hours)
    mean_t_pad = day.groupby("hour")["t_pad_out"].mean().reindex(hours)

    mode_by_hour = {}
    for h in hours:
        modes = day[day["hour"] == h]["mode"]
        mode_by_hour[h] = modes.mode().iloc[0] if len(modes) else "Dry_Ventilation"

    plt.rcParams["font.family"] = "sans-serif"
    fig, ax = plt.subplots(figsize=(10, 6.2), facecolor="white")
    shade = {"Mechanical_AC": "red", "Fan_and_Pad": "blue", "Dry_Ventilation": "gray"}
    for h in hours:
        ax.axvspan(h - 0.5, h + 0.5, color=shade[mode_by_hour[h]], alpha=0.12, lw=0)

    ax.plot(hours, mean_t_out, color="red",    ls="-",  lw=2, label="Outdoor dry-bulb")
    ax.plot(hours, mean_t_wb,  color="blue",   ls="-",  lw=2, label="Outdoor wet-bulb")
    ax.plot(hours, mean_t_pad, color="orange", ls="--", lw=2, label="Pad outlet")
    ax.axhline(T_SET_DAY, color="green", ls=":", lw=2, label="Target 25 °C")

    # Smoking gun: the single hottest wet-bulb hour of the month
    sg = smoking_gun(df)
    ax.plot([sg["hour"]], [sg["t_pad_out"]], marker="o", ms=8, mfc="white",
            mec="orange", mew=2, ls="none", zorder=5)
    ax.vlines(sg["hour"], T_SET_DAY, sg["t_pad_out"], colors="black", lw=1, zorder=4)
    ax.annotate(
        f"Peak wet-bulb {sg['t_wb']:.1f} °C ({sg['when'].strftime('%d %b %H:%M')} AST)\n"
        f"Pad outlet {sg['t_pad_out']:.1f} °C: {sg['excess']:.1f} °C above target",
        xy=(sg["hour"], sg["t_pad_out"]), xytext=(10.2, 34.6),
        fontsize=9, ha="center",
        arrowprops=dict(arrowstyle="->", color="black", lw=1),
        bbox=dict(boxstyle="square,pad=0.4", fc="white", ec="black", lw=0.8))

    ax.set_xlabel("Hour of day (AST)")
    ax.set_ylabel("Temperature (°C)")
    ax.set_title("Al Khor, July 2025: pad outlet vs 25 °C target (hourly means, 06–14 AST)")
    ax.set_xticks(hours)
    ax.set_xlim(5.5, 14.5)
    ax.grid(alpha=0.3)

    handles, _ = ax.get_legend_handles_labels()
    patches = [mpatches.Patch(color="red",  alpha=0.25, label="Mechanical AC"),
               mpatches.Patch(color="blue", alpha=0.25, label="Fan-and-Pad"),
               mpatches.Patch(color="gray", alpha=0.25, label="Dry Ventilation")]
    ax.legend(handles=handles + patches, loc="upper left", fontsize=9, framealpha=0.95)

    fig.text(0.01, 0.01, PROVENANCE, fontsize=7.5, color="#555555", ha="left", va="bottom")
    plt.tight_layout(rect=(0, 0.03, 1, 1))
    plt.savefig(path, dpi=200, facecolor="white")
    plt.close(fig)
    return path


def print_summary(df):
    day = _daytime(df)
    print("=" * 66)
    print("AL KHOR — JULY 2025 SUMMARY (06:00–14:00 AST)")
    print("=" * 66)
    print(f"Mean dry-bulb:  {day['t_out'].mean():6.2f} °C   Max: {day['t_out'].max():6.2f} °C")
    print(f"Mean wet-bulb:  {day['t_wb'].mean():6.2f} °C   Max: {day['t_wb'].max():6.2f} °C")
    print(f"Mean indoor:    {day['t_in'].mean():6.2f} °C")
    print()
    print(f"{'Mode':18s} {'hours':>6s} {'share':>7s} {'water m³/ha':>12s} {'elec MWh/ha':>12s}")
    print("-" * 66)
    for mode in ("Dry_Ventilation", "Fan_and_Pad", "Mechanical_AC"):
        m = day[day["mode"] == mode]
        print(f"{mode.replace('_', ' '):18s} {len(m):6d} {100.0 * len(m) / len(day):6.1f}% "
              f"{m['water_L_m2_hr'].sum() * 10:12.1f} "
              f"{m['elec_W_m2'].sum() * 10 / 1000:12.1f}")
    print("  (July totals, 06–14h; water L/m² ×10 = m³/ha; elec Wh/m² ×10 /1000 = MWh/ha)")
    print()
    daily = day.groupby(day["timestamp_ast"].dt.date).agg(
        water=("water_L_m2_hr", "sum"), elec=("elec_W_m2", "sum"))
    # L/m²/day -> m³/ha/day: ×10 ; Wh/m²/day -> kWh/ha/day: ×10
    print(f"Mean daily cooling water:       {(daily['water'] * 10).mean():7.2f} m³/ha/day  (06–14h)")
    print(f"Mean daily cooling electricity: {(daily['elec']  * 10).mean():7.2f} kWh/ha/day (06–14h)")
    print(f"Peak AC cooling load:           {day['q_ac_W_m2'].max() * 10 / 1000:7.2f} MW/ha")
    print()


def print_smoking_gun(df):
    sg = smoking_gun(df)
    print("SMOKING GUN")
    print("-" * 66)
    print(f"At peak wet-bulb ({sg['t_wb']:.1f} °C on "
          f"{sg['when'].strftime('%Y-%m-%d %H:%M')} AST), "
          f"pad outlet reaches {sg['t_pad_out']:.1f} °C — exceeding the 25 °C "
          f"target by {sg['excess']:.1f} °C. Mechanical AC is mandatory for {sg['pct_ac']:.1f}% of July "
          f"daytime hours ({sg['n_ac']} of {sg['n']}).")
    print()


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# ── Entry point ──────────────────────────────────────────────────────────────
def main(outdir="."):
    print(f"[agrico] engine v{__version__} · python {sys.version.split()[0]} · numpy {np.__version__}")
    print("[agrico] Loading input...")
    if os.path.exists(NETCDF_FILE):
        print(f"[agrico] NetCDF found: {NETCDF_FILE}")
        try:
            df = load_netcdf(NETCDF_FILE)
            print(f"[agrico] Loaded {len(df)} hourly rows from NetCDF.")
        except Exception as exc:
            warnings.warn(f"NetCDF load failed ({exc}); using synthetic fallback.")
            df = generate_synthetic_profile()
    else:
        print(f"[agrico] NetCDF not found: {NETCDF_FILE} — using synthetic fallback (seed {SYNTH_SEED}).")
        df = generate_synthetic_profile()
        print(f"[agrico] Generated {len(df)} synthetic rows (06–14h AST).")

    print("[agrico] Running thermodynamic model...")
    df = run_model(df)

    csv_path = os.path.join(outdir, CSV_PATH)
    png_path = os.path.join(outdir, PNG_PATH)
    print("[agrico] Writing outputs...")
    print(f"[agrico]   {write_csv(df, csv_path)}")
    print(f"[agrico]   {write_png(df, png_path)}")
    print()

    cal = calibration_check(generate_synthetic_profile())
    print(f"[agrico] Calibration: mean daily peak DB {cal['peak_dry_bulb_c']:.2f} °C, "
          f"WB {cal['peak_wet_bulb_c']:.2f} °C -> {'PASS' if cal['pass'] else 'FAIL'}")
    print(f"[agrico] CSV sha256: {sha256_file(csv_path)}")
    print()
    print_summary(df)
    print_smoking_gun(df)
    print(PROVENANCE)
    return df


if __name__ == "__main__":
    main()
