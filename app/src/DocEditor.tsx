import { useEffect, useRef, useState } from "react";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreRuRU from "@univerjs/preset-docs-core/locales/ru-RU";
import "@univerjs/preset-docs-core/lib/index.css";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const EMPTY_DOC: Any = {
  id: "doc_" + Date.now(),
  body: { dataStream: "\r\n", textRuns: [], paragraphs: [{ startIndex: 0, paragraphStyle: {} }], sectionBreaks: [{ startIndex: 1 }] },
  documentStyle: { pageSize: { width: 816, height: 1056 }, marginTop: 72, marginBottom: 72, marginLeft: 90, marginRight: 90, renderConfig: { vertexAngle: 0, centerAngle: 0 } },
};

export function DocEditor({ initial, name, saving, onSave, onClose }: { initial?: string | null; name: string; saving: boolean; onSave: (bytes: Uint8Array, name: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Any>(null);
  const apiRef = useRef<Any>(null);
  const dirty = useRef(false);
  const [fname, setFname] = useState(name || "Документ.svdoc");
  const [error, setError] = useState("");
  const [ask, setAsk] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    let data: Any = EMPTY_DOC;
    if (initial) { try { data = JSON.parse(initial); } catch { data = EMPTY_DOC; } }
    try {
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.RU_RU,
        locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU) },
        presets: [UniverDocsCorePreset({ container: ref.current })],
      });
      univerRef.current = univer; apiRef.current = univerAPI;
      univerAPI.createDocument(data);
    } catch (e) { console.error(e); setError("Не удалось открыть редактор документов."); }
    const el = ref.current;
    const mark = (e: KeyboardEvent) => { if (e.key.length === 1 || ["Enter", "Backspace", "Delete", "Tab"].includes(e.key)) dirty.current = true; };
    const markPaste = () => { dirty.current = true; };
    el.addEventListener("keydown", mark, true);
    el.addEventListener("paste", markPaste, true);
    return () => { el?.removeEventListener("keydown", mark, true); el?.removeEventListener("paste", markPaste, true); try { univerRef.current?.dispose(); } catch { /* */ } univerRef.current = null; apiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snapshot = (): Any => { const d = apiRef.current?.getActiveDocument?.(); return d?.save ? d.save() : null; };
  const buildBytes = (): Uint8Array => new TextEncoder().encode(JSON.stringify(snapshot() || EMPTY_DOC));
  const finalName = () => (/\.svdoc$/i.test(fname) ? fname : fname.replace(/\.(docx|doc|txt)$/i, "") + ".svdoc");
  const doClose = () => { if (dirty.current) setAsk(true); else onClose(); };
  const topBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
        </span>
        <input value={fname} onChange={(e) => setFname(e.target.value)} style={{ width: 260, padding: "8px 11px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 14, outline: "none" }} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 9 }}>
          <button onClick={doClose} disabled={saving} style={{ ...topBtn, background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)" }}>Закрыть</button>
          {!error && <button onClick={() => { dirty.current = false; onSave(buildBytes(), finalName()); }} disabled={saving} style={{ ...topBtn, display: "inline-flex", alignItems: "center", gap: 8, background: "var(--accent)", color: "#fff", border: "none", opacity: saving ? 0.7 : 1 }}>{saving ? <><span className="spinner spinner--on-accent" /> Сохраняю…</> : "Сохранить"}</button>}
        </div>
      </div>
      {error ? (
        <div style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ fontSize: 13.5, color: "var(--muted)", textAlign: "center", maxWidth: 400 }}>{error}</div>
        </div>
      ) : (
        <div style={{ flexGrow: 1, overflow: "hidden", position: "relative" }}><div ref={ref} style={{ width: "100%", height: "100%" }} /></div>
      )}

      {ask && (
        <>
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.42)", zIndex: 401 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 402, width: 400, maxWidth: "92vw", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "var(--shadow)", padding: 22 }}>
            <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>Сохранить изменения?</div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 20 }}>В документе есть несохранённые изменения.</div>
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
