import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import logoWhite from "./assets/logo-dark.png";
import { SheetEditor } from "./SheetEditor";
import { DocEditor } from "./DocEditor";
import { FileViewer } from "./FileViewer";

export type Profile = { name: string; role: string; method: string; age_public: string; cert_serial: string; revoked: boolean };
export type License = { org: string; kind: string; exp: number; valid: boolean; reason: string };
export type RoleDef = { key: string; name: string; perms: string[] };
export type MasterInfo = { org: string; login: string; server: string; role: string; profiles: Profile[]; roles: RoleDef[]; orgs: string[]; me_name: string; me_company: string; perms: string[]; license: License | null };
export const hasPerm = (info: MasterInfo, k: string) => (info.perms || []).includes(k);

// каталог прав (ключ → подпись), сгруппирован. Управление профилями/ролями/организацией — только у мастера, здесь не выдаётся.
const PERMS: { group: string; items: { key: string; label: string }[] }[] = [
  { group: "Данные", items: [
    { key: "submit", label: "Сдавать отчёты" },
    { key: "view_own", label: "Видеть свои данные" },
    { key: "view_all", label: "Видеть все данные" },
    { key: "edit", label: "Редактировать" },
    { key: "delete", label: "Удалять и отзывать" },
  ] },
  { group: "Общение", items: [
    { key: "comments", label: "Комментарии" },
    { key: "chat", label: "Чат" },
  ] },
  { group: "Прочее", items: [
    { key: "view_log", label: "Видеть журнал" },
    { key: "export", label: "Экспорт данных" },
  ] },
];

const box: React.CSSProperties = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 13, padding: "20px 22px" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 6, padding: "11px 13px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 14.5, outline: "none" };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 560, color: "var(--muted)", letterSpacing: ".01em" };
const btn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px 18px", background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 9, fontWeight: 600, fontSize: 14 };
const ghost: React.CSSProperties = { padding: "9px 13px", background: "transparent", border: "1px solid var(--border)", color: "var(--text-2)", borderRadius: 8, fontSize: 13, fontWeight: 560, cursor: "pointer" };
const h1s: React.CSSProperties = { margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: "-0.015em", color: "var(--text)" };

function licText(l: License | null): string {
  if (!l) return "—";
  const kind = l.kind === "perpetual" ? "бессрочная" : "подписка";
  if (l.exp && l.kind !== "perpetual") {
    const d = new Date(l.exp * 1000).toLocaleDateString("ru-RU");
    return `${kind} до ${d}` + (l.valid ? "" : " · истекла");
  }
  return kind;
}

// Двухпанельная оболочка для входа/активации: бренд слева, форма справа (десктоп-вид, без «одинокой карточки»)
export function AuthShell({ children, maxWidth = 408 }: { children: React.ReactNode; maxWidth?: number }) {
  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg)" }}>
      <div style={{ width: "40%", maxWidth: 520, minWidth: 320, flexShrink: 0, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", padding: 42, background: "linear-gradient(165deg, #20214f 0%, #11122a 55%, #0A0B0E 100%)" }}>
        <div style={{ position: "absolute", top: -140, right: -90, width: 440, height: 440, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(94,106,210,0.55), transparent)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", bottom: -120, left: -80, width: 320, height: 320, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(94,106,210,0.22), transparent)", pointerEvents: "none" }} />
        <img src={logoWhite} alt="SecureVault" style={{ width: 230, height: "auto", position: "relative" }} />
      </div>
      <div style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32, overflow: "auto" }}>
        <div style={{ width: "100%", maxWidth }}>{children}</div>
      </div>
    </div>
  );
}

// кастомный выпадающий список (не браузерный select)
function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  return (
    <div style={{ position: "relative", marginTop: 6 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} onBlur={() => setTimeout(() => setOpen(false), 130)}
        style={{ ...input, marginTop: 0, display: "flex", alignItems: "center", textAlign: "left", cursor: "pointer" }}>
        <span style={{ flexGrow: 1, color: cur ? "var(--text)" : "var(--muted)" }}>{cur?.label || "Выберите…"}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 30, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 11, boxShadow: "var(--shadow)", padding: 5, maxHeight: 260, overflow: "auto" }}>
          {options.map((o) => (
            <button key={o.value} type="button" onMouseDown={() => { onChange(o.value); setOpen(false); }}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "10px 11px", borderRadius: 8, border: "none", background: o.value === value ? "var(--accent-tint)" : "transparent", color: o.value === value ? "var(--accent-2)" : "var(--text)", fontSize: 14, fontWeight: o.value === value ? 700 : 500 }}>
              <span style={{ flexGrow: 1 }}>{o.label}</span>
              {o.value === value && <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Check({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "9px 10px", borderRadius: 9, border: "1px solid " + (on ? "var(--accent)" : "var(--border)"), background: on ? "var(--accent-tint)" : "transparent", color: "var(--text)", fontSize: 13.5, fontWeight: 500 }}>
      <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: on ? "var(--accent)" : "transparent", border: "1.5px solid " + (on ? "var(--accent)" : "var(--muted-2)") }}>
        {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
      </span>
      {label}
    </button>
  );
}

type Draft = { org: string; login: string; role: string };
type ServerCheck = { ok: boolean; service: string; version: string; license_used: boolean; login_taken: boolean };

function Stepper({ step }: { step: number }) {
  const items = ["Аккаунт", "Где хранить", "Сервер"];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
      {items.map((t, i) => (
        <div key={t} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, opacity: i <= step ? 1 : 0.45 }}>
            <span style={{ width: 22, height: 22, borderRadius: 11, fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", background: i < step ? "var(--green)" : i === step ? "var(--accent)" : "var(--surface-2)", color: i <= step ? "#fff" : "var(--muted)" }}>{i < step ? "✓" : i + 1}</span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: i === step ? "var(--text)" : "var(--muted)" }}>{t}</span>
          </div>
          {i < items.length - 1 && <span style={{ width: 22, height: 1, background: "var(--border)" }} />}
        </div>
      ))}
    </div>
  );
}

export function MasterActivate({ onDone, onExit }: { onDone: (i: MasterInfo, pw: string) => void; onExit: () => void }) {
  const [step, setStep] = useState(0);
  // шаг 1
  const [org, setOrg] = useState("");
  const [license, setLicense] = useState("");
  const [licInfo, setLicInfo] = useState<License | null>(null);
  const [licUsed, setLicUsed] = useState(false);
  const [licErr, setLicErr] = useState("");
  const [checking, setChecking] = useState(false);
  const [login, setLogin] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  // шаг 3
  const [server, setServer] = useState("");
  const [srv, setSrv] = useState<ServerCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const checkLicense = async (code: string) => {
    if (!code.trim()) { setLicInfo(null); setLicErr(""); setLicUsed(false); return; }
    setChecking(true); setStatus("");
    try {
      const s = await invoke<License & { used: boolean; used_known: boolean }>("sv_license_status", { code });
      setLicInfo({ org: s.org, kind: s.kind, exp: s.exp, valid: s.valid, reason: s.reason });
      setLicUsed(s.used_known && s.used);
      setLicErr("");
    } catch (e) { setLicInfo(null); setLicUsed(false); setLicErr(String(e).replace(/^Error:\s*/, "")); }
    setChecking(false);
  };
  const licenseOk = !!licInfo && licInfo.valid && !licUsed;
  const prepare = async () => {
    if (!org.trim()) { setStatus("Укажите название организации"); return; }
    if (!login.trim()) { setStatus("Укажите логин"); return; }
    if (pw.length < 6) { setStatus("Пароль не короче 6 символов"); return; }
    if (pw !== pw2) { setStatus("Пароли не совпадают"); return; }
    setBusy(true); setStatus("Создаю ключи локально…");
    try {
      const d = await invoke<Draft>("sv_prepare_master", { licenseCode: license, org, login, password: pw });
      setDraft(d); setStatus(""); setStep(1);
    } catch (e) { setStatus("" + String(e)); }
    setBusy(false);
  };
  const checkServer = async () => {
    setBusy(true); setStatus(""); setSrv(null);
    try { setSrv(await invoke<ServerCheck>("sv_check_server", { server })); }
    catch (e) { setStatus("" + String(e)); }
    setBusy(false);
  };
  const finish = async () => {
    setBusy(true); setStatus("Загружаю аккаунт на сервер…");
    try {
      const info = await invoke<MasterInfo>("sv_finish_master", { server });
      onDone(info, pw);
    } catch (e) { setStatus("" + String(e)); setBusy(false); }
  };

  const cmd = "curl -fsSL https://get.securevault.app/install.sh | sudo bash";

  return (
    <AuthShell maxWidth={468}>
      <div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".1em", color: "var(--accent-2)" }}>СОЗДАНИЕ ОРГАНИЗАЦИИ</div>
          <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.015em", color: "var(--text)", marginTop: 3 }}>{step === 0 ? "Мастер-аккаунт" : step === 1 ? "Где хранить данные" : "Свой сервер"}</div>
        </div>

        <Stepper step={step} />

        {step === 0 && <>
          <label style={lbl}>Код лицензии</label>
          <div style={{ position: "relative" }}>
            <input style={input} value={license} onChange={(e) => { setLicense(e.target.value); checkLicense(e.target.value); }} placeholder="вставьте код лицензии…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {checking && <span className="spinner" style={{ position: "absolute", right: 12, top: 18 }} />}
          </div>
          {licErr && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: "var(--danger)" }}>✗ {licErr}</div>}
          {licInfo && !licErr && licUsed && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: "var(--danger)" }}>✗ Этот код уже активирован — развернуть повторно нельзя.</div>}
          {licInfo && !licErr && !licUsed && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: licInfo.valid ? "var(--green)" : "var(--danger)" }}>{licInfo.valid ? "✓ Ключ действителен · " + licText(licInfo) : "✗ " + (licInfo.reason || "недействителен")}</div>}

          <div style={{ marginTop: 16 }}>
            <label style={lbl}>Название организации</label>
            <input style={input} value={org} onChange={(e) => setOrg(e.target.value)} placeholder="напр. Моя компания" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
            <div><label style={lbl}>Логин мастера</label><input style={input} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="напр. master" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
            <div><label style={lbl}>Пароль</label><input style={input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          </div>
          <div style={{ marginTop: 12 }}><label style={lbl}>Повторите пароль</label><input style={input} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
          <div style={{ display: "flex", gap: 9, background: "var(--warn-bg)", border: "1px solid var(--amber)", borderRadius: 11, padding: "11px 13px", margin: "16px 0" }}>
            <span style={{ color: "var(--amber)", fontSize: 12, lineHeight: 1.5 }}><b>Запомните пароль.</b> Аккаунт шифруется им — без пароля его не открыть даже нам. Сейчас всё создаётся только на этом компьютере; загрузим на сервер на последнем шаге.</span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button style={{ ...btn, minWidth: 200, opacity: busy || !licenseOk ? 0.5 : 1 }} disabled={busy || !licenseOk} onClick={prepare}>{busy ? <><span className="spinner spinner--on-accent" /> Создаю…</> : "Далее →"}</button>
            <button style={ghost} onClick={onExit} disabled={busy}>Отмена</button>
          </div>
        </>}

        {step === 1 && <>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>Аккаунт <b style={{ color: "var(--text-2)" }}>{draft?.org}</b> создан локально. Теперь выберите, где будут храниться зашифрованные данные.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: "18px 16px", opacity: 0.55, position: "relative", background: "var(--surface-2)" }}>
              <span style={{ position: "absolute", top: 12, right: 12, fontSize: 10, fontWeight: 800, letterSpacing: ".05em", color: "var(--muted)", background: "var(--surface)", padding: "3px 7px", borderRadius: 6 }}>СКОРО</span>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginTop: 10 }}>Наше облако</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>Хостинг на нашей стороне. Мы всё равно не видим ваши данные. Будет доступно позже.</div>
            </div>
            <button type="button" className="choice" onClick={() => setStep(2)} style={{ textAlign: "left", border: "1px solid var(--accent)", background: "var(--accent-tint)", borderRadius: 14, padding: "18px 16px" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginTop: 10 }}>Свой сервер</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>Данные на вашем сервере. Полный контроль. Нужен сервер с доступом из интернета.</div>
            </button>
          </div>
          <div style={{ marginTop: 18 }}><button style={ghost} onClick={onExit}>Отмена</button></div>
        </>}

        {step === 2 && <>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>1. Установите сервер SecureVault</div>
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.55 }}>Нужен отдельный сервер на Linux (Debian/Ubuntu), <b style={{ color: "var(--text-2)" }}>доступный из интернета</b> — публичный IP или домен. Выполните на нём команду:</div>
          <div className="codebox">
            <code>{cmd}</code>
            <button className="pressable" onClick={() => navigator.clipboard?.writeText(cmd)} style={{ ...ghost, padding: "6px 10px", fontSize: 12 }}>Копировать</button>
          </div>
          <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--muted-2)", marginBottom: 14, alignItems: "center" }}>
            <span>Linux</span><span style={{ opacity: 0.5 }}>· Windows (скоро)</span><span style={{ opacity: 0.5 }}>· macOS (скоро)</span>
            <span style={{ marginLeft: "auto", fontStyle: "italic" }}>установщик публикуется к релизу</span>
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>2. Укажите адрес сервера</div>
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginBottom: 2 }}>Адрес установщик покажет в конце (напр. <span className="mono">https://ваш-домен:8088</span>).</div>
          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <input style={{ ...input, marginTop: 0 }} value={server} onChange={(e) => { setServer(e.target.value); setSrv(null); }} placeholder="https://..." autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button style={{ ...btn, background: "var(--accent-tint)", color: "var(--accent-2)", border: "1px solid var(--accent)", minWidth: 120 }} disabled={busy || !server} onClick={checkServer}>{busy && !srv ? <span className="spinner" /> : "Проверить"}</button>
          </div>
          {srv && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: "var(--green)" }}>✓ Сервер SecureVault отвечает · версия {srv.version}</div>}
          {srv && srv.license_used && <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 600, color: "var(--danger)" }}>✗ Эта лицензия уже использована на этом сервере — создать организацию повторно нельзя.</div>}
          {srv && srv.login_taken && <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 600, color: "var(--danger)" }}>✗ Логин «{draft?.login}» на этом сервере уже занят — вернитесь назад и смените его.</div>}

          <div style={{ display: "flex", gap: 9, background: "var(--warn-bg)", border: "1px solid var(--amber)", borderRadius: 11, padding: "11px 13px", margin: "16px 0" }}>
            <span style={{ color: "var(--amber)", fontSize: 12, lineHeight: 1.5 }}>После завершения лицензия будет <b>использована</b> (одноразовая). Аккаунт загрузится на сервер зашифрованным — вход станет возможен с любого устройства.</span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button style={{ ...btn, minWidth: 220, opacity: !srv || srv.license_used || srv.login_taken || busy ? 0.5 : 1 }} disabled={!srv || srv.license_used || srv.login_taken || busy} onClick={finish}>{busy && srv ? <><span className="spinner spinner--on-accent" /> Загружаю…</> : "Завершить настройку"}</button>
            <button style={ghost} onClick={() => setStep(1)} disabled={busy}>← Назад</button>
          </div>
        </>}

        {status && <div style={{ marginTop: 12, fontSize: 12.5, color: status.includes("…") ? "var(--muted)" : "var(--danger)" }}>{status}</div>}
      </div>
    </AuthShell>
  );
}

type Row = { login: string; role: string; org: string; created_at: string; revoked: boolean };

function genPassword(len = 14): string {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => cs[x % cs.length]).join("");
}

function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 200, animation: "fadeIn .15s ease" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 440, maxWidth: "92vw", background: "var(--surface)", borderLeft: "1px solid var(--border)", boxShadow: "-24px 0 60px rgba(0,0,0,0.28)", zIndex: 201, display: "flex", flexDirection: "column", animation: "slideIn .2s ease" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "17px 22px", borderBottom: "1px solid var(--border-2)" }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, letterSpacing: "-0.01em", color: "var(--text)" }}>{title}</div>
          <button onClick={onClose} aria-label="Закрыть" style={{ marginLeft: "auto", width: 30, height: 30, borderRadius: 8, background: "transparent", border: "1px solid var(--border)", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ padding: 22, overflow: "auto" }}>{children}</div>
      </div>
    </>
  );
}

function ConfirmModal({ data, onClose }: { data: { title: string; text: string; danger?: boolean; onYes: () => void } | null; onClose: () => void }) {
  if (!data) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.42)", zIndex: 400, animation: "fadeIn .12s ease" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 401, width: 390, maxWidth: "92vw", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "var(--shadow)", padding: 22 }}>
        <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>{data.title}</div>
        <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, marginBottom: 20 }}>{data.text}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={ghost} onClick={onClose}>Отмена</button>
          <button style={{ ...btn, background: data.danger ? "var(--danger)" : "var(--accent)" }} onClick={() => { const y = data.onYes; onClose(); y(); }}>{data.danger ? "Удалить" : "Да"}</button>
        </div>
      </div>
    </>
  );
}

function Toast({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 500, background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", padding: "11px 18px", borderRadius: 10, fontSize: 13.5, fontWeight: 600, boxShadow: "var(--shadow)", maxWidth: "80vw" }}>{msg}</div>;
}

function LoadingOverlay({ text }: { text: string }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 350, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 22px", boxShadow: "var(--shadow)", color: "var(--text)", fontSize: 14, fontWeight: 600 }}>
        <span className="spinner spinner--lg" /> {text}
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)", fontSize: 13, fontWeight: 700 }}>{name.slice(0, 2).toUpperCase()}</span>;
}

function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "green" | "danger" | "accent" }) {
  const c = tone === "green" ? "var(--green)" : tone === "danger" ? "var(--danger)" : tone === "accent" ? "var(--accent-2)" : "var(--muted)";
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: c, background: "color-mix(in srgb, currentColor 12%, transparent)", padding: "3px 9px", borderRadius: 7 }}>{children}</span>;
}

function NavItem({ id, label, icon, active, onClick }: { id: string; label: string; icon: React.ReactNode; active: boolean; onClick: (id: string) => void }) {
  return (
    <button onClick={() => onClick(id)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", textAlign: "left", background: active ? "var(--accent-tint)" : "transparent", color: active ? "var(--accent-2)" : "var(--text-2)", fontSize: 13.5, fontWeight: 600 }}>
      <span style={{ display: "flex", width: 18 }}>{icon}</span>{label}
    </button>
  );
}

const nic = (p: React.ReactNode) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;

export function MasterHome({ info, pw, theme, onToggleTheme, onExit }: { info: MasterInfo; pw: string; theme: string; onToggleTheme: () => void; onExit: () => void }) {
  const [section, setSection] = useState("profiles");
  const [lic, setLic] = useState<License | null>(info.license);
  const [roles, setRoles] = useState<RoleDef[]>(info.roles);
  const [orgs, setOrgs] = useState<string[]>(info.orgs);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [loadingP, setLoadingP] = useState(false);

  const loadProfiles = async () => {
    setLoadingP(true);
    try { setProfiles(await invoke<Row[]>("sv_list_profiles", { masterLogin: info.login, masterPassword: pw })); }
    catch { /* ignore */ }
    setLoadingP(false);
  };
  useEffect(() => { loadProfiles(); }, []);

  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg)" }}>
      {/* сайдбар */}
      <div style={{ width: 224, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--sidebar)", display: "flex", flexDirection: "column", padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px 14px" }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent)", color: "#fff" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
          </span>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", letterSpacing: "-0.01em", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{info.org}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Мастер · {info.login}</div>
          </div>
        </div>
        <div style={{ height: 1, background: "var(--border-2)", margin: "0 4px 12px" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <NavItem id="profiles" label="Профили" active={section === "profiles"} onClick={setSection} icon={nic(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></>)} />
          <NavItem id="roles" label="Роли и права" active={section === "roles"} onClick={setSection} icon={nic(<><path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5z" /><path d="m9 12 2 2 4-4" /></>)} />
          <NavItem id="cat" label="Категории" active={section === "cat"} onClick={setSection} icon={nic(<><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></>)} />
          <NavItem id="access" label="Мой профиль" active={section === "access"} onClick={setSection} icon={nic(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>)} />
          <NavItem id="org" label="Организации" active={section === "org"} onClick={setSection} icon={nic(<><path d="M3 21h18" /><path d="M5 21V7l8-4v18" /><path d="M19 21V11l-6-4" /></>)} />
          <NavItem id="log" label="Журнал" active={section === "log"} onClick={setSection} icon={nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>)} />
        </div>
        <button style={{ ...ghost, marginTop: "auto" }} onClick={onExit}>Выйти</button>
      </div>

      {/* контент */}
      <div style={{ flexGrow: 1, overflow: "auto", padding: "28px 30px" }}>
       <div style={{ maxWidth: 920, margin: "0 auto" }}>
        {lic && !lic.valid && <RenewBanner server={info.server} login={info.login} pw={pw} onRenewed={setLic} />}

        {section === "profiles" && (
          <ProfilesSection masterLogin={info.login} pw={pw} roles={roles} orgs={orgs} onRolesChange={setRoles} profiles={profiles} loading={loadingP} reload={loadProfiles} />
        )}

        {section === "roles" && <RolesSection masterLogin={info.login} pw={pw} roles={roles} onSaved={setRoles} />}

        {section === "access" && <MeSection login={info.login} pw={pw} info={info} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} />}

        {section === "org" && <OrgsSection masterLogin={info.login} pw={pw} orgs={orgs} profiles={profiles} onOrgsChange={setOrgs} />}

        {section === "cat" && <CategoriesSection masterLogin={info.login} pw={pw} orgs={orgs} />}

        {section === "log" && <JournalSection masterLogin={info.login} pw={pw} />}
       </div>
      </div>
    </div>
  );
}

function RenewBanner({ server, login, pw, onRenewed }: { server: string; login: string; pw: string; onRenewed: (l: License) => void }) {
  const [renew, setRenew] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true); setErr("");
    try { onRenewed(await invoke<License>("sv_renew_license", { server, login, password: pw, licenseCode: renew })); setRenew(""); }
    catch (e) { setErr("" + String(e)); }
    setBusy(false);
  };
  return (
    <div style={{ ...box, borderColor: "var(--amber)", marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--amber)", marginBottom: 8 }}>Лицензия истекла — продлите (данные сохранятся)</div>
      <div style={{ display: "flex", gap: 10 }}>
        <input style={{ ...input, marginTop: 0 }} value={renew} onChange={(e) => setRenew(e.target.value)} placeholder="новый код лицензии…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button style={{ ...btn, minWidth: 120 }} disabled={busy || !renew} onClick={go}>{busy ? <span className="spinner spinner--on-accent" /> : "Продлить"}</button>
      </div>
      {err && <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>{err}</div>}
    </div>
  );
}

function ProfilesSection({ masterLogin, pw, roles, orgs, onRolesChange, profiles, loading, reload }: { masterLogin: string; pw: string; roles: RoleDef[]; orgs: string[]; onRolesChange: (r: RoleDef[]) => void; profiles: Row[]; loading: boolean; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState("");
  const [org, setOrg] = useState(orgs[0] || "");
  const [role, setRole] = useState(roles[0]?.key || "director");
  const [pass, setPass] = useState("");
  const [cName, setCName] = useState("");
  const [cPerms, setCPerms] = useState<string[]>([]);
  const roleName = (k: string) => roles.find((r) => r.key === k)?.name || k;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ login: string; pass: string } | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const isCustom = role === "__custom__";
  const toggleCPerm = (k: string) => setCPerms((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const create = async () => {
    if (!login.trim()) { setErr("Укажите логин"); return; }
    if (pass.length < 6) { setErr("Пароль не короче 6 символов"); return; }
    let useRole = role;
    let usePerms = roles.find((r) => r.key === role)?.perms || [];
    setBusy(true); setErr("");
    try {
      if (isCustom) {
        if (!cName.trim()) { setErr("Назовите роль"); setBusy(false); return; }
        const nr: RoleDef = { key: "r" + Date.now().toString(36), name: cName.trim(), perms: cPerms };
        const next = [...roles, nr];
        await invoke("sv_save_roles", { masterLogin, masterPassword: pw, roles: next });
        onRolesChange(next);
        useRole = nr.key;
        usePerms = cPerms;
      }
      await invoke("sv_create_profile", { masterLogin, masterPassword: pw, org, login: login.trim(), password: pass, role: useRole, perms: usePerms });
      setDone({ login: login.trim(), pass });
      setLogin(""); setPass(""); setCName(""); setCPerms([]); setRole(roles[0]?.key || "director"); setOpen(false); reload();
    } catch (e) { setErr("" + String(e)); }
    setBusy(false);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ ...h1s }}>Профили</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{profiles.length ? `${profiles.length} сотрудник(ов) в организации` : "Сотрудники вашей организации"}</div>
        </div>
        <button style={{ ...btn, marginLeft: "auto" }} onClick={() => { setOpen(true); setErr(""); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Создать профиль
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginBottom: 20 }}>
        {[
          ["sv-g1", "Профилей", String(profiles.length), <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>],
          ["sv-g3", "Активных", String(profiles.filter((p) => !p.revoked).length), <><path d="M20 6 9 17l-5-5" /></>],
          ["sv-g4", "Отозвано", String(profiles.filter((p) => p.revoked).length), <><path d="M18 6 6 18M6 6l12 12" /></>],
          ["sv-g2", "Организаций", String(orgs.length), <><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4" /></>],
        ].map(([cls, label, val, icon], i) => (
          <div key={i as number} className={`sv-stat ${cls} sv-in sv-lift`} style={{ animationDelay: `${(i as number) * 60}ms` }}>
            <span className="sv-ico"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>
            <div className="sv-val">{val}</div>
            <div className="sv-lab">{label}</div>
          </div>
        ))}
      </div>

      {done && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, border: "1px solid var(--green)", background: "color-mix(in srgb, var(--green) 9%, transparent)", borderRadius: 12, padding: "13px 16px", marginBottom: 16 }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--green)", color: "#fff" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
          <div style={{ fontSize: 13 }}>
            <div style={{ color: "var(--text)" }}>Профиль создан. Передайте сотруднику: логин <b className="mono">{done.login}</b> · пароль <b className="mono">{done.pass}</b></div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>Пароль показан один раз — он сменит его после входа.</div>
          </div>
          <button style={{ ...ghost, marginLeft: "auto", whiteSpace: "nowrap" }} onClick={() => navigator.clipboard?.writeText(`Логин: ${done.login}\nПароль: ${done.pass}`)}>Копировать</button>
        </div>
      )}

      <div style={{ ...box, padding: 0, overflow: "hidden" }}>
        {loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
          : profiles.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <div style={{ width: 46, height: 46, borderRadius: 13, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-2)", color: "var(--muted)" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /></svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Пока нет профилей</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>Создайте первый — он сразу появится на сервере, и сотрудник сможет войти.</div>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", padding: "11px 18px", borderBottom: "1px solid var(--border-2)" }}>
                <div style={{ flexGrow: 1 }}>Сотрудник</div><div style={{ width: 160 }}>Организация</div><div style={{ width: 140 }}>Роль</div><div style={{ width: 110 }}>Статус</div>
              </div>
              {profiles.map((p) => (
                <div key={p.login} className="row-hover" onClick={() => setEdit(p)} style={{ display: "flex", alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--border-2)", cursor: "pointer" }}>
                  <div style={{ flexGrow: 1, display: "flex", alignItems: "center", gap: 11 }}>
                    <Avatar name={p.login} />
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{p.login}</span>
                  </div>
                  <div style={{ width: 160, fontSize: 13, color: "var(--text-2)" }}>{p.org}</div>
                  <div style={{ width: 140 }}><Pill tone="accent">{roleName(p.role)}</Pill></div>
                  <div style={{ width: 110 }}><Pill tone={p.revoked ? "danger" : "green"}>● {p.revoked ? "отозван" : "активен"}</Pill></div>
                </div>
              ))}
            </div>
          )}
      </div>

      <Drawer open={open} onClose={() => !busy && setOpen(false)} title="Новый профиль">
        <label style={lbl}>Логин сотрудника</label>
        <input style={input} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="напр. ivan" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <div style={{ height: 14 }} />
        <label style={lbl}>Организация</label>
        <Select value={org} onChange={setOrg} options={orgs.map((o) => ({ value: o, label: o }))} />
        <div style={{ fontSize: 11, color: "var(--muted-2)", marginTop: 5 }}>Профиль будет работать только в этой организации.</div>
        <div style={{ height: 14 }} />
        <label style={lbl}>Роль</label>
        <Select value={role} onChange={(v) => { setRole(v); if (v === "__custom__" && cPerms.length === 0) setCPerms(["submit", "view_own", "edit", "delete", "comments", "export", "chat", "view_log"]); }} options={[...roles.map((r) => ({ value: r.key, label: r.name })), { value: "__custom__", label: "＋ Своя роль…" }]} />

        {!isCustom && (
          <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 11, padding: "13px 14px", background: "var(--surface-2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>Права по умолчанию</span>
              {(roles.find((r) => r.key === role)?.perms || []).includes("view_all") && <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: "linear-gradient(135deg,#6366f1,#8b5cf6)", padding: "2px 8px", borderRadius: 7 }}>ВИДИТ ВСЁ</span>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {PERMS.flatMap((g) => g.items).map((it) => {
                const on = (roles.find((r) => r.key === role)?.perms || []).includes(it.key);
                return <span key={it.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 8, background: on ? "var(--accent-tint)" : "transparent", color: on ? "var(--accent-2)" : "var(--muted-2)", border: "1px solid " + (on ? "transparent" : "var(--border-2)"), opacity: on ? 1 : 0.55 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">{on ? <path d="M20 6 9 17l-5-5" /> : <path d="M5 12h14" />}</svg>{it.label}
                </span>;
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted-2)", marginTop: 10 }}>Изменить набор прав — в разделе «Роли и права», или выберите «Своя роль».</div>
          </div>
        )}

        {isCustom && (
          <div style={{ marginTop: 14, border: "1px dashed var(--accent)", borderRadius: 11, padding: "13px 14px", background: "var(--accent-tint)" }}>
            <label style={lbl}>Название роли</label>
            <input style={input} value={cName} onChange={(e) => setCName(e.target.value)} placeholder="напр. Старший смены" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", margin: "10px 0 7px" }}>Права этой роли</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {PERMS.flatMap((g) => g.items).map((it) => <Check key={it.key} on={cPerms.includes(it.key)} label={it.label} onToggle={() => toggleCPerm(it.key)} />)}
            </div>
          </div>
        )}

        <div style={{ height: 14 }} />
        <label style={lbl}>Пароль</label>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <input style={{ ...input, marginTop: 0 }} value={pass} onChange={(e) => setPass(e.target.value)} placeholder="минимум 6 символов" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <button style={{ ...ghost, whiteSpace: "nowrap" }} onClick={() => setPass(genPassword())}>Сгенерировать</button>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10, fontSize: 11, color: "var(--muted-2)" }}>
          <span>Вход: пароль</span><span style={{ opacity: 0.5 }}>· флешка (скоро)</span><span style={{ opacity: 0.5 }}>· YubiKey (скоро)</span>
        </div>

        <button style={{ ...btn, width: "100%", marginTop: 20, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={create}>{busy ? <><span className="spinner spinner--on-accent" /> Создаю…</> : "Создать и отправить на сервер"}</button>
        {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{err}</div>}
      </Drawer>

      {edit && <ProfileEdit row={edit} masterLogin={masterLogin} pw={pw} roleName={roleName} perms={roles.find((r) => r.key === edit.role)?.perms || []} onClose={() => setEdit(null)} onChanged={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function ProfileEdit({ row, masterLogin, pw, roleName, perms, onClose, onChanged }: { row: Row; masterLogin: string; pw: string; roleName: (k: string) => string; perms: string[]; onClose: () => void; onChanged: () => void }) {
  const [np, setNp] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [reset, setReset] = useState<string | null>(null);

  const doReset = async () => {
    if (np.length < 6) { setErr("Пароль не короче 6 символов"); return; }
    setBusy("reset"); setErr("");
    try { await invoke("sv_reset_profile_password", { masterLogin, masterPassword: pw, login: row.login, org: row.org, role: row.role, newPassword: np, perms }); setReset(np); setNp(""); }
    catch (e) { setErr("" + String(e)); }
    setBusy("");
  };
  const toggleRevoke = async () => {
    setBusy("revoke"); setErr("");
    try { await invoke("sv_set_profile_revoked", { masterLogin, masterPassword: pw, login: row.login, revoked: !row.revoked }); onChanged(); }
    catch (e) { setErr("" + String(e)); setBusy(""); }
  };

  return (
    <Drawer open onClose={() => !busy && onClose()} title="Профиль сотрудника">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <Avatar name={row.login} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)" }}>{row.login}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{row.org} · {roleName(row.role)} · <span style={{ color: row.revoked ? "var(--danger)" : "var(--green)" }}>{row.revoked ? "отозван" : "активен"}</span></div>
        </div>
      </div>

      <div style={{ ...box, padding: "16px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)", marginBottom: 3 }}>Сбросить пароль</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>Выдаст сотруднику новый пароль (старый перестанет работать).</div>
        {reset ? (
          <div style={{ fontSize: 13, color: "var(--green)", fontWeight: 600 }}>Новый пароль: <b className="mono" style={{ color: "var(--text)" }}>{reset}</b>
            <button style={{ ...ghost, padding: "3px 9px", fontSize: 11, marginLeft: 8 }} onClick={() => navigator.clipboard?.writeText(reset)}>Копировать</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <input style={{ ...input, marginTop: 0 }} value={np} onChange={(e) => setNp(e.target.value)} placeholder="новый пароль" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button style={{ ...ghost, whiteSpace: "nowrap" }} onClick={() => setNp(genPassword())}>Сгенерировать</button>
            <button style={{ ...btn, whiteSpace: "nowrap", opacity: busy === "reset" ? 0.7 : 1 }} disabled={!!busy} onClick={doReset}>{busy === "reset" ? <span className="spinner spinner--on-accent" /> : "Сбросить"}</button>
          </div>
        )}
      </div>

      <button style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: 12, borderRadius: 9, border: "1px solid " + (row.revoked ? "var(--green)" : "var(--danger)"), background: "transparent", color: row.revoked ? "var(--green)" : "var(--danger)", fontWeight: 600, fontSize: 14, opacity: busy === "revoke" ? 0.7 : 1 }} disabled={!!busy} onClick={toggleRevoke}>
        {busy === "revoke" ? <span className="spinner" /> : row.revoked ? "Восстановить доступ" : "Отозвать доступ"}
      </button>
      {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{err}</div>}
    </Drawer>
  );
}

function MeSection({ login, pw, info, theme, onToggleTheme, onExit, allowPassword = true }: { login: string; pw: string; info: MasterInfo; theme: string; onToggleTheme: () => void; onExit: () => void; allowPassword?: boolean }) {
  const [name, setName] = useState(info.me_name || "");
  const [company, setCompany] = useState(info.me_company || "");
  const [savingMe, setSavingMe] = useState(false);
  const [meOk, setMeOk] = useState(false);
  const [op, setOp] = useState("");
  const [np, setNp] = useState("");
  const [np2, setNp2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const [connCode, setConnCode] = useState("");
  const [copied, setCopied] = useState(false);

  const genCode = async () => { try { setConnCode(await invoke<string>("sv_make_conn_code")); } catch { /* */ } };
  const copyCode = async () => { try { await navigator.clipboard.writeText(connCode); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } };

  const saveMe = async () => {
    setSavingMe(true); setMeOk(false);
    try { await invoke("sv_save_me", { masterLogin: login, masterPassword: pw, name, company }); setMeOk(true); setTimeout(() => setMeOk(false), 2000); }
    catch { /* ignore */ }
    setSavingMe(false);
  };
  const change = async () => {
    if (!op) { setErr("Введите текущий пароль"); return; }
    if (np.length < 6) { setErr("Новый пароль не короче 6 символов"); return; }
    if (np !== np2) { setErr("Новые пароли не совпадают"); return; }
    if (np === op) { setErr("Новый пароль совпадает со старым"); return; }
    setBusy(true); setErr("");
    try { await invoke("sv_change_password", { login, oldPassword: op, newPassword: np }); setOk(true); setTimeout(onExit, 1600); }
    catch (e) { setErr("" + String(e)); setBusy(false); }
  };
  const tile = (title: string, sub: string, active: boolean) => (
    <div style={{ flex: 1, border: "1px solid " + (active ? "var(--accent)" : "var(--border)"), background: active ? "var(--accent-tint)" : "var(--surface-2)", borderRadius: 11, padding: "13px 14px", opacity: active ? 1 : 0.6 }}>
      <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)" }}>{title}</div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>{sub}</div>
    </div>
  );

  return (
    <>
      <h1 style={{ ...h1s, marginBottom: 18 }}>Мой профиль</h1>

      <div style={{ ...box, marginBottom: 16 }}>
        <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", marginBottom: 12 }}>Данные</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div><label style={lbl}>Имя и фамилия</label><input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Иван Петров" /></div>
          <div><label style={lbl}>Компания</label><input style={input} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="напр. ООО «Ромашка»" /></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
          <button style={{ ...btn, opacity: savingMe ? 0.7 : 1 }} disabled={savingMe} onClick={saveMe}>{savingMe ? <span className="spinner spinner--on-accent" /> : "Сохранить"}</button>
          {meOk && <span style={{ fontSize: 12.5, color: "var(--green)", fontWeight: 600 }}>Сохранено ✓</span>}
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>Логин: <b style={{ color: "var(--text-2)" }}>{login}</b></span>
        </div>
      </div>

      {info.role === "master" && (
        <div style={{ ...box, marginBottom: 16 }}>
          <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", marginBottom: 6 }}>Код подключения для сотрудников</div>
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5, marginBottom: 12 }}>Выдайте этот код проверяющему и директорам. Они вводят его один раз при первом входе — адрес сервера вводить не нужно, он зашит в код.</div>
          {!connCode ? (
            <button style={btn} onClick={genCode}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "-2px" }}><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg>Показать код</button>
          ) : (
            <>
              <textarea readOnly value={connCode} onFocus={(e) => e.target.select()} style={{ ...input, marginTop: 0, minHeight: 72, resize: "none", fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.5, wordBreak: "break-all" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
                <button style={btn} onClick={copyCode}>{copied ? "Скопировано ✓" : "Скопировать"}</button>
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Передавайте по защищённому каналу.</span>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ ...box, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)" }}>Тема оформления</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>Светлая или тёмная</div>
          </div>
          <button style={{ ...ghost, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }} onClick={onToggleTheme}>
            {theme === "dark"
              ? <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg> Светлая</>
              : <><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg> Тёмная</>}
          </button>
        </div>
      </div>

      {allowPassword ? <>
        <div style={{ ...box, marginBottom: 16 }}>
          <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", marginBottom: 10 }}>Способ входа</div>
          <div style={{ display: "flex", gap: 12 }}>
            {tile("Пароль", "Сейчас используется", true)}
            {tile("Флешка", "Ключ на флешке — скоро", false)}
            {tile("YubiKey", "Аппаратный ключ — скоро", false)}
          </div>
        </div>

        <div style={box}>
          <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", marginBottom: 2 }}>Сменить пароль</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Пароль шифрует ваш аккаунт — после смены нужно войти заново.</div>
          {ok ? <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--green)" }}>Пароль изменён ✓ Входим заново…</div> : <>
            <div style={{ maxWidth: 320 }}><label style={lbl}>Текущий пароль</label><input style={input} type="password" value={op} onChange={(e) => setOp(e.target.value)} placeholder="введите действующий пароль" /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 4 }}>
              <div><label style={lbl}>Новый пароль</label><input style={input} type="password" value={np} onChange={(e) => setNp(e.target.value)} /></div>
              <div><label style={lbl}>Повторите новый</label><input style={input} type="password" value={np2} onChange={(e) => setNp2(e.target.value)} /></div>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 14 }}>
              <button style={{ ...btn, minWidth: 160, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={change}>{busy ? <><span className="spinner spinner--on-accent" /> Меняю…</> : "Сменить пароль"}</button>
              {err && <span style={{ fontSize: 12.5, color: "var(--danger)" }}>{err}</span>}
            </div>
          </>}
        </div>
      </> : (
        <div style={{ ...box, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>Пароль и способ входа задаёт администратор. Если нужен новый пароль — обратитесь к нему.</div>
        </div>
      )}
    </>
  );
}

function OrgsSection({ masterLogin, pw, orgs, profiles, onOrgsChange }: { masterLogin: string; pw: string; orgs: string[]; profiles: Row[]; onOrgsChange: (o: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [rn, setRn] = useState("");
  const [rBusy, setRBusy] = useState(false);
  const [rErr, setRErr] = useState("");
  const count = (o: string) => profiles.filter((p) => p.org === o).length;

  const add = async () => {
    if (!name.trim()) { setErr("Укажите название"); return; }
    setBusy(true); setErr("");
    try { const next = await invoke<string[]>("sv_add_org", { masterLogin, masterPassword: pw, org: name.trim() }); onOrgsChange(next); setName(""); setOpen(false); }
    catch (e) { setErr("" + String(e)); }
    setBusy(false);
  };
  const rename = async () => {
    if (!rn.trim() || rn.trim() === edit) { setEdit(null); return; }
    setRBusy(true); setRErr("");
    try { const next = await invoke<string[]>("sv_rename_org", { masterLogin, masterPassword: pw, old: edit, new: rn.trim() }); onOrgsChange(next); setEdit(null); }
    catch (e) { setRErr("" + String(e)); }
    setRBusy(false);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ ...h1s }}>Организации</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>Профили одной организации видят только своих</div>
        </div>
        <button style={{ ...btn, marginLeft: "auto" }} onClick={() => { setOpen(true); setErr(""); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Добавить организацию
        </button>
      </div>

      <div style={{ ...box, padding: 0, overflow: "hidden" }}>
        {orgs.map((o, i) => (
          <div key={o} className="row-hover" onClick={() => { setEdit(o); setRn(o); setRErr(""); }} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderTop: i ? "1px solid var(--border-2)" : "none", cursor: "pointer" }}>
            <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V7l8-4v18" /><path d="M19 21V11l-6-4" /></svg>
            </span>
            <div style={{ flexGrow: 1, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{o}</div>
            <Pill>{count(o)} профил.</Pill>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </div>
        ))}
      </div>

      <Drawer open={open} onClose={() => !busy && setOpen(false)} title="Новая организация">
        <label style={lbl}>Название организации</label>
        <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Второй филиал" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <div style={{ fontSize: 11.5, color: "var(--muted-2)", marginTop: 6 }}>К ней можно будет привязывать новые профили.</div>
        <button style={{ ...btn, width: "100%", marginTop: 18, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={add}>{busy ? <><span className="spinner spinner--on-accent" /> Добавляю…</> : "Добавить"}</button>
        {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{err}</div>}
      </Drawer>

      <Drawer open={!!edit} onClose={() => !rBusy && setEdit(null)} title="Организация">
        <label style={lbl}>Название</label>
        <input style={input} value={rn} onChange={(e) => setRn(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <div style={{ fontSize: 11.5, color: "var(--muted-2)", marginTop: 6 }}>Переименование применится ко всем профилям этой организации ({edit ? count(edit) : 0}).</div>
        <button style={{ ...btn, width: "100%", marginTop: 18, opacity: rBusy ? 0.7 : 1 }} disabled={rBusy} onClick={rename}>{rBusy ? <><span className="spinner spinner--on-accent" /> Сохраняю…</> : "Сохранить"}</button>
        {rErr && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{rErr}</div>}
      </Drawer>
    </>
  );
}

function RolesSection({ masterLogin, pw, roles: initial, onSaved }: { masterLogin: string; pw: string; roles: RoleDef[]; onSaved: (r: RoleDef[]) => void }) {
  const [roles, setRoles] = useState<RoleDef[]>(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [cName, setCName] = useState("");
  const [cPerms, setCPerms] = useState<string[]>([]);
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState("");

  const persist = async (next: RoleDef[], markId?: string) => {
    if (markId) setSavingId(markId);
    try { await invoke("sv_save_roles", { masterLogin, masterPassword: pw, roles: next }); setRoles(next); onSaved(next); }
    catch (e) { setCErr("" + String(e)); }
    setSavingId(null);
  };
  const toggle = (i: number, key: string) => {
    const next = roles.map((r, idx) => (idx === i ? { ...r, perms: r.perms.includes(key) ? r.perms.filter((p) => p !== key) : [...r.perms, key] } : r));
    setRoles(next);
  };
  const setName = (i: number, name: string) => setRoles((rs) => rs.map((r, idx) => (idx === i ? { ...r, name } : r)));
  const remove = (i: number) => { const next = roles.filter((_, idx) => idx !== i); persist(next); };
  const addRole = async () => {
    if (!cName.trim()) { setCErr("Назовите роль"); return; }
    setCBusy(true); setCErr("");
    const next = [...roles, { key: "r" + Date.now().toString(36), name: cName.trim(), perms: cPerms }];
    await persist(next);
    setCBusy(false); setCreate(false); setCName(""); setCPerms([]);
  };
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ ...h1s }}>Роли и права</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>Нажмите на роль, чтобы изменить её права</div>
        </div>
        <button style={{ ...btn, marginLeft: "auto" }} onClick={() => { setCreate(true); setCErr(""); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Роль
        </button>
      </div>

      <div style={{ ...box, padding: 0, overflow: "hidden" }}>
        {roles.map((r, i) => {
          const isOpen = openId === r.key;
          return (
            <div key={r.key} style={{ borderTop: i ? "1px solid var(--border-2)" : "none" }}>
              <div className="row-hover" onClick={() => setOpenId(isOpen ? null : r.key)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", cursor: "pointer" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", flexShrink: 0 }}><path d="m9 18 6-6-6-6" /></svg>
                <div style={{ flexGrow: 1, fontSize: 14.5, fontWeight: 600, color: "var(--text)" }}>{r.name}</div>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{r.perms.length} прав</span>
                {savingId === r.key && <span className="spinner" />}
              </div>
              {isOpen && (
                <div style={{ padding: "4px 18px 18px 46px", background: "var(--surface-2)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 14px" }}>
                    <input style={{ ...input, marginTop: 0, maxWidth: 280 }} value={r.name} onChange={(e) => setName(i, e.target.value)} onBlur={() => persist(roles, r.key)} />
                    <button style={{ ...ghost, color: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => remove(i)}>Удалить роль</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                    {PERMS.map((grp) => (
                      <div key={grp.group}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".05em", color: "var(--muted)", textTransform: "uppercase", marginBottom: 7 }}>{grp.group}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {grp.items.map((it) => <Check key={it.key} on={r.perms.includes(it.key)} label={it.label} onToggle={() => toggle(i, it.key)} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <button style={{ ...btn, marginTop: 16, opacity: savingId === r.key ? 0.7 : 1 }} disabled={savingId === r.key} onClick={() => persist(roles, r.key)}>Сохранить изменения</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {cErr && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10 }}>{cErr}</div>}

      <Drawer open={create} onClose={() => !cBusy && setCreate(false)} title="Новая роль">
        <label style={lbl}>Название роли</label>
        <input style={input} value={cName} onChange={(e) => setCName(e.target.value)} placeholder="напр. Старший смены" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em", margin: "16px 0 8px" }}>Права</div>
        {PERMS.map((grp) => (
          <div key={grp.group} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted-2)", marginBottom: 6 }}>{grp.group}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {grp.items.map((it) => <Check key={it.key} on={cPerms.includes(it.key)} label={it.label} onToggle={() => setCPerms((p) => (p.includes(it.key) ? p.filter((x) => x !== it.key) : [...p, it.key]))} />)}
            </div>
          </div>
        ))}
        <button style={{ ...btn, width: "100%", marginTop: 12, opacity: cBusy ? 0.7 : 1 }} disabled={cBusy} onClick={addRole}>{cBusy ? <><span className="spinner spinner--on-accent" /> Создаю…</> : "Создать роль"}</button>
      </Drawer>
    </>
  );
}

type Audit = { action: string; target: string; org: string; at: string };
const ACTIONS: Record<string, { label: string; tone: "accent" | "green" | "danger" | "muted" }> = {
  profile_created: { label: "Создан профиль", tone: "green" },
  password_reset: { label: "Сброшен пароль", tone: "accent" },
  revoked: { label: "Отозван доступ", tone: "danger" },
  restored: { label: "Восстановлен доступ", tone: "green" },
  org_renamed: { label: "Переименована организация", tone: "muted" },
};

function JournalSection({ masterLogin, pw }: { masterLogin: string; pw: string }) {
  const [entries, setEntries] = useState<Audit[]>([]);
  const [chainOk, setChainOk] = useState(true);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    invoke<{ entries: Audit[]; chain_ok: boolean }>("sv_log", { masterLogin, masterPassword: pw })
      .then((r) => { setEntries(r.entries); setChainOk(r.chain_ok); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  const fmt = (s: string) => { try { return new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return s; } };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 18 }}>
        <div>
          <h1 style={{ ...h1s }}>Журнал</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>Кто и что делал — без содержимого данных</div>
        </div>
        {!loading && (
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: chainOk ? "var(--green)" : "var(--danger)", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />{chainOk && <path d="m9 12 2 2 4-4" />}</svg>
            {chainOk ? "Целостность подтверждена" : "Цепочка нарушена"}
          </span>
        )}
      </div>
      <div style={{ ...box, padding: 0, overflow: "hidden" }}>
        {loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
          : entries.length === 0 ? <div style={{ padding: "34px 20px", textAlign: "center", fontSize: 13, color: "var(--muted)" }}>Пока пусто. Действия (создание профилей, сброс пароля, отзыв) появятся здесь.</div>
            : entries.map((e, i) => {
                const a = ACTIONS[e.action] || { label: e.action, tone: "muted" as const };
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", borderTop: i ? "1px solid var(--border-2)" : "none" }}>
                    <Pill tone={a.tone}>{a.label}</Pill>
                    <div style={{ flexGrow: 1, fontSize: 13.5, color: "var(--text)" }}>{e.target}{e.org ? <span style={{ color: "var(--muted)" }}> · {e.org}</span> : ""}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>{fmt(e.at)}</div>
                  </div>
                );
              })}
      </div>
    </>
  );
}

// ===== Кабинет директора =====
const txtToB64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
const b64ToTxt = (b: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))); } catch { return ""; } };
const fileToB64 = (file: File): Promise<string> => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const s = r.result as string; res(s.slice(s.indexOf(",") + 1)); }; r.onerror = rej; r.readAsDataURL(file); });
const b64ToBytes = (b: string) => { try { return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(); } };
const bytesToB64 = (bytes: Uint8Array) => { let bin = ""; const ch = 0x8000; for (let i = 0; i < bytes.length; i += ch) bin += String.fromCharCode(...bytes.subarray(i, i + ch)); return btoa(bin); };
const isSheet = (name: string) => /\.(xlsx|xls|csv)$/i.test(name);
const isDoc = (name: string) => /\.svdoc$/i.test(name);
const isViewable = (name: string) => /\.(pdf|docx|txt|md|log|json|xml|png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name);
const fmtSize = (n: number) => (n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
const fmtDate = (s: string) => { try { return new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return s; } };
type DRec = { id: string; kind: string; name: string; size: number; folder: string; comments: number; at: string };

export function DirectorHome({ info, pw, theme, onToggleTheme, onExit }: { info: MasterInfo; pw: string; theme: string; onToggleTheme: () => void; onExit: () => void }) {
  const login = info.login;
  const [section, setSection] = useState("reports");
  const [recs, setRecs] = useState<DRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState("");

  const loadRecs = async () => { setLoading(true); try { setRecs(await invoke<DRec[]>("sv_dir_list", { login, password: pw })); } catch { /* */ } setLoading(false); };
  const loadFolders = async () => { try { setFolders(await invoke<string[]>("sv_dir_folders", { login, password: pw })); } catch { /* */ } };
  useEffect(() => { loadRecs(); loadFolders(); }, []);

  const topCats = useMemo(() => {
    const set = new Set<string>();
    folders.forEach((f) => { if (f) set.add(f.split("/")[0]); });
    recs.forEach((r) => { if (r.folder) set.add(r.folder.split("/")[0]); });
    return [...set].sort();
  }, [folders, recs]);
  const go = (p: string) => { setSection("reports"); setPath(p); };

  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg)" }}>
      <div style={{ width: 236, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--sidebar)", display: "flex", flexDirection: "column", padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px 14px" }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent)", color: "#fff" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
          </span>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", letterSpacing: "-0.01em", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{info.org}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Директор · {login}</div>
          </div>
        </div>
        <div style={{ height: 1, background: "var(--border-2)", margin: "0 4px 12px" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, overflow: "auto" }}>
          <button onClick={() => go("")} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", textAlign: "left", background: section === "reports" ? "var(--accent-tint)" : "transparent", color: section === "reports" ? "var(--accent-2)" : "var(--text-2)", fontSize: 13.5, fontWeight: 600 }}>
            <span style={{ display: "flex", width: 18 }}>{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>)}</span>Мои отчёты
          </button>
          {section === "reports" && topCats.map((c) => {
            const active = path === c || path.startsWith(c + "/");
            return (
              <button key={c} onClick={() => go(c)} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 12px 7px 30px", borderRadius: 9, border: "none", textAlign: "left", background: active ? "var(--accent-tint)" : "transparent", color: active ? "var(--accent-2)" : "var(--muted)", fontSize: 12.5, fontWeight: 600 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg>
                <span style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{c}</span>
              </button>
            );
          })}
          <div style={{ height: 6 }} />
          {hasPerm(info, "view_log") && <NavItem id="log" label="Журнал" active={section === "log"} onClick={setSection} icon={nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>)} />}
          <NavItem id="profile" label="Профиль" active={section === "profile"} onClick={setSection} icon={nic(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>)} />
        </div>
        <button style={{ ...ghost, marginTop: "auto" }} onClick={onExit}>Выйти</button>
      </div>

      <div style={{ flexGrow: 1, overflow: "auto", padding: "28px 30px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto" }}>
          {section === "reports" && <DirReports login={login} pw={pw} info={info} recs={recs} loading={loading} reloadRecs={loadRecs} folders={folders} reloadFolders={loadFolders} path={path} setPath={setPath} />}
          {section === "log" && <JournalMine login={login} pw={pw} />}
          {section === "profile" && <MeSection login={login} pw={pw} info={info} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} allowPassword={false} />}
        </div>
      </div>
    </div>
  );
}

function DirReports({ login, pw, info, recs, loading, reloadRecs, folders, reloadFolders, path, setPath }: { login: string; pw: string; info: MasterInfo; recs: DRec[]; loading: boolean; reloadRecs: () => void; folders: string[]; reloadFolders: () => void; path: string; setPath: (p: string) => void }) {
  const can = (k: string) => hasPerm(info, k);
  const [grid, setGrid] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [fname, setFname] = useState("");
  const [create, setCreate] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addFiles, setAddFiles] = useState<File[]>([]);
  const [addProg, setAddProg] = useState("");
  const [doc, setDoc] = useState<{ id?: string; name: string; folder: string; content: string | null } | null>(null);
  const [docSaving, setDocSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [view, setView] = useState<DRec | null>(null);
  const [cmFor, setCmFor] = useState<DRec | null>(null);
  const [viewText, setViewText] = useState("");
  const [viewBusy, setViewBusy] = useState(false);
  const [fileView, setFileView] = useState<DRec | null>(null);
  const [sheet, setSheet] = useState<{ id?: string; name: string; folder: string; bytes: Uint8Array | null } | null>(null);
  const [sheetSaving, setSheetSaving] = useState(false);
  const [viewer, setViewer] = useState<{ rec: DRec; bytes: Uint8Array } | null>(null);
  const [confirmData, setConfirmData] = useState<{ title: string; text: string; danger?: boolean; onYes: () => void } | null>(null);
  const [toast, setToast] = useState("");
  const [opening, setOpening] = useState("");
  const replaceRec = useRef<DRec | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3500); };

  const join = (b: string, n: string) => (b ? b + "/" + n : n);
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const base = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
  const allNodes = useMemo(() => { const set = new Set<string>(); const add = (p: string) => { if (!p) return; const segs = p.split("/"); let cur = ""; for (const s of segs) { cur = cur ? cur + "/" + s : s; set.add(cur); } }; folders.forEach(add); recs.forEach((r) => add(r.folder)); return set; }, [folders, recs]);
  const subfolders = useMemo(() => [...allNodes].filter((f) => parentOf(f) === path).sort(), [allNodes, path]);
  const files = useMemo(() => recs.filter((r) => (r.folder || "") === path), [recs, path]);
  const folderCount = (f: string) => recs.filter((r) => (r.folder || "") === f || (r.folder || "").startsWith(f + "/")).length;
  const crumbs = path ? path.split("/") : [];

  const createFolder = async () => { if (!fname.trim()) { setNewFolder(false); return; } try { await invoke("sv_dir_mkfolder", { login, password: pw, path: join(path, fname.trim()) }); setFname(""); setNewFolder(false); reloadFolders(); } catch (e) { notify("" + String(e)); } };
  const saveToDisk = async (name: string, b64: string) => { try { await invoke<string>("sv_save_file", { filename: name, contentB64: b64 }); notify("Сохранено в папку «Загрузки»: " + name); } catch (e) { notify("" + String(e)); } };
  const submitReport = async () => {
    if (!title.trim()) { setErr("Укажите название"); return; }
    setErr(""); setBusy(true);
    try { await invoke("sv_dir_submit", { login, password: pw, folder: path, title: title.trim(), kind: "report", contentB64: txtToB64(text) }); setTitle(""); setText(""); setReportOpen(false); reloadRecs(); }
    catch (e) { setErr("" + String(e)); }
    setBusy(false);
  };
  const addUpload = async () => {
    if (!addFiles.length) { return; }
    setBusy(true);
    try {
      for (let i = 0; i < addFiles.length; i++) {
        setAddProg(`Загружаю ${i + 1} из ${addFiles.length}…`);
        const f = addFiles[i];
        const b64 = await fileToB64(f);
        await invoke("sv_dir_submit", { login, password: pw, folder: path, title: f.name, kind: "file", contentB64: b64 });
      }
      setAddFiles([]); setAddOpen(false); reloadRecs();
    } catch (e) { notify("" + String(e)); }
    setAddProg(""); setBusy(false);
  };
  const newSheet = () => { setCreate(false); setSheet({ name: "Таблица.xlsx", folder: path, bytes: null }); };
  const newDoc = () => { setCreate(false); setDoc({ name: "Документ.svdoc", folder: path, content: null }); };
  const newReport = () => { setCreate(false); setTitle(""); setText(""); setErr(""); setReportOpen(true); };
  const saveSheet = async (bytes: Uint8Array, name: string) => {
    if (!sheet) return;
    setSheetSaving(true);
    try { await invoke("sv_dir_submit", { login, password: pw, folder: sheet.folder, title: name, kind: "file", contentB64: bytesToB64(bytes) }); if (sheet.id) await invoke("sv_dir_delete", { login, password: pw, id: sheet.id }); setSheet(null); reloadRecs(); }
    catch (e) { notify("" + String(e)); }
    setSheetSaving(false);
  };
  const saveDoc = async (bytes: Uint8Array, name: string) => {
    if (!doc) return;
    setDocSaving(true);
    try { await invoke("sv_dir_submit", { login, password: pw, folder: doc.folder, title: name, kind: "file", contentB64: bytesToB64(bytes) }); if (doc.id) await invoke("sv_dir_delete", { login, password: pw, id: doc.id }); setDoc(null); reloadRecs(); }
    catch (e) { notify("" + String(e)); }
    setDocSaving(false);
  };
  const openRec = async (r: DRec) => {
    if (r.kind === "file" && isDoc(r.name)) { setOpening("Открываю документ…"); try { const b = await invoke<string>("sv_dir_open", { login, password: pw, id: r.id }); setDoc({ id: r.id, name: r.name, folder: r.folder || "", content: b64ToTxt(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file" && isSheet(r.name)) { setOpening("Открываю таблицу…"); try { const b = await invoke<string>("sv_dir_open", { login, password: pw, id: r.id }); setSheet({ id: r.id, name: r.name, folder: r.folder || "", bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file" && isViewable(r.name)) { setOpening("Открываю файл…"); try { const b = await invoke<string>("sv_dir_open", { login, password: pw, id: r.id }); setViewer({ rec: r, bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file") { setFileView(r); return; }
    setView(r); setViewText(""); setViewBusy(true); setOpening("Расшифровываю…");
    try { const b = await invoke<string>("sv_dir_open", { login, password: pw, id: r.id }); setViewText(b64ToTxt(b)); } catch (e) { setViewText("Ошибка: " + String(e)); }
    setViewBusy(false); setOpening("");
  };
  const saveEdit = async () => { if (!view) return; setViewBusy(true); try { await invoke("sv_dir_submit", { login, password: pw, folder: view.folder || "", title: view.name, kind: "report", contentB64: txtToB64(viewText) }); await invoke("sv_dir_delete", { login, password: pw, id: view.id }); setView(null); reloadRecs(); } catch (e) { notify("" + String(e)); } setViewBusy(false); };
  const del = (r: DRec) => setConfirmData({ title: "Удалить?", text: "«" + r.name + "» будет удалён без возможности восстановления.", danger: true, onYes: async () => { try { await invoke("sv_dir_delete", { login, password: pw, id: r.id }); setView(null); setFileView(null); reloadRecs(); } catch (e) { notify("" + String(e)); } } });
  const openFileInApp = async (r: DRec) => { setFileView(null); setOpening("Открываю в программе…"); try { await invoke("sv_dir_open_file", { login, password: pw, id: r.id, filename: r.name }); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const openNative = async (id: string, name: string) => { setOpening("Открываю в программе…"); try { await invoke("sv_dir_open_file", { login, password: pw, id, filename: name }); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const downloadRec = async (r: DRec) => { setOpening("Готовлю файл…"); try { const b = await invoke<string>("sv_dir_open", { login, password: pw, id: r.id }); await saveToDisk(r.name, b); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const startReplace = (r: DRec) => { replaceRec.current = r; replaceInput.current?.click(); };
  const onReplaceFile = async (f: File | null) => { const r = replaceRec.current; replaceRec.current = null; if (!r || !f) return; setOpening("Заменяю…"); try { const b64 = await fileToB64(f); await invoke("sv_dir_submit", { login, password: pw, folder: r.folder || "", title: f.name, kind: "file", contentB64: b64 }); await invoke("sv_dir_delete", { login, password: pw, id: r.id }); reloadRecs(); } catch (e) { notify("" + String(e)); } setOpening(""); };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <div>
          <h1 style={{ ...h1s }}>Мои отчёты</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>Файлы и отчёты по папкам</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
            <button onClick={() => setGrid(false)} title="Список" style={{ padding: "8px 10px", background: !grid ? "var(--accent-tint)" : "transparent", border: "none", color: !grid ? "var(--accent-2)" : "var(--muted)", display: "flex" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg></button>
            <button onClick={() => setGrid(true)} title="Значки" style={{ padding: "8px 10px", background: grid ? "var(--accent-tint)" : "transparent", border: "none", color: grid ? "var(--accent-2)" : "var(--muted)", display: "flex" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg></button>
          </div>
          {can("submit") && <button style={{ ...ghost, opacity: path ? 1 : 0.5 }} disabled={!path} title={path ? "Создать папку внутри категории" : "Папки создаются внутри категории"} onClick={() => { setNewFolder(true); setFname(""); }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "-2px" }}><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /><path d="M12 10v6M9 13h6" /></svg>Папка</button>}
          {can("submit") && <button style={ghost} onClick={() => setAddOpen(true)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6, verticalAlign: "-2px" }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>Добавить</button>}
          {can("submit") && <button style={btn} onClick={() => setCreate(true)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>Создать</button>}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 13, flexWrap: "wrap" }}>
        <button onClick={() => setPath("")} style={{ background: "transparent", border: "none", color: path ? "var(--accent-2)" : "var(--text)", fontWeight: 600, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>Все папки</button>
        {crumbs.map((c, i) => { const p = crumbs.slice(0, i + 1).join("/"); const last = i === crumbs.length - 1; return <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ color: "var(--muted-2)" }}>/</span><button onClick={() => setPath(p)} style={{ background: "transparent", border: "none", color: last ? "var(--text)" : "var(--accent-2)", fontWeight: 600, fontSize: 13 }}>{c}</button></span>; })}
      </div>

      {newFolder && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <input autoFocus style={{ ...input, marginTop: 0, maxWidth: 320 }} value={fname} onChange={(e) => setFname(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFolder()} placeholder="название папки (напр. 2026)" autoCapitalize="off" spellCheck={false} />
          <button style={btn} onClick={createFolder}>Создать</button>
          <button style={ghost} onClick={() => setNewFolder(false)}>Отмена</button>
        </div>
      )}

      <div style={{ ...box, padding: 8 }}>
        {loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
          : subfolders.length === 0 && files.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <div style={{ width: 52, height: 52, borderRadius: 15, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg></div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{path ? "В этой папке пусто" : "Нет категорий"}</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>{path ? "Создайте папку или сдайте отчёт." : "Категории создаёт администратор. Внутри категории можно создавать папки."}</div>
            </div>
          ) : grid ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))", gap: 12, padding: 10 }}>
              {subfolders.map((f, i) => (
                <div key={"gf" + f} className="sv-lift sv-in" onClick={() => setPath(f)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9, padding: "18px 10px", borderRadius: 13, border: "1px solid var(--border-2)", background: "var(--surface-2)", cursor: "pointer", textAlign: "center", animationDelay: `${i * 35}ms` }}>
                  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", wordBreak: "break-word", lineHeight: 1.3 }}>{base(f)}</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{folderCount(f)} файл.</div>
                </div>
              ))}
              {files.map((r, i) => (
                <div key={"g" + r.id} className="sv-lift sv-in" onClick={() => openRec(r)} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 9, padding: "18px 10px", borderRadius: 13, border: "1px solid var(--border-2)", background: "var(--surface-2)", cursor: "pointer", textAlign: "center", animationDelay: `${(subfolders.length + i) * 35}ms` }}>
                  {r.comments > 0 && <span className="sv-badge" style={{ position: "absolute", top: 8, left: 8, background: "linear-gradient(135deg,#0ea5e9,#22d3ee)" }}>{r.comments}</span>}
                  {can("delete") && <button onClick={(e) => { e.stopPropagation(); del(r); }} style={{ position: "absolute", top: 6, right: 6, background: "transparent", border: "none", color: "var(--muted-2)", padding: 3 }} title="Удалить"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg></button>}
                  <span style={{ width: 46, height: 46, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: r.kind === "file" ? "var(--accent-tint)" : "color-mix(in srgb, #10b981 16%, transparent)", color: r.kind === "file" ? "var(--accent-2)" : "#10b981" }}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{r.kind === "file" ? <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></> : <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>}</svg></span>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", wordBreak: "break-word", lineHeight: 1.3 }}>{r.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{fmtDate(r.at)}</div>
                </div>
              ))}
            </div>
          ) : <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 2 }}>
            {subfolders.map((f) => (
              <div key={"f" + f} className="sv-item" onClick={() => setPath(f)}>
                <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg></span>
                <div style={{ flexGrow: 1, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{base(f)}</div>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{folderCount(f)} файл.</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              </div>
            ))}
            {files.map((r) => (
              <div key={r.id} className="sv-item" onClick={() => openRec(r)}>
                <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: r.kind === "file" ? "var(--accent-tint)" : "color-mix(in srgb, #10b981 16%, transparent)", color: r.kind === "file" ? "var(--accent-2)" : "#10b981" }}>{r.kind === "file" ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg> : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16M4 10h16M4 16h10" /></svg>}</span>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{fmtDate(r.at)} · {fmtSize(r.size)} · {r.kind === "file" ? "файл" : "отчёт"}</div>
                </div>
                {can("comments") && <button onClick={(e) => { e.stopPropagation(); setCmFor(r); }} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: r.comments > 0 ? "var(--accent-tint)" : "transparent", border: "none", color: r.comments > 0 ? "var(--accent-2)" : "var(--muted-2)", padding: "6px 9px", borderRadius: 8, fontSize: 12.5, fontWeight: 700 }} title={r.comments > 0 ? `Комментариев: ${r.comments}` : "Оставить комментарий"}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>{r.comments > 0 ? r.comments : ""}</button>}
                {r.kind === "file" && can("edit") && <button onClick={(e) => { e.stopPropagation(); startReplace(r); }} style={{ background: "transparent", border: "none", color: "var(--muted-2)", padding: 6, borderRadius: 8 }} title="Заменить файл"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></svg></button>}
                {can("delete") && <button onClick={(e) => { e.stopPropagation(); del(r); }} style={{ background: "transparent", border: "none", color: "var(--muted-2)", padding: 6, borderRadius: 8 }} title="Удалить"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg></button>}
              </div>
            ))}
          </div>}
      </div>

      <input ref={replaceInput} type="file" style={{ display: "none" }} onChange={(e) => onReplaceFile(e.target.files?.[0] || null)} />
      <input ref={addInput} type="file" multiple style={{ display: "none" }} onChange={(e) => { const fs = Array.from(e.target.files || []); setAddFiles((prev) => [...prev, ...fs]); if (e.target) e.target.value = ""; }} />

      <Drawer open={create} onClose={() => setCreate(false)} title="Создать отчёт">
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>Будет создан прямо в приложении, в папке <b style={{ color: "var(--text-2)" }}>{path || "Все папки"}</b>. Ничего не скачивается.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {([
            ["report", "Текстовый отчёт", "Простой текст — заметка, сводка, комментарий.", <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>],
            ["sheet", "Таблица (Excel)", "Числа и формулы, пересчёт как в Excel.", <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>],
            ["doc", "Документ (Word)", "Форматированный текст, как в Word.", <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></>],
          ] as const).map(([k, title, desc, icon]) => (
            <button key={k} onClick={() => k === "report" ? newReport() : k === "sheet" ? newSheet() : newDoc()} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 14, textAlign: "left", padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface-2)", cursor: "pointer" }}>
              <span style={{ width: 42, height: 42, borderRadius: 11, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>
              <span style={{ flexGrow: 1 }}>
                <span style={{ display: "block", fontSize: 14.5, fontWeight: 650, color: "var(--text)" }}>{title}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{desc}</span>
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          ))}
        </div>
      </Drawer>

      <Drawer open={reportOpen} onClose={() => !busy && setReportOpen(false)} title="Текстовый отчёт">
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Папка: <b style={{ color: "var(--text-2)" }}>{path || "Все папки"}</b></div>
        <label style={lbl}>Название</label>
        <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="напр. Отчёт за неделю" />
        <div style={{ height: 12 }} />
        <label style={lbl}>Содержание</label>
        <textarea style={{ ...input, minHeight: 220, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} value={text} onChange={(e) => setText(e.target.value)} />
        <button style={{ ...btn, width: "100%", marginTop: 18, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={submitReport}>{busy ? <><span className="spinner spinner--on-accent" /> Сохраняю…</> : "Сохранить"}</button>
        {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{err}</div>}
      </Drawer>

      <Drawer open={addOpen} onClose={() => !busy && setAddOpen(false)} title="Добавить с компьютера">
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>Папка: <b style={{ color: "var(--text-2)" }}>{path || "Все папки"}</b>. Можно выбрать сразу несколько файлов.</div>
        <button type="button" onClick={() => addInput.current?.click()} disabled={busy} style={{ display: "block", width: "100%", border: "2px dashed var(--accent)", borderRadius: 13, padding: "26px 16px", textAlign: "center", background: "var(--accent-tint)", cursor: busy ? "default" : "pointer", color: "var(--accent-2)", opacity: busy ? 0.6 : 1 }}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
          <div style={{ fontSize: 14, fontWeight: 650, marginTop: 8 }}>Нажмите, чтобы выбрать файлы</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>Excel, Word, PDF, фото скана</div>
        </button>
        {addFiles.length > 0 && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {addFiles.map((f, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface-2)" }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                <div style={{ flexGrow: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtSize(f.size)}</div></div>
                {!busy && <button onClick={() => setAddFiles((prev) => prev.filter((_, j) => j !== i))} style={{ background: "transparent", border: "none", color: "var(--muted-2)", padding: 4 }} title="Убрать"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg></button>}
              </div>
            ))}
          </div>
        )}
        <button style={{ ...btn, width: "100%", marginTop: 18, opacity: busy || !addFiles.length ? 0.6 : 1 }} disabled={busy || !addFiles.length} onClick={addUpload}>{busy ? <><span className="spinner spinner--on-accent" /> {addProg || "Загружаю…"}</> : addFiles.length ? `Загрузить ${addFiles.length}` : "Выберите файлы"}</button>
      </Drawer>

      <Drawer open={!!view} onClose={() => !viewBusy && setView(null)} title={view?.name || "Отчёт"}>
        {viewBusy && !viewText ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13 }}><span className="spinner" /> Расшифровываю…</div> : <>
          <textarea style={{ ...input, minHeight: 300, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} value={viewText} onChange={(e) => setViewText(e.target.value)} />
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button style={{ ...btn, flexGrow: 1, opacity: viewBusy ? 0.7 : 1 }} disabled={viewBusy} onClick={saveEdit}>{viewBusy ? <span className="spinner spinner--on-accent" /> : "Сохранить"}</button>
            <button style={ghost} onClick={() => view && saveToDisk(/\./.test(view.name) ? view.name : view.name + ".txt", txtToB64(viewText))}>Скачать</button>
            <button style={{ ...ghost, color: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => view && del(view)}>Удалить</button>
          </div>
        </>}
      </Drawer>

      <Drawer open={!!fileView} onClose={() => setFileView(null)} title={fileView?.name || "Файл"}>
        {fileView && <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg></span>
            <div><div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)" }}>{fileView.name}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(fileView.at)} · {fmtSize(fileView.size)}</div></div>
          </div>
          {can("export") && <button style={{ ...btn, width: "100%", marginBottom: 10 }} onClick={() => downloadRec(fileView)}>Скачать</button>}
          {can("export") && <button style={{ ...ghost, width: "100%", marginBottom: 10 }} onClick={() => openFileInApp(fileView)}>Открыть в программе</button>}
          {can("delete") && <button style={{ ...ghost, width: "100%", color: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => del(fileView)}>Удалить</button>}
        </>}
      </Drawer>

      {sheet && <SheetEditor initial={sheet.bytes} name={sheet.name} saving={sheetSaving} onSave={saveSheet} onDownload={can("export") ? (b, n) => saveToDisk(n, bytesToB64(b)) : undefined} onOpenNative={sheet.id && can("export") ? () => openNative(sheet.id as string, sheet.name) : undefined} onClose={() => !sheetSaving && setSheet(null)} />}
      {doc && <DocEditor initial={doc.content} name={doc.name} saving={docSaving} onSave={saveDoc} onClose={() => !docSaving && setDoc(null)} />}
      {viewer && <FileViewer bytes={viewer.bytes} name={viewer.rec.name} saving={!!opening} onDownload={can("export") ? () => saveToDisk(viewer.rec.name, bytesToB64(viewer.bytes)) : undefined} onOpenNative={can("export") ? () => openNative(viewer.rec.id, viewer.rec.name) : undefined} onClose={() => setViewer(null)} />}
      {cmFor && <CommentsDrawer login={login} pw={pw} owner={login} rec={cmFor} onClose={() => setCmFor(null)} onPosted={reloadRecs} notify={notify} />}
      <ConfirmModal data={confirmData} onClose={() => setConfirmData(null)} />
      <Toast msg={toast} />
      {opening && <LoadingOverlay text={opening} />}
    </>
  );
}

function CategoriesSection({ masterLogin, pw, orgs }: { masterLogin: string; pw: string; orgs: string[] }) {
  const [org, setOrg] = useState(orgs[0] || "");
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [fname, setFname] = useState("");

  const load = async (o: string) => { if (!o) return; setLoading(true); try { setFolders(await invoke<string[]>("sv_cat_list", { login: masterLogin, password: pw, org: o })); } catch { /* */ } setLoading(false); };
  useEffect(() => { setPath(""); load(org); }, [org]);

  const join = (b: string, n: string) => (b ? b + "/" + n : n);
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const base = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
  const nodes = useMemo(() => { const set = new Set<string>(); folders.forEach((f) => { const segs = f.split("/"); let cur = ""; for (const s of segs) { cur = cur ? cur + "/" + s : s; set.add(cur); } }); return set; }, [folders]);
  const subs = useMemo(() => [...nodes].filter((f) => parentOf(f) === path).sort(), [nodes, path]);
  const crumbs = path ? path.split("/") : [];

  const create = async () => {
    if (!fname.trim()) { setNewFolder(false); return; }
    try { await invoke("sv_cat_make", { login: masterLogin, password: pw, org, path: join(path, fname.trim()) }); setFname(""); setNewFolder(false); load(org); }
    catch (e) { alert("" + String(e)); }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ ...h1s }}>Категории отчётов</h1>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>Папки, которые увидят директора и проверяющий этой организации</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ minWidth: 180 }}><Select value={org} onChange={setOrg} options={orgs.map((o) => ({ value: o, label: o }))} /></div>
          <button style={btn} onClick={() => { setNewFolder(true); setFname(""); }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            Папка
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 13, flexWrap: "wrap" }}>
        <button onClick={() => setPath("")} style={{ background: "transparent", border: "none", color: path ? "var(--accent-2)" : "var(--text)", fontWeight: 600, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          Корень
        </button>
        {crumbs.map((c, i) => { const p = crumbs.slice(0, i + 1).join("/"); const last = i === crumbs.length - 1; return <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ color: "var(--muted-2)" }}>/</span><button onClick={() => setPath(p)} style={{ background: "transparent", border: "none", color: last ? "var(--text)" : "var(--accent-2)", fontWeight: 600, fontSize: 13 }}>{c}</button></span>; })}
      </div>

      {newFolder && (
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <input autoFocus style={{ ...input, marginTop: 0, maxWidth: 320 }} value={fname} onChange={(e) => setFname(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="напр. Отчёты или Подотчётные средства" autoCapitalize="off" spellCheck={false} />
          <button style={btn} onClick={create}>Создать</button>
          <button style={ghost} onClick={() => setNewFolder(false)}>Отмена</button>
        </div>
      )}

      <div style={{ ...box, padding: 0, overflow: "hidden" }}>
        {loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
          : subs.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center" }}>
              <div style={{ width: 46, height: 46, borderRadius: 13, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface-2)", color: "var(--muted)" }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Нет папок</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>Создайте категории (напр. «Отчёты», «Подотчётные средства»), внутри — папки по годам/месяцам.</div>
            </div>
          ) : subs.map((f, i) => (
            <div key={f} className="row-hover" onClick={() => setPath(f)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", borderTop: i ? "1px solid var(--border-2)" : "none", cursor: "pointer" }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg>
              </span>
              <div style={{ flexGrow: 1, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{base(f)}</div>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
            </div>
          ))}
      </div>
    </>
  );
}

// ===================== Кабинет Проверяющего =====================
type RvProfile = { login: string; count: number; last_at: string; revoked: boolean };
type RvRec = { id: string; kind: string; name: string; size: number; folder: string; submitter: string; comments: number; at: string };
type RvRecent = { id: string; kind: string; name: string; owner_login: string; submitter: string; folder: string; at: string };
type CommentT = { author: string; text: string; at: string };

const within7d = (iso: string) => { const t = Date.parse(iso); return !isNaN(t) && t > Date.now() - 7 * 864e5; };

export function ReviewerHome({ info, pw, theme, onToggleTheme, onExit }: { info: MasterInfo; pw: string; theme: string; onToggleTheme: () => void; onExit: () => void }) {
  const login = info.login;
  const [section, setSection] = useState("dash");
  const [profiles, setProfiles] = useState<RvProfile[]>([]);
  const [recent, setRecent] = useState<RvRecent[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<RvProfile | null>(null);
  const can = (k: string) => hasPerm(info, k);
  // собственные отчёты проверяющего (вкладка «Мои отчёты», если есть право сдавать)
  const [ownRecs, setOwnRecs] = useState<DRec[]>([]);
  const [ownLoading, setOwnLoading] = useState(false);
  const [ownFolders, setOwnFolders] = useState<string[]>([]);
  const [ownPath, setOwnPath] = useState("");
  const loadOwn = async () => { setOwnLoading(true); try { setOwnRecs(await invoke<DRec[]>("sv_dir_list", { login, password: pw })); } catch { /* */ } setOwnLoading(false); };
  const loadOwnFolders = async () => { try { setOwnFolders(await invoke<string[]>("sv_dir_folders", { login, password: pw })); } catch { /* */ } };

  const load = async () => {
    setLoading(true);
    try {
      const [p, r] = await Promise.all([
        invoke<RvProfile[]>("sv_rv_profiles", { login, password: pw }),
        invoke<RvRecent[]>("sv_rv_recent", { login, password: pw }),
      ]);
      setProfiles(p); setRecent(r);
    } catch { /* */ }
    setLoading(false);
  };
  useEffect(() => { load(); if (can("submit")) { loadOwn(); loadOwnFolders(); } }, []);

  const totalFiles = useMemo(() => profiles.reduce((a, p) => a + p.count, 0), [profiles]);
  const activeWeek = useMemo(() => new Set(recent.filter((r) => within7d(r.at)).map((r) => r.owner_login)).size, [recent]);
  const lastAt = useMemo(() => profiles.map((p) => p.last_at).filter(Boolean).sort().slice(-1)[0] || "", [profiles]);
  const maxCount = Math.max(1, ...profiles.map((p) => p.count));

  const openDir = (owner: string) => { const p = profiles.find((x) => x.login === owner); if (p) setOpen(p); };

  const SideBtn = ({ id, label, icon }: { id: string; label: string; icon: React.ReactNode }) => (
    <button onClick={() => { setOpen(null); setSection(id); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", textAlign: "left", background: !open && section === id ? "var(--accent-tint)" : "transparent", color: !open && section === id ? "var(--accent-2)" : "var(--text-2)", fontSize: 13.5, fontWeight: 600 }}>
      <span style={{ display: "flex", width: 18 }}>{icon}</span>{label}
    </button>
  );

  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg)" }}>
      <div style={{ width: 236, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--sidebar)", display: "flex", flexDirection: "column", padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px 14px" }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent)", color: "#fff" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
          </span>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontSize: 14.5, fontWeight: 650, color: "var(--text)", letterSpacing: "-0.01em", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{info.org}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Проверяющий · {login}</div>
          </div>
        </div>
        <div style={{ height: 1, background: "var(--border-2)", margin: "0 4px 12px" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, overflow: "auto" }}>
          <SideBtn id="dash" label="Дашборд" icon={nic(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>)} />
          <SideBtn id="profiles" label="Профили" icon={nic(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>)} />
          {can("submit") && <SideBtn id="mine" label="Мои отчёты" icon={nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>)} />}
          <div style={{ height: 6 }} />
          {can("view_log") && <button onClick={() => { setOpen(null); setSection("log"); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", textAlign: "left", background: !open && section === "log" ? "var(--accent-tint)" : "transparent", color: !open && section === "log" ? "var(--accent-2)" : "var(--text-2)", fontSize: 13.5, fontWeight: 600 }}><span style={{ display: "flex", width: 18 }}>{nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>)}</span>Журнал</button>}
          <NavItem id="me" label="Мой профиль" active={!open && section === "me"} onClick={(id) => { setOpen(null); setSection(id); }} icon={nic(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>)} />
        </div>
        <button style={{ ...ghost, marginTop: "auto" }} onClick={onExit}>Выйти</button>
      </div>

      <div style={{ flexGrow: 1, overflow: "auto", padding: "28px 34px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          {open ? <RvProfileView info={info} pw={pw} director={open} onBack={() => { setOpen(null); load(); }} />
            : section === "mine" ? <DirReports login={login} pw={pw} info={info} recs={ownRecs} loading={ownLoading} reloadRecs={loadOwn} folders={ownFolders} reloadFolders={loadOwnFolders} path={ownPath} setPath={setOwnPath} />
            : section === "log" ? <JournalMine login={login} pw={pw} />
            : section === "me" ? <MeSection login={login} pw={pw} info={info} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} allowPassword={false} />
            : loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 30, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
              : section === "dash" ? (
                <>
                  <h1 style={{ ...h1s, marginBottom: 4 }}>Сводка</h1>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 22 }}>Обзор по всем директорам организации «{info.org}»</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16, marginBottom: 26 }}>
                    {[
                      ["sv-g1", "Директоров", String(profiles.length), <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>],
                      ["sv-g2", "Файлов всего", String(totalFiles), <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>],
                      ["sv-g3", "Активны за неделю", String(activeWeek), <><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></>],
                      ["sv-g4", "Последняя сдача", lastAt ? fmtDate(lastAt) : "—", <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>],
                    ].map(([cls, label, val, icon], i) => (
                      <div key={i as number} className={`sv-stat ${cls} sv-in sv-lift`} style={{ animationDelay: `${(i as number) * 70}ms` }}>
                        <span className="sv-ico"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>
                        <div className="sv-val">{val}</div>
                        <div className="sv-lab">{label}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, alignItems: "start" }}>
                    <div className="sv-in" style={{ ...box, padding: 20, animationDelay: "160ms" }}>
                      <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 6, height: 16, borderRadius: 3, background: "linear-gradient(#6366f1,#8b5cf6)" }} />Файлы по директорам</div>
                      {profiles.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Директоров пока нет.</div> : profiles.map((p, i) => (
                        <button key={p.login} onClick={() => setOpen(p)} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", border: "none", background: "transparent", padding: "8px 4px", borderRadius: 8, cursor: "pointer" }}>
                          <span style={{ width: 96, fontSize: 12.5, fontWeight: 600, color: "var(--text-2)", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.login}</span>
                          <span style={{ flexGrow: 1, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}><span className="sv-bar" style={{ display: "block", height: "100%", width: `${(p.count / maxCount) * 100}%`, borderRadius: 6, background: "linear-gradient(90deg,#6366f1,#8b5cf6)", animationDelay: `${200 + i * 60}ms` }} /></span>
                          <span style={{ width: 26, fontSize: 12.5, fontWeight: 700, color: "var(--text)", textAlign: "right" }}>{p.count}</span>
                        </button>
                      ))}
                    </div>

                    <div className="sv-in" style={{ ...box, padding: 20, animationDelay: "230ms" }}>
                      <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 6, height: 16, borderRadius: 3, background: "linear-gradient(#0ea5e9,#22d3ee)" }} />Последнее добавленное</div>
                      {recent.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Пока ничего не сдавали.</div> : recent.slice(0, 11).map((r) => (
                        <button key={r.id} onClick={() => openDir(r.owner_login)} className="sv-item" style={{ width: "100%", border: "none", background: "transparent", padding: "9px 6px", textAlign: "left" }}>
                          <span style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", background: r.kind === "file" ? "color-mix(in srgb, #0ea5e9 16%, transparent)" : "color-mix(in srgb, #10b981 16%, transparent)", color: r.kind === "file" ? "#0ea5e9" : "#10b981" }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{r.kind === "file" ? <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></> : <><path d="M4 4h16M4 10h16M4 16h10" /></>}</svg></span>
                          <span style={{ flexGrow: 1, minWidth: 0 }}><span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span><span style={{ display: "block", fontSize: 11, color: "var(--muted)" }}>{r.owner_login}{r.folder ? " · " + r.folder : ""} · {fmtDate(r.at)}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <h1 style={{ ...h1s, marginBottom: 4 }}>Профили директоров</h1>
                  <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 22 }}>Откройте профиль, чтобы смотреть файлы, добавлять и комментировать</div>
                  {profiles.length === 0 ? <div style={{ ...box, padding: "40px 20px", textAlign: "center", fontSize: 13.5, color: "var(--muted)" }}>Директоров в организации пока нет.</div> : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(238px, 1fr))", gap: 16 }}>
                      {profiles.map((p, i) => (
                        <button key={p.login} onClick={() => setOpen(p)} className="sv-in sv-lift" style={{ ...box, padding: 20, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 14, animationDelay: `${i * 55}ms` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                            <span style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${avatarGrad(p.login)})`, color: "#fff", fontWeight: 700, fontSize: 17 }}>{p.login.slice(0, 1).toUpperCase()}</span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.login}</div>
                              <div style={{ fontSize: 11.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5, color: p.revoked ? "var(--danger)" : "var(--green)" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />{p.revoked ? "отозван" : "активен"}</div>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 20, paddingTop: 2, borderTop: "1px solid var(--border-2)", marginTop: 2 }}>
                            <div style={{ paddingTop: 10 }}><div style={{ fontSize: 20, fontWeight: 760, color: "var(--text)", letterSpacing: "-0.02em" }}>{p.count}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>файлов</div></div>
                            <div style={{ paddingTop: 10 }}><div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-2)", marginTop: 4 }}>{p.last_at ? fmtDate(p.last_at) : "—"}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>последняя сдача</div></div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
        </div>
      </div>
    </div>
  );
}

// стабильный градиент аватара по строке
function avatarGrad(s: string): string {
  const palettes = [["#6366f1", "#8b5cf6"], ["#0ea5e9", "#22d3ee"], ["#10b981", "#34d399"], ["#f59e0b", "#f97316"], ["#ec4899", "#f43f5e"], ["#14b8a6", "#06b6d4"]];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const p = palettes[h % palettes.length];
  return `${p[0]},${p[1]}`;
}

function RvProfileView({ info, pw, director, onBack }: { info: MasterInfo; pw: string; director: RvProfile; onBack: () => void }) {
  const can = (k: string) => hasPerm(info, k);
  const login = info.login;
  const owner = director.login;
  const [recs, setRecs] = useState<RvRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [path, setPath] = useState("");
  const [grid, setGrid] = useState(false);
  const [opening, setOpening] = useState("");
  const [toast, setToast] = useState("");
  const [confirmData, setConfirmData] = useState<{ title: string; text: string; danger?: boolean; onYes: () => void } | null>(null);
  const [sheet, setSheet] = useState<{ id?: string; name: string; folder: string; bytes: Uint8Array | null } | null>(null);
  const [sheetSaving, setSheetSaving] = useState(false);
  const [doc, setDoc] = useState<{ id?: string; name: string; folder: string; content: string | null } | null>(null);
  const [docSaving, setDocSaving] = useState(false);
  const [viewer, setViewer] = useState<{ rec: RvRec; bytes: Uint8Array } | null>(null);
  const [view, setView] = useState<RvRec | null>(null);
  const [viewText, setViewText] = useState("");
  const [viewBusy, setViewBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addFiles, setAddFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [cmFor, setCmFor] = useState<RvRec | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3500); };

  const load = async () => { setLoading(true); try { setRecs(await invoke<RvRec[]>("sv_rv_list", { login, password: pw, owner })); } catch (e) { notify("" + String(e)); } setLoading(false); };
  useEffect(() => { load(); }, [owner]);

  const base = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
  const nodes = useMemo(() => { const s = new Set<string>(); recs.forEach((r) => { if (!r.folder) return; const seg = r.folder.split("/"); let cur = ""; for (const x of seg) { cur = cur ? cur + "/" + x : x; s.add(cur); } }); return s; }, [recs]);
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const subfolders = useMemo(() => [...nodes].filter((f) => parentOf(f) === path).sort(), [nodes, path]);
  const files = useMemo(() => recs.filter((r) => (r.folder || "") === path), [recs, path]);
  const folderCount = (f: string) => recs.filter((r) => (r.folder || "") === f || (r.folder || "").startsWith(f + "/")).length;
  const crumbs = path ? path.split("/") : [];

  const saveToDisk = async (name: string, b64: string) => { try { await invoke<string>("sv_save_file", { filename: name, contentB64: b64 }); notify("Сохранено в «Загрузки»: " + name); } catch (e) { notify("" + String(e)); } };
  const openNative = async (id: string, name: string) => { setOpening("Открываю в программе…"); try { await invoke("sv_rv_open_file", { login, password: pw, id, filename: name }); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const downloadRec = async (r: RvRec) => { setOpening("Готовлю файл…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: r.id }); await saveToDisk(r.name, b); } catch (e) { notify("" + String(e)); } setOpening(""); };

  const openRec = async (r: RvRec) => {
    if (r.kind === "file" && isDoc(r.name)) { setOpening("Открываю документ…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: r.id }); setDoc({ id: r.id, name: r.name, folder: r.folder || "", content: b64ToTxt(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file" && isSheet(r.name)) { setOpening("Открываю таблицу…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: r.id }); setSheet({ id: r.id, name: r.name, folder: r.folder || "", bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file" && isViewable(r.name)) { setOpening("Открываю файл…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: r.id }); setViewer({ rec: r, bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file") { setOpening("Открываю…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: r.id }); setViewer({ rec: r, bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    setView(r); setViewText(""); setViewBusy(true); setOpening("Расшифровываю…");
    try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: r.id }); setViewText(b64ToTxt(b)); } catch (e) { setViewText("Ошибка: " + String(e)); }
    setViewBusy(false); setOpening("");
  };

  const saveSheet = async (bytes: Uint8Array, name: string) => { if (!sheet) return; setSheetSaving(true); try { await invoke("sv_rv_submit", { login, password: pw, owner, folder: sheet.folder, title: name, kind: "file", contentB64: bytesToB64(bytes) }); if (sheet.id) await invoke("sv_rv_delete", { login, password: pw, id: sheet.id }); setSheet(null); load(); } catch (e) { notify("" + String(e)); } setSheetSaving(false); };
  const saveDoc = async (bytes: Uint8Array, name: string) => { if (!doc) return; setDocSaving(true); try { await invoke("sv_rv_submit", { login, password: pw, owner, folder: doc.folder, title: name, kind: "file", contentB64: bytesToB64(bytes) }); if (doc.id) await invoke("sv_rv_delete", { login, password: pw, id: doc.id }); setDoc(null); load(); } catch (e) { notify("" + String(e)); } setDocSaving(false); };
  const saveEdit = async () => { if (!view) return; setViewBusy(true); try { await invoke("sv_rv_submit", { login, password: pw, owner, folder: view.folder || "", title: view.name, kind: "report", contentB64: txtToB64(viewText) }); await invoke("sv_rv_delete", { login, password: pw, id: view.id }); setView(null); load(); } catch (e) { notify("" + String(e)); } setViewBusy(false); };
  const del = (r: RvRec) => setConfirmData({ title: "Удалить?", text: "«" + r.name + "» будет удалён без возможности восстановления.", danger: true, onYes: async () => { try { await invoke("sv_rv_delete", { login, password: pw, id: r.id }); setView(null); load(); } catch (e) { notify("" + String(e)); } } });
  const addUpload = async () => {
    if (!addFiles.length) return;
    setBusy(true);
    try { for (let i = 0; i < addFiles.length; i++) { setOpening(`Загружаю ${i + 1} из ${addFiles.length}…`); const b64 = await fileToB64(addFiles[i]); await invoke("sv_rv_submit", { login, password: pw, owner, folder: path, title: addFiles[i].name, kind: "file", contentB64: b64 }); } setAddFiles([]); setAddOpen(false); load(); } catch (e) { notify("" + String(e)); }
    setOpening(""); setBusy(false);
  };

  return (
    <>
      <button onClick={onBack} className="sv-back" style={{ marginBottom: 16 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>Все профили
      </button>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 46, height: 46, borderRadius: 13, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${avatarGrad(owner)})`, color: "#fff", fontWeight: 700, fontSize: 18 }}>{owner.slice(0, 1).toUpperCase()}</span>
          <div><h1 style={{ ...h1s }}>{owner}</h1><div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>Директор · {recs.length} файлов</div></div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
            <button onClick={() => setGrid(false)} style={{ padding: "8px 10px", background: !grid ? "var(--accent-tint)" : "transparent", border: "none", color: !grid ? "var(--accent-2)" : "var(--muted)", display: "flex" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg></button>
            <button onClick={() => setGrid(true)} style={{ padding: "8px 10px", background: grid ? "var(--accent-tint)" : "transparent", border: "none", color: grid ? "var(--accent-2)" : "var(--muted)", display: "flex" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg></button>
          </div>
          {can("edit") && <button style={btn} onClick={() => setAddOpen(true)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>Добавить</button>}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, fontSize: 13, flexWrap: "wrap" }}>
        <button onClick={() => setPath("")} style={{ background: "transparent", border: "none", color: path ? "var(--accent-2)" : "var(--text)", fontWeight: 600, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>Все папки</button>
        {crumbs.map((c, i) => { const p = crumbs.slice(0, i + 1).join("/"); const last = i === crumbs.length - 1; return <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ color: "var(--muted-2)" }}>/</span><button onClick={() => setPath(p)} style={{ background: "transparent", border: "none", color: last ? "var(--text)" : "var(--accent-2)", fontWeight: 600, fontSize: 13 }}>{c}</button></span>; })}
      </div>

      <div style={{ ...box, padding: 8 }}>
        {loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
          : subfolders.length === 0 && files.length === 0 ? <div style={{ padding: "40px 20px", textAlign: "center", fontSize: 13.5, color: "var(--muted)" }}>{path ? "В этой папке пусто" : "Директор ещё ничего не сдавал"}</div>
            : grid ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))", gap: 12, padding: 10 }}>
                {subfolders.map((f, i) => (
                  <div key={"gf" + f} className="sv-lift sv-in" onClick={() => setPath(f)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9, padding: "18px 10px", borderRadius: 13, border: "1px solid var(--border-2)", background: "var(--surface-2)", cursor: "pointer", textAlign: "center", animationDelay: `${i * 35}ms` }}>
                    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", wordBreak: "break-word" }}>{base(f)}</div>
                    <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{folderCount(f)} файл.</div>
                  </div>
                ))}
                {files.map((r, i) => (
                  <div key={"g" + r.id} className="sv-lift sv-in" onClick={() => openRec(r)} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 9, padding: "18px 10px", borderRadius: 13, border: "1px solid var(--border-2)", background: "var(--surface-2)", cursor: "pointer", textAlign: "center", animationDelay: `${(subfolders.length + i) * 35}ms` }}>
                    {r.comments > 0 && <span className="sv-badge" style={{ position: "absolute", top: 8, right: 8 }}>{r.comments}</span>}
                    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{r.kind === "file" ? <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></> : <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>}</svg>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", wordBreak: "break-word" }}>{r.name}</div>
                    <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{fmtDate(r.at)}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 2 }}>
              {subfolders.map((f) => (
                <div key={"f" + f} className="sv-item" onClick={() => setPath(f)}>
                  <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></svg></span>
                  <div style={{ flexGrow: 1, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{base(f)}</div>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>{folderCount(f)} файл.</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                </div>
              ))}
              {files.map((r) => (
                <div key={r.id} className="sv-item" onClick={() => openRec(r)}>
                  <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}>{r.kind === "file" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16M4 10h16M4 16h10" /></svg>}</span>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{r.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{fmtDate(r.at)} · {fmtSize(r.size)}{r.submitter && r.submitter !== owner ? " · добавил " + r.submitter : ""}</div>
                  </div>
                  {can("comments") && <button onClick={(e) => { e.stopPropagation(); setCmFor(r); }} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 5, background: r.comments > 0 ? "var(--accent-tint)" : "transparent", border: "none", color: r.comments > 0 ? "var(--accent-2)" : "var(--muted-2)", padding: "6px 9px", borderRadius: 8, fontSize: 12.5, fontWeight: 700 }} title="Комментарии"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>{r.comments > 0 ? r.comments : ""}</button>}
                  {can("delete") && <button onClick={(e) => { e.stopPropagation(); del(r); }} style={{ background: "transparent", border: "none", color: "var(--muted-2)", padding: 6, borderRadius: 8 }} title="Удалить"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg></button>}
                </div>
              ))}
            </div>}
      </div>

      <input ref={addInput} type="file" multiple style={{ display: "none" }} onChange={(e) => { const fs = Array.from(e.target.files || []); setAddFiles((prev) => [...prev, ...fs]); if (e.target) e.target.value = ""; }} />

      <Drawer open={addOpen} onClose={() => !busy && setAddOpen(false)} title="Добавить директору">
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>В папку: <b style={{ color: "var(--text-2)" }}>{path || "Все папки"}</b> директора <b style={{ color: "var(--text-2)" }}>{owner}</b>.</div>
        <button type="button" onClick={() => addInput.current?.click()} disabled={busy} style={{ display: "block", width: "100%", border: "2px dashed var(--accent)", borderRadius: 13, padding: "26px 16px", textAlign: "center", background: "var(--accent-tint)", cursor: busy ? "default" : "pointer", color: "var(--accent-2)", opacity: busy ? 0.6 : 1 }}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
          <div style={{ fontSize: 14, fontWeight: 650, marginTop: 8 }}>Нажмите, чтобы выбрать файлы</div>
        </button>
        {addFiles.length > 0 && <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>{addFiles.map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface-2)" }}>
            <div style={{ flexGrow: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>{fmtSize(f.size)}</div></div>
            {!busy && <button onClick={() => setAddFiles((prev) => prev.filter((_, j) => j !== i))} style={{ background: "transparent", border: "none", color: "var(--muted-2)", padding: 4 }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg></button>}
          </div>
        ))}</div>}
        <button style={{ ...btn, width: "100%", marginTop: 18, opacity: busy || !addFiles.length ? 0.6 : 1 }} disabled={busy || !addFiles.length} onClick={addUpload}>{busy ? <><span className="spinner spinner--on-accent" /> Загружаю…</> : addFiles.length ? `Загрузить ${addFiles.length}` : "Выберите файлы"}</button>
      </Drawer>

      <Drawer open={!!view} onClose={() => !viewBusy && setView(null)} title={view?.name || "Отчёт"}>
        {viewBusy && !viewText ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13 }}><span className="spinner" /> Расшифровываю…</div> : <>
          <textarea style={{ ...input, minHeight: 300, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} value={viewText} onChange={(e) => setViewText(e.target.value)} />
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button style={{ ...btn, flexGrow: 1, opacity: viewBusy ? 0.7 : 1 }} disabled={viewBusy} onClick={saveEdit}>{viewBusy ? <span className="spinner spinner--on-accent" /> : "Сохранить"}</button>
            <button style={{ ...ghost, color: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => view && del(view)}>Удалить</button>
          </div>
        </>}
      </Drawer>

      {cmFor && <CommentsDrawer login={login} pw={pw} owner={owner} rec={cmFor} onClose={() => setCmFor(null)} onPosted={load} notify={notify} />}
      {sheet && <SheetEditor initial={sheet.bytes} name={sheet.name} saving={sheetSaving} onSave={saveSheet} onDownload={can("export") ? (b, n) => saveToDisk(n, bytesToB64(b)) : undefined} onOpenNative={sheet.id && can("export") ? () => openNative(sheet.id as string, sheet.name) : undefined} onClose={() => !sheetSaving && setSheet(null)} />}
      {doc && <DocEditor initial={doc.content} name={doc.name} saving={docSaving} onSave={saveDoc} onClose={() => !docSaving && setDoc(null)} />}
      {viewer && <FileViewer bytes={viewer.bytes} name={viewer.rec.name} saving={!!opening} onDownload={can("export") ? () => downloadRec(viewer.rec) : undefined} onOpenNative={can("export") ? () => openNative(viewer.rec.id, viewer.rec.name) : undefined} onClose={() => setViewer(null)} />}
      <ConfirmModal data={confirmData} onClose={() => setConfirmData(null)} />
      <Toast msg={toast} />
      {opening && <LoadingOverlay text={opening} />}
    </>
  );
}

function CommentsDrawer({ login, pw, owner, rec, onClose, onPosted, notify }: { login: string; pw: string; owner: string; rec: { id: string; name: string }; onClose: () => void; onPosted?: () => void; notify: (m: string) => void }) {
  const [list, setList] = useState<CommentT[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => { setLoading(true); try { setList(await invoke<CommentT[]>("sv_cm_list", { login, password: pw, recordId: rec.id })); } catch (e) { notify("" + String(e)); } setLoading(false); };
  useEffect(() => { load(); }, [rec.id]);
  const send = async () => { if (!text.trim()) return; setBusy(true); try { await invoke("sv_cm_add", { login, password: pw, recordId: rec.id, owner, text: text.trim() }); setText(""); await load(); onPosted?.(); } catch (e) { notify("" + String(e)); } setBusy(false); };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } };
  return (
    <Drawer open onClose={() => !busy && onClose()} title="Комментарии">
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 11, background: "var(--surface-2)", border: "1px solid var(--border-2)", marginBottom: 14 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></span>
        <div style={{ minWidth: 0 }}><div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rec.name}</div><div style={{ fontSize: 11.5, color: "var(--muted)" }}>{list.length ? `${list.length} комментар.` : "обсуждение файла"}</div></div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16, maxHeight: "52vh", overflow: "auto", padding: "2px 2px 4px" }}>
        {loading ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13, padding: 8 }}><span className="spinner" /> Загрузка…</div>
          : list.length === 0 ? (
            <div style={{ textAlign: "center", padding: "28px 16px", color: "var(--muted)" }}>
              <div style={{ width: 46, height: 46, borderRadius: 13, margin: "0 auto 10px", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg></div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>Пока нет комментариев</div>
              <div style={{ fontSize: 12, marginTop: 3 }}>Напишите первым — переписка видна вам и проверяющему.</div>
            </div>
          )
            : list.map((c, i) => {
              const mine = c.author === login;
              return (
                <div key={i} style={{ display: "flex", flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-end", gap: 8 }}>
                  <span style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${avatarGrad(c.author)})`, color: "#fff", fontSize: 11.5, fontWeight: 700 }}>{c.author.slice(0, 1).toUpperCase()}</span>
                  <div style={{ maxWidth: "78%", background: mine ? "var(--accent)" : "var(--surface-2)", color: mine ? "#fff" : "var(--text-2)", border: mine ? "none" : "1px solid var(--border-2)", borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, padding: "9px 12px" }}>
                    <div style={{ fontSize: 11, fontWeight: 650, opacity: mine ? 0.85 : 1, color: mine ? "#fff" : "var(--text)", marginBottom: 3 }}>{mine ? "Вы" : c.author}</div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.text}</div>
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4, textAlign: "right" }}>{fmtDate(c.at)}</div>
                  </div>
                </div>
              );
            })}
      </div>
      <textarea style={{ ...input, minHeight: 84, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Написать комментарий…  (⌘/Ctrl + Enter — отправить)" />
      <button style={{ ...btn, width: "100%", marginTop: 10, opacity: busy || !text.trim() ? 0.6 : 1 }} disabled={busy || !text.trim()} onClick={send}>{busy ? <><span className="spinner spinner--on-accent" /> Отправляю…</> : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>Отправить</>}</button>
    </Drawer>
  );
}

// ===================== Журнал собственных действий =====================
type LogEnt = { action: string; target: string; at: string };
const logMeta = (a: string): { label: string; color: string; icon: React.ReactNode } => {
  switch (a) {
    case "submit": return { label: "Сдан отчёт", color: "#10b981", icon: <><path d="M12 5v14M5 12h14" /></> };
    case "add": return { label: "Добавлен файл", color: "#0ea5e9", icon: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></> };
    case "delete": return { label: "Удалено", color: "#f43f5e", icon: <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></> };
    case "comment": return { label: "Комментарий", color: "#8b5cf6", icon: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></> };
    default: return { label: a, color: "var(--muted)", icon: <><circle cx="12" cy="12" r="9" /></> };
  }
};

function JournalMine({ login, pw }: { login: string; pw: string }) {
  const [items, setItems] = useState<LogEnt[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => { try { setItems(await invoke<LogEnt[]>("sv_mylog", { login, password: pw })); } catch { /* */ } setLoading(false); })(); }, []);
  return (
    <>
      <h1 style={{ ...h1s, marginBottom: 4 }}>Журнал действий</h1>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 20 }}>Ваши действия: что сдавали, меняли, комментировали</div>
      <div style={{ ...box, padding: 8 }}>
        {loading ? <div style={{ fontSize: 13, color: "var(--muted)", padding: 20, display: "flex", alignItems: "center", gap: 8 }}><span className="spinner" /> Загрузка…</div>
          : items.length === 0 ? <div style={{ padding: "40px 20px", textAlign: "center", fontSize: 13.5, color: "var(--muted)" }}>Пока нет записей. Действия появятся здесь автоматически.</div>
            : <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 2 }}>
              {items.map((e, i) => { const m = logMeta(e.action); return (
                <div key={i} className="sv-item" style={{ cursor: "default" }}>
                  <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${m.color} 16%, transparent)`, color: m.color }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{m.icon}</svg></span>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{m.label}{e.target ? <span style={{ fontWeight: 400, color: "var(--text-2)" }}> · {e.target}</span> : ""}</div>
                  </div>
                  <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtDate(e.at)}</span>
                </div>
              ); })}
            </div>}
      </div>
    </>
  );
}
