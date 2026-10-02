import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

const ext = (n: string) => (n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "");
const toArrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export function FileViewer({ bytes, name, saving, onDownload, onOpenNative, onClose }: { bytes: Uint8Array; name: string; saving: boolean; onDownload?: () => void; onOpenNative?: () => void; onClose: () => void }) {
  const e = ext(name);
  const isDocx = e === "docx";
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const docxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let revoke: string | null = null;
    (async () => {
      try {
        if (e === "pdf") { const u = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: "application/pdf" })); revoke = u; setUrl(u); }
        else if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(e)) { const u = URL.createObjectURL(new Blob([toArrayBuffer(bytes)])); revoke = u; setUrl(u); }
        else if (["txt", "csv", "md", "log", "json", "xml"].includes(e)) { setText(new TextDecoder().decode(bytes)); }
        else if (isDocx) {
          const host = docxRef.current;
          if (!host) { setErr("Не удалось подготовить просмотр."); setLoading(false); return; }
          host.innerHTML = "";
          await renderAsync(new Blob([toArrayBuffer(bytes)]), host, undefined, {
            className: "docx",
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            breakPages: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            experimental: true,
            useBase64URL: true,
          });
        }
        else setErr("Предпросмотр для этого типа не поддерживается. Можно скачать.");
      } catch { setErr("Не удалось показать файл — возможно, он защищён, повреждён или в старом формате .doc. Откройте в программе или скачайте."); }
      setLoading(false);
    })();
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const topBtn: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, fontSize: 13.5, fontWeight: 600, cursor: "pointer" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
        </span>
        <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{name}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 9 }}>
          {onOpenNative && <button onClick={onOpenNative} style={{ ...topBtn, background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)" }}>Открыть в программе</button>}
          {onDownload && <button onClick={onDownload} disabled={saving} style={{ ...topBtn, display: "inline-flex", alignItems: "center", gap: 8, background: "var(--accent)", color: "#fff", border: "none", opacity: saving ? 0.7 : 1 }}>{saving ? <><span className="spinner spinner--on-accent" /> Сохраняю…</> : "Скачать"}</button>}
          <button onClick={onClose} style={{ ...topBtn, background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)" }}>Закрыть</button>
        </div>
      </div>
      <div style={{ flexGrow: 1, overflow: "auto", position: "relative", display: "flex", justifyContent: "center", background: isDocx ? "#525659" : "var(--surface-2)" }}>
        {/* docx-хост монтируется всегда, чтобы рендерер получил контейнер */}
        <div ref={docxRef} className="docx-host" style={{ width: "100%", display: isDocx && !err && !loading ? "block" : "none", padding: "24px 0" }} />
        {loading ? <div style={{ margin: "auto", display: "flex", alignItems: "center", gap: 10, color: "var(--muted)", fontSize: 14, fontWeight: 600 }}><span className="spinner spinner--lg" /> Открываю…</div>
          : err ? <div style={{ margin: "auto", textAlign: "center", color: "var(--muted)", fontSize: 13.5, maxWidth: 400, padding: 24, background: "var(--surface-2)", borderRadius: 12, alignSelf: "center" }}>{err}</div>
            : url && e === "pdf" ? <iframe src={url} title={name} style={{ width: "100%", height: "100%", border: "none" }} />
              : url ? <img src={url} alt={name} style={{ maxWidth: "100%", height: "auto", margin: "auto", padding: 20 }} />
                : text != null ? <pre style={{ width: "100%", maxWidth: 820, margin: "0 auto", padding: 28, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace", fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>{text}</pre>
                  : null}
      </div>
    </div>
  );
}
