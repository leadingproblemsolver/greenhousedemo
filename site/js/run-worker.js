/* Runs the unmodified engine file in a fresh Pyodide interpreter.
   One worker = one interpreter = one run. The page terminates it afterwards. */
const PYODIDE_VERSION = "314.0.8";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (event) => {
  const { source } = event.data;
  const t0 = performance.now();
  try {
    post({ type: "status", text: "loading python" });
    const { loadPyodide } = await import(`${INDEX_URL}pyodide.mjs`);
    const py = await loadPyodide({ indexURL: INDEX_URL, stdout: () => {}, stderr: () => {} });
    post({ type: "status", text: "loading numpy, pandas, matplotlib" });
    await py.loadPackage(["numpy", "pandas", "matplotlib"], { messageCallback: () => {} });

    py.FS.mkdirTree("/run");
    py.FS.writeFile("/run/agrico_physics_engine.py", source);

    post({ type: "status", text: "running" });
    const t1 = performance.now();
    const stdout = await py.runPythonAsync(`
import os, io, runpy, contextlib, warnings
warnings.filterwarnings("ignore")
os.chdir("/run")
_buf = io.StringIO()
with contextlib.redirect_stdout(_buf):
    runpy.run_path("agrico_physics_engine.py", run_name="__main__")
_buf.getvalue()
`);
    const engineMs = performance.now() - t1;
    const csv = py.FS.readFile("/run/agrico_hourly_results.csv");
    const png = py.FS.readFile("/run/agrico_july_proof.png");
    post(
      { type: "done", stdout, csv, png, engineMs, totalMs: performance.now() - t0 },
      [csv.buffer, png.buffer]
    );
  } catch (err) {
    post({ type: "error", text: String(err && err.message ? err.message : err) });
  }
};
