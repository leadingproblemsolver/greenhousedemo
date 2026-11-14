# Al Khor July-day greenhouse simulator

A reproducible July-day simulator that shows when evaporative pad cooling stops working
at a hot-arid site, and what the AC and water penalty is when it does.

- `site/engine/agrico_physics_engine.py` is the engine: a single Python file (numpy, pandas, matplotlib).
- `site/artifacts/` holds the reference outputs: `agrico_hourly_results.csv`, `agrico_july_proof.png`, `agrico_stdout.txt`.
- `site/` is the static demo page. It shows the physics, the run hash, the CSV, the figure and the summary,
  and can run the engine twice in the browser through Pyodide.

## Run

    pip install -r site/engine/requirements.txt
    python site/engine/agrico_physics_engine.py

With no ERA5-Land NetCDF present, the engine uses the seed-42 synthetic July profile. The CSV sha256 is

    a43fe36177a67c9fd34b1f2d3addea9ef2eb12d750da68718be6cf0b58f16839

on CPython 3.14 / numpy 2.5 and on Pyodide (WebAssembly) / numpy 2.4.

## Regenerate the reference artifacts

    cd site/artifacts && python ../engine/agrico_physics_engine.py > agrico_stdout.txt

Reference case: Al Khor CFD study; pad effectiveness: IFAS extension guidance.
