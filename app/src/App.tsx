import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { MasterActivate, MasterHome, DirectorHome, ReviewerHome, MasterInfo, AuthShell, LoadingOverlay, SvLogo } from "./MasterAccount";
import { prefsLoad, prefsCached, prefsSet } from "./prefs";

type Theme = "dark" | "light";
type Method = "password" | "usb" | "yubikey";
type Methods = { password: boolean; usb: boolean; yubikey: boolean };

const ic = (p: React.ReactNode) => <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;
const SunIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
const MoonIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;

function MethodTile({ m, label, avail, selected, onPick, icon }: { m: Method; label: string; avail: boolean; selected: boolean; onPick: (m: Method) => void; icon: React.ReactNode }) {
  return (
    <button type="button" disabled={!avail} onClick={() => avail && onPick(m)} className={"sv-mt" + (selected ? " on" : "") + (avail ? "" : " off")}>
      {icon}
      <b>{label}</b>
      <s>{avail ? "доступно" : "скоро"}</s>
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

  const codeOpen = !configured || showCode;
  const submit = () => onLogin(login, pw, codeOpen ? code : "");

  return (
    <AuthShell>
      <SvLogo>
        <span className="sv-zk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>zero-knowledge</span>
      </SvLogo>

      {codeOpen && (
        <div style={{ marginBottom: 14, padding: 14, borderRadius: 14, border: "1px solid var(--accent)", background: "var(--accent-tint)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            <span style={{ fontSize: 12.5, fontWeight: 650, color: "var(--accent-2)" }}>Код подключения</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.45, marginBottom: 9 }}>Вводится один раз — выдаёт администратор. Дальше только логин и пароль.</div>
          <input className="sv-inp plain" value={code} onChange={(e) => setCode(e.target.value)} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} placeholder="SV1…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {configured && <button type="button" onClick={() => { setShowCode(false); setCode(""); }} style={{ marginTop: 8, background: "transparent", border: "none", color: "var(--muted)", fontSize: 11.5, cursor: "pointer" }}>Отмена</button>}
        </div>
      )}

      <div className="sv-field"><span className="sv-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></span>
        <input className="sv-inp" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Логин" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
      <div className="sv-field"><span className="sv-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg></span>
        <input className="sv-inp" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && submit()} placeholder="Пароль" /></div>

      <div className="sv-methods">
        <MethodTile m="password" label="Пароль" avail={methods.password} selected={method === "password"} onPick={setMethod} icon={ic(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>)} />
        <MethodTile m="usb" label="Флешка" avail={methods.usb} selected={method === "usb"} onPick={setMethod} icon={ic(<><rect x="7.5" y="8" width="9" height="13" rx="2" /><path d="M10 8V4.5h4V8" /><path d="M12 12.5v4" /></>)} />
        <MethodTile m="yubikey" label="YubiKey" avail={methods.yubikey} selected={method === "yubikey"} onPick={setMethod} icon={ic(<><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" /><circle cx="8" cy="12" r="2" /></>)} />
      </div>

      <button type="button" className="sv-cta" disabled={busy} onClick={submit} style={{ marginTop: 14 }}>
        {busy ? <><span className="spinner spinner--on-accent" /> Вход…</> : <>Войти<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></>}
      </button>
      {error && <div className="sv-err">{error}</div>}

      <div className="sv-secure"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>Соединение защищено · WireGuard + mTLS</div>

      <div className="sv-foot">
        <button type="button" onClick={onActivate} title="Разовая настройка компании — только для владельца">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>Создать организацию
        </button>
        {configured && !showCode && (
          <button type="button" onClick={() => setShowCode(true)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16" /></svg>Ввести код подключения
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
  // настройки хранятся на сервере (зашифрованы): при входе восстанавливаем тему аккаунта
  useEffect(() => {
    if (!master) return;
    const apply = (p: { theme?: string }) => setTheme(p.theme === "dark" ? "dark" : "light");
    apply(prefsCached(master.info.login));
    prefsLoad(master.info.login, master.pw).then(apply).catch(() => { /* */ });
  }, [master]);
  const toggleTheme = () => setTheme((t) => {
    const nt: Theme = t === "dark" ? "light" : "dark";
    if (master) prefsSet(master.info.login, master.pw, { theme: nt });
    return nt;
  });

  const handleLogin = async (login: string, pw: string, code: string) => {
    if (!login.trim()) { setLoginError("Введите логин"); return; }
    if (!pw) { setLoginError("Введите пароль"); return; }
    setLoginBusy(true); setLoginError("");
    try {
      if (code.trim()) { await invoke("sv_connect_code", { code: code.trim(), password: pw }); }
      const info = await invoke<MasterInfo>("sv_login", { login, password: pw });
      try { await prefsLoad(info.login, pw); } catch { /* */ }
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
    : (master.info.perms || []).includes("view_all")
      ? <ReviewerHome info={master.info} pw={master.pw} theme={theme} onToggleTheme={toggleTheme} onExit={() => { setMaster(null); setAuthView("login"); }} />
      : <DirectorHome info={master.info} pw={master.pw} theme={theme} onToggleTheme={toggleTheme} onExit={() => { setMaster(null); setAuthView("login"); }} />;

  return (
    <div style={{ height: "100%", position: "relative" }}>
      {body}
      {!inHome && <button className="theme-fab" aria-label="Сменить тему" onClick={toggleTheme}>{theme === "dark" ? <SunIcon /> : <MoonIcon />}</button>}
      {loginBusy && <LoadingOverlay text="Входим…" />}
    </div>
  );
}
