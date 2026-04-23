import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import Papa from "papaparse";

// ─── Config ─────────────────────────────────────────────────
const SPREADSHEET_ID = "1PWoAECjRVGu85YH3r8zL0s-Wi2CastXMYDWGtd7S8ZI";
const SHEET_NAME = "Hoja 1";

// CSV público del Sheet de viajes (default, para leer datos existentes)
const DEFAULT_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQoXDMe1856GFyKLBBXGcgeUnkqttWGvFXbbeKDwGWoNDuBd0Tn9VJLDfRSezlD8zHi8Q_E6RlciYlT/pub?gid=0&single=true&output=csv";

const COLUMNS = [
  "Expedicion","Solicitud","Cliente","Nombre","Apellido",
  "Fecha","Tracto","Rampla","Origen","Destino",
  "Kilometro","Carga","Guia",
];

const FIELD_KEYS = [
  "expedicion","solicitud","cliente","nombre","apellido",
  "fecha","tracto","rampla","origen","destino",
  "kilometro","carga","guia",
];

// Google OAuth — reusa el mismo Client ID que sync-ventas
// Si necesitas uno nuevo: Google Cloud Console → APIs & Services → Credentials
const CLIENT_ID = "561192158983-19lj0jhcecfl89iif4dtabc6qieqbh0q.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

// ─── Helpers ────────────────────────────────────────────────
function parseDateDMY(str) {
  if (!str) return null;
  const parts = str.split("/");
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
}

function formatDateDMY(date) {
  if (!date || isNaN(date)) return "—";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function formatDateISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fmt(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseUploadedCSV(text) {
  // Detect separator: if first line has ; use that, otherwise ,
  const firstLine = text.split("\n")[0] || "";
  const sep = firstLine.includes(";") ? ";" : ",";

  const result = Papa.parse(text, {
    delimiter: sep,
    header: false,
    skipEmptyLines: true,
    quoteChar: '"',
  });

  if (!result.data || result.data.length < 2) return [];

  // Skip header row
  const rows = [];
  for (let i = 1; i < result.data.length; i++) {
    const cols = result.data[i];
    if (!cols || cols.length < 13) continue;

    const row = {};
    FIELD_KEYS.forEach((key, j) => {
      let val = (cols[j] || "").trim();
      // Remove BOM if present
      if (j === 0) val = val.replace(/^\uFEFF/, "");
      row[key] = val;
    });

    // Skip empty rows
    if (!row.expedicion && !row.fecha) continue;
    rows.push(row);
  }
  return rows;
}

// ─── Google Sheets API ──────────────────────────────────────
let tokenClient = null;
let accessToken = (typeof sessionStorage !== "undefined" && sessionStorage.getItem("sv_token")) || null;
let tokenExpiry = (typeof sessionStorage !== "undefined" && Number(sessionStorage.getItem("sv_exp"))) || 0;

function isTokenValid() {
  return accessToken && Date.now() < tokenExpiry - 60_000;
}

function loadGsiScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("No se pudo cargar Google Identity Services"));
    document.head.appendChild(s);
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: () => {},
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      try {
        sessionStorage.setItem("sv_token", accessToken);
        sessionStorage.setItem("sv_exp", String(tokenExpiry));
      } catch {}
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

async function getToken() {
  await loadGsiScript();
  try {
    return await requestToken("");
  } catch {
    return await requestToken("consent");
  }
}

async function sheetsAPI(url, options = {}) {
  if (!isTokenValid()) await getToken();
  let resp = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...options.headers },
  });
  if (resp.status === 401) {
    await getToken();
    resp = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
  }
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Sheets API error ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function readSheetData() {
  const range = encodeURIComponent(`'${SHEET_NAME}'!A:M`);
  return sheetsAPI(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?valueRenderOption=FORMATTED_VALUE`
  );
}

async function syncToSheet(cutoffDate, newRows, onProgress) {
  onProgress?.("Leyendo datos actuales del Sheet...");
  const existing = await readSheetData();
  const allRows = existing.values || [];

  const header = allRows.length > 0 ? allRows[0] : COLUMNS;
  const dataRows = allRows.slice(1);

  // Keep rows BEFORE cutoff
  const keepRows = dataRows.filter((row) => {
    const fecha = parseDateDMY(row[5]);
    if (!fecha) return true;
    return fecha < cutoffDate;
  });

  const deletedCount = dataRows.length - keepRows.length;

  // Convert new rows to arrays
  const newSheetRows = newRows.map((r) =>
    FIELD_KEYS.map((k) => r[k] || "")
  );

  const finalData = [header, ...keepRows, ...newSheetRows];

  // Clear sheet
  onProgress?.("Limpiando rango...");
  await sheetsAPI(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(`'${SHEET_NAME}'`)}:clear`,
    { method: "POST" }
  );

  // Write in batches of 5000 rows
  onProgress?.("Escribiendo datos...");
  const BATCH = 5000;
  for (let i = 0; i < finalData.length; i += BATCH) {
    const chunk = finalData.slice(i, i + BATCH);
    const startRow = i + 1;
    const range = encodeURIComponent(`'${SHEET_NAME}'!A${startRow}`);
    const method = i === 0 ? "PUT" : "PUT";
    await sheetsAPI(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: chunk }) }
    );
    onProgress?.(`Escribiendo... ${Math.min(i + BATCH, finalData.length)} / ${finalData.length} filas`);
  }

  return { deleted: deletedCount, written: newSheetRows.length, total: finalData.length - 1 };
}

// ─── Styles ─────────────────────────────────────────────────
const S = {
  bg: { minHeight: "100vh", background: "linear-gradient(160deg, #06090f 0%, #0c1524 40%, #0a1628 100%)", fontFamily: "'DM Sans', sans-serif", color: "#c9d5e3" },
  card: (accent = "rgba(51,65,85,0.4)") => ({
    background: "rgba(12, 20, 35, 0.7)", border: `1px solid ${accent}`,
    borderRadius: 16, padding: "24px", marginBottom: 20,
    backdropFilter: "blur(12px)",
  }),
  btn: (bg, color = "#fff", shadow) => ({
    padding: "12px 24px", borderRadius: 10, cursor: "pointer", border: "none",
    background: bg, color, fontSize: 14, fontWeight: 600,
    boxShadow: shadow || "none", transition: "all 0.2s", display: "inline-flex",
    alignItems: "center", gap: 8,
  }),
  mono: { fontFamily: "'JetBrains Mono', monospace" },
};

// ─── Component ──────────────────────────────────────────────
const STEPS = { UPLOAD: 0, PREVIEW: 1, CONFIRM: 2, SYNCING: 3, DONE: 4 };

export default function App() {
  const [step, setStep] = useState(STEPS.UPLOAD);
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [cutoffDate, setCutoffDate] = useState(formatDateISO(daysAgo(14)));
  const [cutoffMode, setCutoffMode] = useState("auto");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const stats = useMemo(() => {
    if (!rows.length) return null;
    const dates = rows.map((r) => parseDateDMY(r.fecha)).filter(Boolean);
    if (!dates.length) return null;
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    const expediciones = new Set(rows.map((r) => r.expedicion)).size;
    const clientes = new Set(
      rows.filter((r) => r.cliente && !r.cliente.includes("sin solicitud")).map((r) => r.cliente)
    ).size;
    const conSolicitud = rows.filter((r) => r.solicitud).length;
    const vacios = rows.filter((r) => r.carga === "VACIO").length;
    const cutoff = new Date(cutoffDate + "T00:00:00");
    const rowsFromCutoff = rows.filter((r) => {
      const d = parseDateDMY(r.fecha);
      return d && d >= cutoff;
    }).length;

    return { min, max, expediciones, clientes, conSolicitud, vacios, total: rows.length, rowsFromCutoff };
  }, [rows, cutoffDate]);

  const processFile = useCallback((file) => {
    setError("");
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseUploadedCSV(ev.target.result);
        if (parsed.length === 0) {
          setError("No se encontraron filas válidas. Verifica que el archivo sea CSV con separador ; y tenga al menos 13 columnas.");
          return;
        }
        setRows(parsed);
        setStep(STEPS.PREVIEW);
      } catch (err) {
        setError("Error al leer: " + err.message);
      }
    };
    reader.readAsText(file, "utf-8");
  }, []);

  const handleSync = async () => {
    if (!CLIENT_ID) {
      setError("Falta configurar CLIENT_ID de Google OAuth. Revisa la constante en App.jsx.");
      return;
    }
    setStep(STEPS.SYNCING);
    setLoading(true);
    setError("");
    try {
      const cutoff = new Date(cutoffDate + "T00:00:00");
      const rowsToWrite = rows.filter((r) => {
        const d = parseDateDMY(r.fecha);
        return d && d >= cutoff;
      });
      const res = await syncToSheet(cutoff, rowsToWrite, setProgress);
      setResult(res);
      setStep(STEPS.DONE);
    } catch (err) {
      setError("Error: " + err.message);
      setStep(STEPS.CONFIRM);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setStep(STEPS.UPLOAD);
    setRows([]);
    setFileName("");
    setResult(null);
    setError("");
    setProgress("");
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div style={S.bg}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* ─── Header ─── */}
      <header style={{
        background: "rgba(8, 14, 27, 0.85)", borderBottom: "1px solid rgba(56, 126, 245, 0.12)",
        padding: "16px 28px", display: "flex", alignItems: "center", gap: 14,
        backdropFilter: "blur(16px)", position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: "linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 19, fontWeight: 800, color: "#fff",
        }}>⇄</div>
        <div>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: "#eef2f7", letterSpacing: "-0.01em" }}>Sync Viajes</h1>
          <p style={{ margin: 0, fontSize: 12, color: "#4b6584", fontWeight: 500 }}>Transportes Bello · Sincronización de tramos</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {["Subir", "Preview", "Sync"].map((label, i) => (
            <span key={label} style={{
              padding: "5px 14px", borderRadius: 16, fontSize: 11, fontWeight: 600,
              background: step >= i ? "rgba(37, 99, 235, 0.12)" : "transparent",
              color: step >= i ? "#60a5fa" : "#334155",
              border: `1px solid ${step >= i ? "rgba(37, 99, 235, 0.25)" : "rgba(51, 65, 85, 0.3)"}`,
              transition: "all 0.3s",
            }}>{i + 1}. {label}</span>
          ))}
        </div>
      </header>

      <main style={{ maxWidth: 880, margin: "0 auto", padding: "28px 20px" }}>

        {/* Error banner */}
        {error && (
          <div style={{
            ...S.card("rgba(239, 68, 68, 0.25)"),
            display: "flex", alignItems: "center", gap: 12, color: "#fca5a5", fontSize: 14,
          }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError("")} style={{ ...S.btn("transparent", "#64748b"), padding: "4px 10px", fontSize: 18, cursor: "pointer" }}>×</button>
          </div>
        )}

        {/* ─── STEP: Upload ─── */}
        {step === STEPS.UPLOAD && (
          <div
            style={{
              ...S.card(dragOver ? "rgba(37, 99, 235, 0.5)" : "rgba(37, 99, 235, 0.15)"),
              border: `2px dashed ${dragOver ? "#3b82f6" : "rgba(37, 99, 235, 0.25)"}`,
              padding: "72px 40px", textAlign: "center", cursor: "pointer",
              transition: "all 0.3s",
            }}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false);
              processFile(e.dataTransfer.files?.[0]);
            }}
          >
            <div style={{ fontSize: 52, marginBottom: 12, filter: "grayscale(0.2)" }}>🚛</div>
            <p style={{ fontSize: 18, fontWeight: 600, color: "#e2e8f0", margin: "0 0 6px" }}>
              Arrastra o haz clic para subir el CSV de viajes
            </p>
            <p style={{ fontSize: 13, color: "#4b6584", margin: 0 }}>
              Archivo exportado del sistema de transporte · Separador punto y coma (;)
            </p>
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={(e) => processFile(e.target.files?.[0])} style={{ display: "none" }} />
          </div>
        )}

        {/* ─── STEP: Preview ─── */}
        {step === STEPS.PREVIEW && stats && (
          <>
            {/* File badge */}
            <div style={{ ...S.card(), display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10,
                background: "rgba(16, 185, 129, 0.12)", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 17, color: "#34d399",
              }}>✓</div>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{fileName}</p>
                <p style={{ margin: 0, fontSize: 12, color: "#4b6584", ...S.mono }}>
                  {fmt(stats.total)} filas · {formatDateDMY(stats.min)} → {formatDateDMY(stats.max)}
                </p>
              </div>
              <button onClick={reset} style={S.btn("rgba(30,41,59,0.6)", "#94a3b8")}>Cambiar</button>
            </div>

            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 20 }}>
              {[
                { l: "Total filas", v: fmt(stats.total), icon: "📊", c: "#93c5fd" },
                { l: "Expediciones", v: fmt(stats.expediciones), icon: "🚛", c: "#67e8f9" },
                { l: "Clientes", v: fmt(stats.clientes), icon: "🏢", c: "#a78bfa" },
                { l: "Con solicitud", v: fmt(stats.conSolicitud), icon: "📋", c: "#34d399" },
                { l: "Tramos vacío", v: fmt(stats.vacios), icon: "📭", c: "#fbbf24" },
              ].map((s) => (
                <div key={s.l} style={S.card()}>
                  <div style={{ fontSize: 11, color: "#4b6584", marginBottom: 4, fontWeight: 500 }}>{s.icon} {s.l}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: s.c, ...S.mono }}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* Cutoff */}
            <div style={S.card("rgba(37, 99, 235, 0.18)")}>
              <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600, color: "#e2e8f0" }}>📅 Fecha de corte</h3>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#64748b" }}>
                Se borrarán del Sheet las filas desde esta fecha en adelante y se reemplazarán con las del CSV.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
                {[
                  { mode: "auto", label: `Hoy − 14 días (${formatDateDMY(daysAgo(14))})`, val: formatDateISO(daysAgo(14)) },
                  { mode: "csv", label: `Inicio CSV (${formatDateDMY(stats.min)})`, val: formatDateISO(stats.min) },
                  { mode: "manual", label: "Elegir fecha", val: cutoffDate },
                ].map((opt) => (
                  <button key={opt.mode}
                    onClick={() => { setCutoffMode(opt.mode); if (opt.mode !== "manual") setCutoffDate(opt.val); }}
                    style={{
                      ...S.btn(
                        cutoffMode === opt.mode ? "rgba(37,99,235,0.2)" : "rgba(20,30,50,0.5)",
                        cutoffMode === opt.mode ? "#93c5fd" : "#4b6584"
                      ),
                      border: `1px solid ${cutoffMode === opt.mode ? "rgba(37,99,235,0.35)" : "rgba(51,65,85,0.4)"}`,
                      padding: "8px 16px", fontSize: 12,
                    }}
                  >{opt.label}</button>
                ))}
              </div>
              {cutoffMode === "manual" && (
                <input type="date" value={cutoffDate} onChange={(e) => setCutoffDate(e.target.value)}
                  style={{
                    background: "rgba(15,25,45,0.8)", border: "1px solid rgba(51,65,85,0.5)",
                    borderRadius: 8, padding: "8px 14px", color: "#e2e8f0", fontSize: 13,
                    ...S.mono, marginBottom: 14, display: "block",
                  }}
                />
              )}
              <div style={{
                padding: "10px 16px", borderRadius: 8,
                background: "rgba(37,99,235,0.06)", border: "1px solid rgba(37,99,235,0.12)",
                fontSize: 13, color: "#7ab3f5", ...S.mono,
              }}>
                Corte: <strong>{formatDateDMY(new Date(cutoffDate + "T00:00:00"))}</strong> → se
                escribirán <strong>{fmt(stats.rowsFromCutoff)}</strong> filas
              </div>
            </div>

            {/* Preview table */}
            <div style={{ ...S.card(), overflow: "hidden", padding: "20px 0" }}>
              <h3 style={{ margin: "0 0 14px", padding: "0 24px", fontSize: 15, fontWeight: 600, color: "#e2e8f0" }}>
                Vista previa <span style={{ color: "#4b6584", fontWeight: 400 }}>(primeras 30 filas)</span>
              </h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, ...S.mono }}>
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th key={c} style={{
                          padding: "8px 10px", textAlign: "left", whiteSpace: "nowrap",
                          borderBottom: "1px solid rgba(51,65,85,0.4)",
                          color: "#4b6584", fontWeight: 600, fontSize: 10,
                          textTransform: "uppercase", letterSpacing: "0.06em",
                        }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 30).map((row, i) => (
                      <tr key={i} style={{ background: i % 2 ? "rgba(15,25,45,0.3)" : "transparent" }}>
                        {FIELD_KEYS.map((k) => (
                          <td key={k} style={{
                            padding: "6px 10px", whiteSpace: "nowrap",
                            borderBottom: "1px solid rgba(30,41,59,0.3)",
                            color: row[k] === "VACIO" ? "#334155" : "#b0bfd0",
                            maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis",
                          }}>{row[k] || "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button onClick={reset} style={S.btn("rgba(30,41,59,0.6)", "#94a3b8")}>← Volver</button>
              <button onClick={() => setStep(STEPS.CONFIRM)}
                style={{
                  ...S.btn(
                    "linear-gradient(135deg, #2563eb 0%, #0284c7 100%)",
                    "#fff",
                    "0 4px 24px rgba(37,99,235,0.25)"
                  ),
                  flex: 1, justifyContent: "center", fontSize: 15, fontWeight: 700,
                }}>
                Sincronizar {fmt(stats.rowsFromCutoff)} filas →
              </button>
            </div>
          </>
        )}

        {/* ─── STEP: Confirm ─── */}
        {step === STEPS.CONFIRM && stats && (
          <div style={{ ...S.card("rgba(245, 158, 11, 0.25)"), textAlign: "center", padding: "48px 32px" }}>
            <div style={{ fontSize: 46, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ margin: "0 0 10px", fontSize: 21, fontWeight: 700, color: "#fbbf24" }}>Confirmar sincronización</h2>
            <p style={{ margin: "0 0 28px", fontSize: 14, color: "#7a8ba0", maxWidth: 460, marginInline: "auto" }}>
              Se eliminarán del Sheet las filas desde el <strong style={{ color: "#fbbf24" }}>{formatDateDMY(new Date(cutoffDate + "T00:00:00"))}</strong> en
              adelante y se reemplazarán con <strong style={{ color: "#fbbf24" }}>{fmt(stats.rowsFromCutoff)}</strong> filas del CSV.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={() => setStep(STEPS.PREVIEW)} style={S.btn("rgba(30,41,59,0.6)", "#94a3b8")}>← Volver</button>
              <button onClick={handleSync}
                style={S.btn(
                  "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)",
                  "#0f172a",
                  "0 4px 24px rgba(245,158,11,0.25)"
                )}>
                ✓ Confirmar y escribir
              </button>
            </div>
          </div>
        )}

        {/* ─── STEP: Syncing ─── */}
        {step === STEPS.SYNCING && (
          <div style={{ ...S.card("rgba(37,99,235,0.2)"), textAlign: "center", padding: "56px 32px" }}>
            <div style={{
              width: 56, height: 56, margin: "0 auto 20px",
              border: "3px solid rgba(37,99,235,0.2)", borderTopColor: "#3b82f6",
              borderRadius: "50%", animation: "spin 0.8s linear infinite",
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <h2 style={{ margin: "0 0 8px", fontSize: 19, fontWeight: 700, color: "#93c5fd" }}>Sincronizando...</h2>
            <p style={{ margin: 0, fontSize: 13, color: "#4b6584", ...S.mono }}>{progress || "Conectando con Google Sheets..."}</p>
          </div>
        )}

        {/* ─── STEP: Done ─── */}
        {step === STEPS.DONE && result && (
          <div style={{ ...S.card("rgba(16,185,129,0.25)"), textAlign: "center", padding: "48px 32px" }}>
            <div style={{ fontSize: 46, marginBottom: 12 }}>✅</div>
            <h2 style={{ margin: "0 0 24px", fontSize: 21, fontWeight: 700, color: "#34d399" }}>Sincronización completada</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, maxWidth: 460, margin: "0 auto 28px" }}>
              {[
                { l: "Eliminadas", v: fmt(result.deleted), c: "#f87171" },
                { l: "Escritas", v: fmt(result.written), c: "#34d399" },
                { l: "Total Sheet", v: fmt(result.total), c: "#93c5fd" },
              ].map((s) => (
                <div key={s.l} style={{ background: "rgba(15,25,45,0.5)", borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 11, color: "#4b6584", marginBottom: 2 }}>{s.l}</div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: s.c, ...S.mono }}>{s.v}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button onClick={reset}
                style={S.btn("linear-gradient(135deg, #2563eb 0%, #0284c7 100%)", "#fff", "0 4px 24px rgba(37,99,235,0.2)")}>
                ↻ Nueva sincronización
              </button>
              <a href={`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`} target="_blank" rel="noopener noreferrer"
                style={{ ...S.btn("rgba(30,41,59,0.6)", "#94a3b8"), textDecoration: "none" }}>
                Abrir Sheet ↗
              </a>
            </div>
          </div>
        )}

        {/* Config notice */}
        {!CLIENT_ID && (
          <div style={{
            marginTop: 28, padding: "14px 20px", borderRadius: 10, fontSize: 13,
            background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", color: "#d4a017",
          }}>
            ⚙️ <strong>Configuración pendiente:</strong> Agrega tu Google OAuth Client ID en la constante{" "}
            <code style={{ ...S.mono, background: "rgba(0,0,0,0.3)", padding: "1px 6px", borderRadius: 4, fontSize: 12 }}>CLIENT_ID</code>{" "}
            en <code style={{ ...S.mono, background: "rgba(0,0,0,0.3)", padding: "1px 6px", borderRadius: 4, fontSize: 12 }}>src/App.jsx</code>.
            Puedes reutilizar el mismo de sync-ventas.
          </div>
        )}
      </main>
    </div>
  );
}
