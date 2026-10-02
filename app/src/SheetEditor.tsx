import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreRuRU from "@univerjs/preset-sheets-core/locales/ru-RU";
import "@univerjs/preset-sheets-core/lib/index.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// .xlsx (SheetJS) → Univer IWorkbookData, с формулами
function bytesToUniver(bytes: Uint8Array): Any {
  const wb = XLSX.read(bytes, { type: "array", cellFormula: true });
  const sheets: Any = {};
  const sheetOrder: string[] = [];
  wb.SheetNames.forEach((nm, idx) => {
    const ws = wb.Sheets[nm];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const cellData: Any = {};
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        (cellData[r] ||= {});
        cellData[r][c] = cell.f ? { f: "=" + cell.f } : { v: cell.v };
      }
    }
    const id = "sheet_" + idx;
    sheets[id] = { id, name: nm, cellData, rowCount: Math.max(range.e.r + 1, 50), columnCount: Math.max(range.e.c + 1, 20) };
    sheetOrder.push(id);
  });
  if (!sheetOrder.length) { sheets["s0"] = { id: "s0", name: "Лист1", cellData: {}, rowCount: 50, columnCount: 20 }; sheetOrder.push("s0"); }
  return { id: "wb_" + Date.now(), name: "Таблица", sheetOrder, sheets };
}

// Univer snapshot → .xlsx, с формулами
function univerToBytes(snap: Any): Uint8Array {
  const wb = XLSX.utils.book_new();
  (snap.sheetOrder || Object.keys(snap.sheets || {})).forEach((sid: string) => {
    const s = snap.sheets[sid];
    if (!s) return;
    const ws: Any = {};
    let maxR = 0, maxC = 0;
    const cd = s.cellData || {};
    Object.keys(cd).forEach((rk) => {
      const r = +rk;
      Object.keys(cd[rk]).forEach((ck) => {
        const c = +ck;
        const cell = cd[rk][ck];
        if (cell == null) return;
        const addr = XLSX.utils.encode_cell({ r, c });
        if (cell.f) ws[addr] = { t: "n", f: String(cell.f).replace(/^=/, "") };
        else if (cell.v != null && cell.v !== "") ws[addr] = typeof cell.v === "number" ? { t: "n", v: cell.v } : { t: "s", v: String(cell.v) };
        else return;
        maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
      });
    });
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    XLSX.utils.book_append_sheet(wb, ws, (s.name || "Лист").slice(0, 31));
  });
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export function SheetEditor({ initial, name, saving, onSave, onDownload, onOpenNative, onClose }: { initial?: Uint8Array | null; name: string; saving: boolean; onSave: (bytes: Uint8Array, name: string) => void; onDownload?: (bytes: Uint8Array, name: string) => void; onOpenNative?: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Any>(null);
  const apiRef = useRef<Any>(null);
  const dirty = useRef(false);
  const [fname, setFname] = useState(name || "Таблица.xlsx");
  const [error, setError] = useState("");
  const [ask, setAsk] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    let data: Any;
    try { data = initial && initial.length ? bytesToUniver(initial) : { id: "wb", name: "Таблица", sheetOrder: ["s0"], sheets: { s0: { id: "s0", name: "Лист1", cellData: {}, rowCount: 50, columnCount: 20 } } }; }
    catch { setError("Файл не читается — возможно, защищён паролем. Его можно открыть в программе."); return; }
    try {
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.RU_RU,
        locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetSheetsCoreRuRU) },
        presets: [UniverSheetsCorePreset({ container: ref.current })],
      });
      univerRef.current = univer;
      apiRef.current = univerAPI;
      univerAPI.createWorkbook(data);
    } catch (e) { console.error(e); setError("Не удалось открыть редактор таблиц."); }
    const el = ref.current;
    const mark = (e: KeyboardEvent) => { if (e.key.length === 1 || ["Enter", "Backspace", "Delete", "Tab"].includes(e.key)) dirty.current = true; };
    const markPaste = () => { dirty.current = true; };
    el.addEventListener("keydown", mark, true);
    el.addEventListener("paste", markPaste, true);
    return () => { el?.removeEventListener("keydown", mark, true); el?.removeEventListener("paste", markPaste, true); try { univerRef.current?.dispose(); } catch { /* */ } univerRef.current = null; apiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildBytes = (): Uint8Array => {
    const wb = apiRef.current?.getActiveWorkbook?.();
    const snap = wb?.save ? wb.save() : null;
    return snap ? univerToBytes(snap) : new Uint8Array();
  };
  const finalName = () => (/\.(xlsx|xls|csv)$/i.test(fname) ? fname.replace(/\.(xls|csv)$/i, ".xlsx") : fname + ".xlsx");
  const doClose = () => { if (dirty.current && !error) setAsk(true); else onClose(); };
  const topBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
        </span>
        <input value={fname} onChange={(e) => setFname(e.target.value)} style={{ width: 260, padding: "8px 11px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 14, outline: "none" }} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 9 }}>
          {onOpenNative && <button onClick={onOpenNative} style={{ ...topBtn, background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)" }}>Открыть в программе</button>}
          {!error && onDownload && <button onClick={() => onDownload(buildBytes(), finalName())} style={{ ...topBtn, background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)" }}>Скачать</button>}
          <button onClick={doClose} disabled={saving} style={{ ...topBtn, background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)" }}>Закрыть</button>
          {!error && <button onClick={() => { dirty.current = false; onSave(buildBytes(), finalName()); }} disabled={saving} style={{ ...topBtn, display: "inline-flex", alignItems: "center", gap: 8, background: "var(--accent)", color: "#fff", border: "none", opacity: saving ? 0.7 : 1 }}>{saving ? <><span className="spinner spinner--on-accent" /> Сохраняю…</> : "Сохранить"}</button>}
        </div>
      </div>
      {error ? (
        <div style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ textAlign: "center", maxWidth: 420 }}>
            <div style={{ width: 48, height: 48, borderRadius: 13, margin: "0 auto 14px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--warn-bg)", color: "var(--amber)" }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg></div>
            <div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)", marginBottom: 6 }}>Не удалось открыть</div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 16 }}>{error}</div>
            {onOpenNative && <button onClick={onOpenNative} style={{ ...topBtn, background: "var(--accent)", color: "#fff", border: "none" }}>Открыть в программе</button>}
          </div>
        </div>
      ) : (
        <div style={{ flexGrow: 1, overflow: "hidden", position: "relative" }}><div ref={ref} style={{ width: "100%", height: "100%" }} /></div>
      )}

      {ask && (
        <>
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.42)", zIndex: 401 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 402, width: 400, maxWidth: "92vw", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "var(--shadow)", padding: 22 }}>
            <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>Сохранить изменения?</div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 20 }}>В таблице есть несохранённые изменения.</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid var(--border)", background: "transparent", color: "var(--text-2)", fontWeight: 600, fontSize: 13 }} onClick={() => { setAsk(false); onClose(); }}>Не сохранять</button>
              <button style={{ padding: "9px 14px", borderRadius: 9, border: "1px solid var(--border)", background: "transparent", color: "var(--text-2)", fontWeight: 600, fontSize: 13 }} onClick={() => setAsk(false)}>Отмена</button>
              <button style={{ padding: "9px 16px", borderRadius: 9, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: 13 }} onClick={() => { setAsk(false); dirty.current = false; onSave(buildBytes(), finalName()); }}>Сохранить</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
