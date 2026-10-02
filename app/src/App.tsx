import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { MasterActivate, MasterHome, DirectorHome, ReviewerHome, MasterInfo, AuthShell } from "./MasterAccount";

type Theme = "dark" | "light";
type Method = "password" | "usb" | "yubikey";
type Methods = { password: boolean; usb: boolean; yubikey: boolean };

const ic = (p: React.ReactNode) => <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;
const SunIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
const MoonIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;

function MethodTile({ m, label, avail, selected, onPick, icon }: { m: Method; label: string; avail: boolean; selected: boolean; onPick: (m: Method) => void; icon: React.ReactNode }) {
  return (
    <button type="button" disabled={!avail} onClick={() => avail && onPick(m)}
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, padding: "11px 6px", borderRadius: 10, cursor: avail ? "pointer" : "not-allowed", border: "1px solid " + (selected ? "var(--accent)" : "var(--border)"), background: selected ? "var(--accent-tint)" : "transparent", color: selected ? "var(--accent-2)" : "var(--muted)", opacity: avail ? 1 : 0.45 }}>
      {icon}
      <span style={{ fontSize: 12, fontWeight: 600, color: avail ? "var(--text)" : "var(--muted)" }}>{label}</span>
      <span style={{ fontSize: 10, color: avail ? "var(--green)" : "var(--muted-2)" }}>{avail ? "доступно" : "нет"}</span>
    </button>
  );
}

function Login({ onLogin, onActivate, busy, error }: { onLogin: (login: string, pw: string, code: string) => void; onActivate: () => void; busy: boolean; error: string }) {
  const [method, setMethod] = useState<Method>("password");
  const [methods, setMethods] = useState<Methods>({ password: true, usb: false, yubikey: false });
  const [login, setLogin] = useState("");
  const [pw, setPw] = useState("");
  const [configured, setConfigured] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    const poll = () => invoke<Methods>("sv_auth_methods").then(setMethods).catch(() => {});
    poll(); const t = setInterval(poll, 4000); return () => clearInterval(t);
  }, []);
  useEffect(() => { invoke<boolean>("sv_conn_status").then(setConfigured).catch(() => {}); }, []);
  useEffect(() => { if ((method === "usb" && !methods.usb) || (method === "yubikey" && !methods.yubikey)) setMethod("password"); }, [methods]);

  const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", marginTop: 6, padding: "11px 13px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 9, color: "var(--text)", fontSize: 14.5, outline: "none" };
  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 560, color: "var(--muted)" };
  const codeOpen = !configured || showCode;
  const submit = () => onLogin(login, pw, codeOpen ? code : "");

  return (
    <AuthShell>
      <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.015em", color: "var(--text)" }}>Вход</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 3, marginBottom: 22 }}>Сотрудники и администраторы</div>

      {codeOpen && (
        <div style={{ marginBottom: 16, padding: 14, borderRadius: 11, border: "1px solid var(--accent)", background: "var(--accent-tint)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            <span style={{ fontSize: 12.5, fontWeight: 650, color: "var(--accent-2)" }}>Код подключения</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45, marginBottom: 8 }}>Вводится один раз — выдаёт администратор. Дальше только логин и пароль.</div>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={{ ...inp, marginTop: 0, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} placeholder="SV1...." autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {configured && <button type="button" onClick={() => { setShowCode(false); setCode(""); }} style={{ marginTop: 8, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer" }}>Отмена</button>}
        </div>
      )}

      <label style={lbl}>Логин</label>
      <input value={login} onChange={(e) => setLogin(e.target.value)} style={inp} placeholder="логин" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <div style={{ height: 12 }} />
      <label style={lbl}>Пароль</label>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && submit()} style={inp} />

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <MethodTile m="password" label="Пароль" avail={methods.password} selected={method === "password"} onPick={setMethod} icon={ic(<><path d="M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r="1" fill="currentColor" stroke="none" /></>)} />
        <MethodTile m="usb" label="Флешка" avail={methods.usb} selected={method === "usb"} onPick={setMethod} icon={ic(<><rect x="7.5" y="8" width="9" height="13" rx="2" /><path d="M10 8V4.5h4V8" /><path d="M12 12.5v4" /></>)} />
        <MethodTile m="yubikey" label="YubiKey" avail={methods.yubikey} selected={method === "yubikey"} onPick={setMethod} icon={ic(<><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" /><circle cx="8" cy="12" r="2" /></>)} />
      </div>

      <button type="button" disabled={busy} onClick={submit} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, width: "100%", padding: 13, background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 9, fontWeight: 600, fontSize: 14.5, boxShadow: "0 8px 22px rgba(94,106,210,0.35)", opacity: busy ? 0.85 : 1 }}>
        {busy ? <><span className="spinner spinner--on-accent" /> Вход…</> : <>Войти<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></>}
      </button>
      {error && <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--danger)", textAlign: "center" }}>{error}</div>}

      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border-2)", display: "flex", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
        <button type="button" onClick={onActivate} title="Разовая настройка компании — только для владельца" style={{ background: "transparent", border: "none", color: "var(--muted-2)", fontSize: 12, fontWeight: 560, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          Создать организацию
        </button>
        {configured && !showCode && (
          <button type="button" onClick={() => setShowCode(true)} style={{ background: "transparent", border: "none", color: "var(--muted-2)", fontSize: 12, fontWeight: 560, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg>
            Ввести код подключения
          </button>
        )}
      </div>
    </AuthShell>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>("light");
  const [authView, setAuthView] = useState<"login" | "activate" | "home">("login");
  const [master, setMaster] = useState<{ info: MasterInfo; pw: string } | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleLogin = async (login: string, pw: string, code: string) => {
    if (!login.trim()) { setLoginError("Введите логин"); return; }
    if (!pw) { setLoginError("Введите пароль"); return; }
    setLoginBusy(true); setLoginError("");
    try {
      if (code.trim()) { await invoke("sv_connect_code", { code: code.trim(), password: pw }); }
      const info = await invoke<MasterInfo>("sv_login", { login, password: pw });
      setMaster({ info, pw }); setAuthView("home");
    } catch (e) { setLoginError("" + String(e)); }
    setLoginBusy(false);
  };

  const inHome = authView === "home" && !!master;

  let body: React.ReactNode;
  if (authView === "login") body = <Login busy={loginBusy} error={loginError} onLogin={handleLogin} onActivate={() => { setLoginError(""); setAuthView("activate"); }} />;
  else if (authView === "activate") body = <MasterActivate onDone={(info, pw) => { setMaster({ info, pw }); setAuthView("home"); }} onExit={() => setAuthView("login")} />;
  else if (master) body = master.info.role === "master"
    ? <MasterHome info={master.info} pw={master.pw} theme={theme} onToggleTheme={toggleTheme} onExit={() => { setMaster(null); setAuthView("login"); }} />
    : master.info.role === "reviewer"
      ? <ReviewerHome info={master.info} pw={master.pw} theme={theme} onToggleTheme={toggleTheme} onExit={() => { setMaster(null); setAuthView("login"); }} />
      : <DirectorHome info={master.info} pw={master.pw} theme={theme} onToggleTheme={toggleTheme} onExit={() => { setMaster(null); setAuthView("login"); }} />;

  return (
    <div style={{ height: "100%", position: "relative" }}>
      {body}
      {!inHome && <button className="theme-fab" aria-label="Сменить тему" onClick={toggleTheme}>{theme === "dark" ? <SunIcon /> : <MoonIcon />}</button>}
    </div>
  );
}
