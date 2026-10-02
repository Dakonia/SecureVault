import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Rec = { id: string; type?: string; by?: string; name?: string; size: number; at: string };

const box: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--border)",
  borderRadius: 16, padding: "20px 22px",
};
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", marginTop: 6, padding: "11px 12px",
  background: "var(--surface-2)", border: "1px solid var(--border)",
  borderRadius: 10, color: "var(--text)", fontSize: 14, outline: "none",
};
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--muted)" };
const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8, padding: "12px 18px",
  background: "var(--accent)", color: "#fff", border: "none", borderRadius: 11,
  fontWeight: 700, fontSize: 14,
};
const ghost: React.CSSProperties = {
  padding: "8px 13px", background: "transparent", border: "1px solid var(--border)",
  color: "var(--text-2)", borderRadius: 8, fontSize: 12, fontWeight: 600,
};

export default function DirectorLive() {
  const [kind, setKind] = useState("Отчёт недели");
  const [name, setName] = useState("otchet.txt");
  const [content, setContent] = useState("Выручка: 812000\nФудкост: 31%\nФОТ: 24%");
  const [rows, setRows] = useState<Rec[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    try { setRows(await invoke<Rec[]>("sv_list", { space: "resto-7" })); }
    catch (e) { setStatus("Ошибка списка: " + String(e)); }
  };
  useEffect(() => { load(); }, []);

  const submit = async () => {
    setBusy(true); setStatus("Шифрую и отправляю…");
    try {
      const id = await invoke<string>("sv_submit", { space: "resto-7", kind, author: "Директор №7", name, content });
      setStatus("Отправлено ✓  (id " + id.slice(0, 8) + "…)");
      await load();
    } catch (e) { setStatus("Ошибка: " + String(e)); }
    setBusy(false);
  };

  const open = async (r: Rec) => {
    setStatus("Скачиваю и расшифровываю…");
    try {
      const text = await invoke<string>("sv_open", { id: r.id });
      setOpened({ name: r.name || r.id, text });
      setStatus("");
    } catch (e) { setStatus("Ошибка открытия: " + String(e)); }
  };

  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString("ru-RU"); } catch { return iso; } };

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24, background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "var(--text)" }}>Ресторан №7 — Гороховая</h1>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, color: "var(--accent-2)", background: "var(--accent-tint)", padding: "4px 10px", borderRadius: 20 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          шифруется на этом устройстве · живой сервер
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 18 }}>
        <div style={box}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: "var(--text)" }}>Сдать документ</div>
          <label style={lbl}>Тип</label>
          <select style={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option>Отчёт недели</option><option>Зарплаты</option><option>Аванс</option><option>Скан · расписка</option>
          </select>
          <div style={{ height: 12 }} />
          <label style={lbl}>Имя файла</label>
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ height: 12 }} />
          <label style={lbl}>Содержимое</label>
          <textarea style={{ ...input, minHeight: 92, resize: "vertical", fontFamily: "ui-monospace, monospace" }} value={content} onChange={(e) => setContent(e.target.value)} />
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <button style={{ ...btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              Зашифровать и отправить
            </button>
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{status}</span>
          </div>
        </div>

        <div style={box}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>История</div>
            <button style={{ ...ghost, marginLeft: "auto" }} onClick={load}>Обновить</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={{ textAlign: "left", fontSize: 11, color: "var(--muted-2)", fontWeight: 600, padding: "6px 0" }}>Тип</th>
              <th style={{ textAlign: "left", fontSize: 11, color: "var(--muted-2)", fontWeight: 600, padding: "6px 0" }}>Файл</th>
              <th style={{ textAlign: "left", fontSize: 11, color: "var(--muted-2)", fontWeight: 600, padding: "6px 0" }}>Когда</th>
              <th style={{ textAlign: "right", fontSize: 11, color: "var(--muted-2)", fontWeight: 600, padding: "6px 0" }}></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} style={{ padding: "14px 0", color: "var(--muted)", fontSize: 13 }}>Пока пусто</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: "10px 0", borderTop: "1px solid var(--border-2)", fontSize: 12.5, color: "var(--text-2)" }}>{r.type || "—"}</td>
                  <td style={{ borderTop: "1px solid var(--border-2)", fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{r.name || r.id.slice(0, 8)}</td>
                  <td style={{ borderTop: "1px solid var(--border-2)", fontSize: 12, color: "var(--muted)", fontFamily: "ui-monospace, monospace" }}>{fmt(r.at)}</td>
                  <td style={{ borderTop: "1px solid var(--border-2)", textAlign: "right" }}><button style={ghost} onClick={() => open(r)}>Открыть</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {opened && (
        <div onClick={() => setOpened(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...box, width: 520, maxWidth: "90%" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{opened.name}</div>
              <span style={{ marginLeft: 10, fontSize: 11, color: "var(--green)", fontWeight: 600 }}>расшифровано на вашем устройстве</span>
              <button style={{ ...ghost, marginLeft: "auto" }} onClick={() => setOpened(null)}>Закрыть</button>
            </div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: 13, color: "var(--text)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>{opened.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
