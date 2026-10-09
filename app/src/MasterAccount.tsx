import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import logoWhite from "./assets/logo-dark.png";
import logoInk from "./assets/logo-light.png";
import logoMark from "./assets/logo-icon.png";
import { SheetEditor } from "./SheetEditor";
import { DocEditor } from "./DocEditor";
import { FileViewer } from "./FileViewer";
import { prefsCached, prefsSet, toggleFav } from "./prefs";

export type Profile = { name: string; role: string; method: string; age_public: string; cert_serial: string; revoked: boolean };
export type License = { org: string; kind: string; exp: number; valid: boolean; reason: string };
export type RoleDef = { key: string; name: string; perms: string[] };
export type MasterInfo = { org: string; login: string; server: string; role: string; profiles: Profile[]; roles: RoleDef[]; orgs: string[]; me_name: string; me_company: string; perms: string[]; license: License | null };
export const hasPerm = (info: MasterInfo, k: string) => (info.perms || []).includes(k);

// каталог прав (ключ → подпись), сгруппирован. Управление профилями/ролями/организацией — только у мастера, здесь не выдаётся.
const PERMS: { group: string; items: { key: string; label: string }[] }[] = [
  { group: "Данные", items: [
    { key: "submit", label: "Сдавать отчёты" },
    { key: "view_all", label: "Видеть все данные" },
    { key: "review", label: "Проверять отчёты (принять / на доработку)" },
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

const nic = (p: React.ReactNode, sz = 17) => <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{p}</svg>;
const b64ToTxt = (b: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))); } catch { return ""; } };
const fileToB64 = (file: File): Promise<string> => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const s = r.result as string; res(s.slice(s.indexOf(",") + 1)); }; r.onerror = rej; r.readAsDataURL(file); });
const b64ToBytes = (b: string) => { try { return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(); } };
const bytesToB64 = (bytes: Uint8Array) => { let bin = ""; const ch = 0x8000; for (let i = 0; i < bytes.length; i += ch) bin += String.fromCharCode(...bytes.subarray(i, i + ch)); return btoa(bin); };
const txtToB64 = (s: string) => bytesToB64(new TextEncoder().encode(s));
const isSheet = (name: string) => /\.(xlsx|xls|csv)$/i.test(name);
const isDoc = (name: string) => /\.svdoc$/i.test(name);
const isViewable = (name: string) => /\.(pdf|docx|txt|md|log|json|xml|png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name);
const fmtSize = (n: number) => (n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
const fmtGB = (n: number) => (n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(0)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1073741824).toFixed(1)} ГБ`);
const fmtDate = (s: string) => { try { return new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return s; } };
type DRec = { id: string; kind: string; name: string; size: number; folder: string; comments: number; at: string; status: string };
type DTrash = { id: string; name: string; folder: string; size: number; deleted_at: string };
type DVersion = { id: string; name: string; size: number; at: string; status: string; submitter: string; current: boolean };
type CommentT = { author: string; author_name?: string; text: string; at: string };
type Audit = { action: string; target: string; org: string; at: string };
const ACTIONS: Record<string, { label: string; tone: "accent" | "green" | "danger" | "muted" }> = {
  profile_created: { label: "Создан профиль", tone: "green" },
  password_reset: { label: "Сброшен пароль", tone: "accent" },
  revoked: { label: "Отозван доступ", tone: "danger" },
  restored: { label: "Восстановлен доступ", tone: "green" },
  org_renamed: { label: "Переименована организация", tone: "muted" },
  quota_set: { label: "Изменён лимит места", tone: "accent" },
  perms_changed: { label: "Изменены права", tone: "accent" },
  deadline_set: { label: "Изменён срок сдачи", tone: "accent" },
};
type RvProfile = { login: string; display_name: string; count: number; bytes: number; quota_bytes: number; last_at: string; revoked: boolean; review: number; fix: number };
type RvQueue = { id: string; kind: string; name: string; size: number; folder: string; owner_login: string; owner_name: string; submitter: string; comments: number; at: string };
type RvRecent = { id: string; kind: string; name: string; owner_login: string; submitter: string; folder: string; at: string };
type ApRow = { id: string; kind: string; requester: string; requester_name: string; status: string; created_at: string; decided_by: string; used: boolean };
const apKind = (k: string) => k === "download_all" ? "Скачать все данные" : k === "bulk_delete" ? "Массовое удаление" : k;
type RvAct = { actor: string; actor_name: string; action: string; target: string; at: string; rid: string };
type Draft = { org: string; login: string; role: string };
type ServerCheck = { ok: boolean; service: string; version: string; license_used: boolean; login_taken: boolean };

// Двухпанельная оболочка для входа/активации: бренд слева, форма справа (десктоп-вид, без «одинокой карточки»)
export function SvLogo({ w = 184, children }: { w?: number; children?: React.ReactNode }) {
  return <div className="sv-logo">
    <img className="for-dark" src={logoWhite} alt="SecureVault" style={{ width: w }} />
    <img className="for-light" src={logoInk} alt="SecureVault" style={{ width: w }} />
    {children}
  </div>;
}

export function AuthShell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="sv-auth">
      <div className="sv-scene"><span className="sv-sheen" /><span className="sv-orb a" /><span className="sv-orb b" /><span className="sv-orb c" /><span className="sv-orb d" /><span className="sv-dots" /></div>
      <div className={"sv-authcard" + (wide ? " wide" : "")}>{children}</div>
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

  const okd = <span className="d"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg></span>;
  const warnIco = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>;

  return (
    <AuthShell wide>
      <SvLogo w={146} />
      <div className="sv-eyebrow">Создание организации</div>
      <div className="sv-steps">
        <div className={"s" + (step === 0 ? " active" : step > 0 ? " done" : "")}><span className="n">1</span><span className="t">Аккаунт</span></div>
        <span className={"ln" + (step >= 1 ? " fill" : "")} />
        <div className={"s" + (step === 1 ? " active" : step > 1 ? " done" : "")}><span className="n">2</span><span className="t">Где хранить</span></div>
        <span className={"ln" + (step >= 2 ? " fill" : "")} />
        <div className={"s" + (step === 2 ? " active" : "")}><span className="n">3</span><span className="t">Сервер</span></div>
      </div>

      {step === 0 && <>
        <div className="sv-h1 left">Мастер-аккаунт</div>
        <div className="sv-sub left">Главный аккаунт организации. Шифруется вашим паролем — создаётся прямо на этом компьютере.</div>
        <label className="sv-lbl">Код лицензии</label>
        <div className="sv-field" style={{ position: "relative" }}>
          <input className="sv-inp plain" value={license} onChange={(e) => { setLicense(e.target.value); checkLicense(e.target.value); }} placeholder="вставьте код лицензии…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          {checking && <span className="spinner" style={{ position: "absolute", right: 14, top: 17 }} />}
        </div>
        {licErr && <div className="sv-badline">✗ {licErr}</div>}
        {licInfo && !licErr && licUsed && <div className="sv-badline">✗ Этот код уже активирован — развернуть повторно нельзя.</div>}
        {licInfo && !licErr && !licUsed && (licInfo.valid
          ? <div className="sv-okline">{okd}Ключ действителен · {licText(licInfo)}</div>
          : <div className="sv-badline">✗ {licInfo.reason || "недействителен"}</div>)}
        <div style={{ height: 14 }} />
        <label className="sv-lbl">Название организации</label>
        <div className="sv-field"><input className="sv-inp plain" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="напр. Моя компания" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
        <div className="sv-two">
          <div><label className="sv-lbl">Логин мастера</label><div className="sv-field" style={{ margin: 0 }}><input className="sv-inp plain" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="напр. master" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div></div>
          <div><label className="sv-lbl">Пароль</label><div className="sv-field" style={{ margin: 0 }}><input className="sv-inp plain" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div></div>
        </div>
        <div style={{ height: 12 }} />
        <label className="sv-lbl">Повторите пароль</label><div className="sv-field"><input className="sv-inp plain" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
        <div className="sv-warn">{warnIco}<span><b>Запомните пароль.</b> Аккаунт шифруется им — без пароля его не открыть даже нам. Пока всё создаётся на этом компьютере; загрузим на сервер на последнем шаге.</span></div>
        <div className="sv-rowbtns">
          <button className="sv-cta" disabled={busy || !licenseOk} onClick={prepare}>{busy ? <><span className="spinner spinner--on-accent" /> Создаю…</> : "Далее →"}</button>
          <button className="sv-ghost" onClick={onExit} disabled={busy}>Отмена</button>
        </div>
      </>}

      {step === 1 && <>
        <div className="sv-h1 left">Где хранить данные</div>
        <div className="sv-sub left">Аккаунт «{draft?.org}» создан локально. Выберите, где будут храниться зашифрованные данные — в обоих режимах мы их не видим.</div>
        <div className="sv-copt dis"><span className="soon">СКОРО</span><span className="ci2"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg></span><div><div className="ct">Наше облако (SaaS)</div><div className="cd">Хостинг на нашей стороне, обслуживание на нас. Будет доступно позже.</div></div></div>
        <button type="button" className="sv-copt on" onClick={() => setStep(2)}><span className="ci2"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg></span><div><div className="ct">Свой сервер (self-host)</div><div className="cd">Данные на вашем сервере — полный контроль. Нужен Linux-сервер с доступом из интернета.</div></div></button>
        <div className="sv-rowbtns"><button className="sv-ghost" onClick={onExit}>Отмена</button><button className="sv-cta" onClick={() => setStep(2)}>Далее →</button></div>
      </>}

      {step === 2 && <>
        <div className="sv-h1 left">Свой сервер</div>
        <div className="sv-sub left">Установите сервер и укажите его адрес — аккаунт загрузится туда зашифрованным.</div>
        <div className="sv-cmdstep">1. Установите сервер SecureVault</div>
        <div className="sv-cmdbox"><code>{cmd}</code><button className="cp" onClick={() => navigator.clipboard?.writeText(cmd)}>Копировать</button></div>
        <div className="sv-plat">Linux<span className="dim">· Windows (скоро)</span><span className="dim">· macOS (скоро)</span></div>
        <div className="sv-cmdstep">2. Укажите адрес сервера</div>
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <div className="sv-field" style={{ flex: 1, margin: 0 }}><input className="sv-inp plain" value={server} onChange={(e) => { setServer(e.target.value); setSrv(null); }} placeholder="https://ваш-домен:8088" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>
          <button className="sv-cta sm" disabled={busy || !server} onClick={checkServer}>{busy && !srv ? <span className="spinner spinner--on-accent" /> : "Проверить"}</button>
        </div>
        {srv && <div className="sv-okline">{okd}Сервер отвечает · версия {srv.version}</div>}
        {srv && srv.license_used && <div className="sv-badline">✗ Эта лицензия уже использована на этом сервере.</div>}
        {srv && srv.login_taken && <div className="sv-badline">✗ Логин «{draft?.login}» уже занят — вернитесь назад и смените его.</div>}
        <div className="sv-warn">{warnIco}<span>После завершения лицензия будет <b>использована</b> (одноразовая). Аккаунт загрузится на сервер зашифрованным — вход станет возможен с любого устройства.</span></div>
        <div className="sv-rowbtns"><button className="sv-ghost" onClick={() => setStep(1)} disabled={busy}>← Назад</button><button className="sv-cta" disabled={!srv || srv.license_used || srv.login_taken || busy} onClick={finish}>{busy && srv ? <><span className="spinner spinner--on-accent" /> Загружаю…</> : "Завершить настройку"}</button></div>
      </>}

      {status && <div className="sv-err" style={{ color: status.includes("…") ? "var(--muted)" : "var(--danger)" }}>{status}</div>}
    </AuthShell>
  );
}

type Row = { login: string; role: string; org: string; created_at: string; revoked: boolean; quota_bytes?: number; used_bytes?: number; display_name?: string; perms?: string[]; last_submit?: string | null };
const PERM_FLAT: { key: string; label: string }[] = [
  { key: "submit", label: "Сдавать отчёты" }, { key: "view_all", label: "Видеть все данные (проверяющий)" }, { key: "review", label: "Проверять отчёты" },
  { key: "edit", label: "Редактировать" }, { key: "delete", label: "Удалять" }, { key: "comments", label: "Комментарии" },
  { key: "chat", label: "Чат" }, { key: "view_log", label: "Видеть журнал" }, { key: "export", label: "Экспорт данных" },
];

function genPassword(len = 14): string {
  const cs = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => cs[x % cs.length]).join("");
}

function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => { if (open) { const id = requestAnimationFrame(() => setShow(true)); return () => cancelAnimationFrame(id); } setShow(false); }, [open]);
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(10,12,28,0.42)", zIndex: 200, opacity: show ? 1 : 0, transition: "opacity .2s" }} />
      <div style={{ position: "fixed", left: "50%", top: "50%", width: 470, maxWidth: "92vw", maxHeight: "85vh", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, boxShadow: "0 24px 70px rgba(10,12,28,0.4)", zIndex: 201, display: "flex", flexDirection: "column", opacity: show ? 1 : 0, transform: show ? "translate(-50%,-50%)" : "translate(-50%,-46%)", transition: "opacity .2s, transform .2s" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "15px 18px", borderBottom: "1px solid var(--border-2)" }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, letterSpacing: "-0.01em", color: "var(--text)" }}>{title}</div>
          <button onClick={onClose} aria-label="Закрыть" style={{ marginLeft: "auto", width: 32, height: 32, borderRadius: 9, background: "transparent", border: "1px solid var(--border)", color: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div style={{ padding: 18, overflowX: "hidden", overflowY: "auto" }}>{children}</div>
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

export function BrandLoader({ size = 54 }: { size?: number }) {
  const c = size / 2, r = c - size * 0.055;
  const dash = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size, display: "grid", placeItems: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: "absolute", inset: 0, animation: "svlspin 1.05s linear infinite" }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--a1, #1565d8)" strokeWidth={size * 0.06} strokeLinecap="round" strokeDasharray={`${dash * 0.22} ${dash}`} opacity="0.95" />
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--a2, #22d3ee)" strokeWidth={size * 0.06} strokeLinecap="round" strokeDasharray={`${dash * 0.08} ${dash}`} strokeDashoffset={-dash * 0.4} opacity="0.7" />
      </svg>
      <img src={logoMark} alt="" style={{ width: size * 0.58, height: size * 0.58, objectFit: "contain", animation: "svlpulse 1.7s ease-in-out infinite" }} />
    </div>
  );
}

export function BrandLoading({ text = "Загрузка…", pad = 40 }: { text?: string; pad?: number }) {
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 11, padding: pad }}><BrandLoader size={46} /><div style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)" }}>{text}</div></div>;
}

export function LoadingOverlay({ text }: { text: string }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 350, background: "rgba(10,12,28,.34)", backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", display: "grid", placeItems: "center", animation: "svlfade .2s ease" }}>
      <div className="glass shadow" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 13, padding: "28px 38px", borderRadius: 20, background: "var(--surface, #fff)", border: "1px solid var(--glassln, rgba(20,24,60,.12))" }}>
        <BrandLoader size={60} />
        <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)" }}>{text}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: -5, display: "flex", alignItems: "center", gap: 5 }}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>Шифрование на вашем устройстве</div>
      </div>
    </div>
  );
}

type NotifT = { id: string; kind: string; rid: string; actor: string; text: string; at: string; read: boolean };
const NOTIF_META: Record<string, { title: string; color: string; icon: React.ReactNode }> = {
  new_file: { title: "Новый файл на проверку", color: "#4263eb", icon: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></> },
  status_ok: { title: "Файл принят", color: "#12b886", icon: <path d="M20 6 9 17l-5-5" /> },
  status_fix: { title: "Вернули с замечанием", color: "#f03e5e", icon: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></> },
  comment: { title: "Новый комментарий", color: "#8b5cf6", icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /> },
  approval_req: { title: "Нужно подтверждение опасной операции", color: "#f03e5e", icon: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></> },
  approval_approved: { title: "Операция одобрена", color: "#12b886", icon: <path d="M20 6 9 17l-5-5" /> },
  approval_denied: { title: "Операция отклонена", color: "#f03e5e", icon: <><path d="M18 6 6 18M6 6l12 12" /></> },
};
function notifMeta(k: string) { return NOTIF_META[k] || { title: k, color: "var(--muted)", icon: <circle cx="12" cy="12" r="9" /> }; }
function NotifBell({ login, pw, onOpen }: { login: string; pw: string; onOpen?: (n: NotifT) => void }) {
  const [items, setItems] = useState<NotifT[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const lastUnread = useRef<Set<string>>(new Set());
  const booted = useRef(false);
  const poll = async () => {
    try {
      const r = await invoke<{ items: NotifT[]; unread: number }>("sv_notifs", { login, password: pw });
      setItems(r.items); setUnread(r.unread);
      const fresh = r.items.filter((n) => !n.read && !lastUnread.current.has(n.id));
      if (booted.current && fresh.length) {
        const n = fresh[0]; const m = notifMeta(n.kind);
        invoke("sv_notify", { title: fresh.length > 1 ? `${fresh.length} новых уведомления` : m.title, body: n.text || m.title }).catch(() => { /* */ });
      }
      lastUnread.current = new Set(r.items.filter((n) => !n.read).map((n) => n.id));
      booted.current = true;
    } catch { /* */ }
  };
  useEffect(() => { poll(); const iv = setInterval(poll, 25000); return () => clearInterval(iv); }, []);
  const relTime = (iso: string) => { const t = Date.parse(iso); if (isNaN(t)) return ""; const s = Math.floor((Date.now() - t) / 1000); if (s < 60) return "только что"; if (s < 3600) return Math.floor(s / 60) + " мин"; if (s < 86400) return Math.floor(s / 3600) + " ч"; return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }); };
  const markRead = async (id: string) => { setItems((xs) => xs.map((x) => x.id === id ? { ...x, read: true } : x)); setUnread((u) => Math.max(0, u - 1)); lastUnread.current.delete(id); try { await invoke("sv_notifs_read", { login, password: pw, id, all: false }); } catch { /* */ } };
  const markAll = async () => { setItems((xs) => xs.map((x) => ({ ...x, read: true }))); setUnread(0); lastUnread.current = new Set(); try { await invoke("sv_notifs_read", { login, password: pw, id: "", all: true }); } catch { /* */ } };
  const click = (n: NotifT) => { if (!n.read) markRead(n.id); setOpen(false); onOpen?.(n); };
  return (
    <div className="avatar" onClick={(e) => e.stopPropagation()}>
      <button className="bell" onClick={() => setOpen((o) => !o)} aria-label="Уведомления">{unread > 0 && <em style={{ width: "auto", minWidth: 15, height: 15, borderRadius: 8, top: 4, right: 4, padding: "0 4px", display: "grid", placeItems: "center", fontSize: 9.5, fontWeight: 800, color: "#fff" }}>{unread > 9 ? "9+" : unread}</em>}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg></button>
      <div className="notifpanel glass shadow" hidden={!open}>
        <div className="notifhead"><span>Уведомления</span>{unread > 0 && <button onClick={markAll}>Прочитать все</button>}</div>
        <div className="notiflist">
          {items.length === 0 ? <div className="notifempty"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg><div>Пока нет уведомлений</div></div>
            : items.map((n) => { const m = notifMeta(n.kind); return (
              <button key={n.id} className={"notifrow" + (n.read ? "" : " unread")} onClick={() => click(n)}>
                <span className="notific" style={{ background: `color-mix(in srgb, ${m.color} 15%, transparent)`, color: m.color }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{m.icon}</svg></span>
                <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}><span className="notift">{m.title}</span><span className="notifx">{n.text}{n.actor ? " · " + n.actor : ""}</span></span>
                <span className="notifw">{relTime(n.at)}{!n.read && <i />}</span>
              </button>
            ); })}
        </div>
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--accent-tint)", color: "var(--accent-2)", fontSize: 13, fontWeight: 700 }}>{name.slice(0, 2).toUpperCase()}</span>;
}

type DirLite = { login: string; name: string; last_submit: string | null };
function DisciplineCard({ dirs, deadlineDay, canEdit = false, onSaveDeadline, onPick }: { dirs: DirLite[]; deadlineDay: number; canEdit?: boolean; onSaveDeadline?: (d: number) => Promise<void> | void; onPick?: (login: string) => void }) {
  const [monthOff, setMonthOff] = useState(0);
  const [pick, setPick] = useState(false);
  const [saving, setSaving] = useState(false);
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + monthOff, 1);
  const periodStart = base.getTime();
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + monthOff + 1, 1).getTime();
  const monthName = base.toLocaleDateString("ru-RU", { month: "long" }) + (base.getFullYear() !== now.getFullYear() ? " " + base.getFullYear() : "");
  const ini = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || s.slice(0, 1).toUpperCase();
  const stat = (last: string | null): { k: string; label: string; tone: string } => {
    const t = last ? Date.parse(last) : 0;
    if (t >= periodStart && t < periodEnd) return { k: "ok", label: "сдан", tone: "var(--good)" };
    if (periodStart > now.getTime()) return { k: "wait", label: "ожидается", tone: "var(--warn)" };
    if (deadlineDay > 0) {
      const dl = new Date(base.getFullYear(), base.getMonth(), deadlineDay, 23, 59, 59).getTime();
      if (now.getTime() <= dl) return { k: "wait", label: "ожидается до " + deadlineDay + "-го", tone: "var(--warn)" };
      return { k: "over", label: "просрочено", tone: "var(--danger)" };
    }
    return t ? { k: "idle", label: "давно не сдавал", tone: "var(--muted)" } : { k: "none", label: "нет отчётов", tone: "var(--muted)" };
  };
  const cnt = { ok: 0, wait: 0, over: 0, idle: 0, none: 0 };
  dirs.forEach((d) => { cnt[stat(d.last_submit).k as keyof typeof cnt]++; });
  const attention = dirs.filter((d) => stat(d.last_submit).k !== "ok").sort((a, b) => { const ord: Record<string, number> = { over: 0, wait: 1, none: 2, idle: 3, ok: 4 }; return ord[stat(a.last_submit).k] - ord[stat(b.last_submit).k]; });
  const save = async (d: number) => { setSaving(true); try { await onSaveDeadline?.(d); setPick(false); } catch { /* */ } setSaving(false); };
  return <div className="card glass shadow" style={{ marginBottom: 14, position: "relative", zIndex: pick ? 60 : 1 }}>
    <div className="dhead">
      <h3 style={{ margin: 0 }}><span className="rail5" style={{ background: "linear-gradient(var(--info),#22d3ee)" }} />Дисциплина сдачи</h3>
      <div className="mnav">
        <button onClick={() => setMonthOff((m) => m - 1)} title="Предыдущий месяц">{nic(<path d="m15 18-6-6 6-6" />, 15)}</button>
        <span className="mname">{monthName}{monthOff === 0 ? " · сейчас" : ""}</span>
        <button disabled={monthOff >= 1} onClick={() => setMonthOff((m) => Math.min(1, m + 1))} title="Следующий месяц">{nic(<path d="m9 18 6-6-6-6" />, 15)}</button>
      </div>
      <div style={{ marginLeft: "auto", position: "relative" }}>
        {canEdit
          ? <button className="chip sm" style={{ gap: 6 }} onClick={() => setPick((v) => !v)}>{nic(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>, 14)}{deadlineDay > 0 ? `Срок: до ${deadlineDay}-го` : "Задать срок"}</button>
          : <span className="dstat idle" style={{ fontWeight: 700 }}>{deadlineDay > 0 ? `срок: до ${deadlineDay}-го числа` : "срок не задан"}</span>}
        {canEdit && pick && <div className="daypop glass shadow">
          <div className="dgrid">{Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <button key={d} className={d === deadlineDay ? "on" : ""} disabled={saving} onClick={() => save(d)}>{d}</button>)}</div>
          <button className="chip sm" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} disabled={saving} onClick={() => save(0)}>Без срока</button>
        </div>}
      </div>
    </div>
    {dirs.length === 0 ? <div className="sub" style={{ padding: "2px" }}>Директоров пока нет.</div> : <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "2px 0 14px" }}>
        <span className="dstat ok">{nic(<path d="M20 6 9 17l-5-5" />, 12)}{cnt.ok} сдали</span>
        {cnt.wait > 0 && <span className="dstat wait">{nic(<><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></>, 12)}{cnt.wait} ожидается</span>}
        {cnt.over > 0 && <span className="dstat over">{nic(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 12)}{cnt.over} просрочено</span>}
        {(cnt.none + cnt.idle) > 0 && <span className="dstat idle">{cnt.none + cnt.idle} без отчётов</span>}
      </div>
      {attention.length === 0
        ? <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)", padding: "4px 2px" }}><span style={{ color: "var(--good)", display: "flex" }}>{nic(<path d="M20 6 9 17l-5-5" />)}</span>Все сдали за {monthName}.</div>
        : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(230px,1fr))", gap: 8 }}>
            {attention.slice(0, 12).map((p) => { const st = stat(p.last_submit); return <div key={p.login} className="f" onClick={() => onPick?.(p.login)} style={{ cursor: onPick ? "pointer" : "default", margin: 0 }}><span className="fi" style={{ background: `linear-gradient(135deg,${avatarGrad(p.login)})` }}>{ini(p.name)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{p.name}</div><div className="sub">{p.last_submit ? "последний " + new Date(p.last_submit).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : "ещё не сдавал"}</div></div><span className="st" style={{ background: `color-mix(in srgb, ${st.tone} 16%, transparent)`, color: st.tone }}>{st.label}</span></div>; })}
          </div>}
      {attention.length > 12 && <div className="sub" style={{ marginTop: 10 }}>и ещё {attention.length - 12}…</div>}
    </>}
  </div>;
}

export function MasterHome({ info, pw, theme, onToggleTheme, onExit }: { info: MasterInfo; pw: string; theme: string; onToggleTheme: () => void; onExit: () => void }) {
  const login = info.login;
  const [section, setSection] = useState("dash");
  const [menu, setMenu] = useState(false);
  const [accent, setAccent] = useState(() => { try { return prefsCached(login).accent || ""; } catch { return ""; } });
  const chAccent = (a: string) => { setAccent(a); prefsSet(login, pw, { accent: a }); };
  const accents: [string, string][] = [["", "#6366f1,#22d3ee"], ["royal", "#4f46e5,#a855f7"], ["violet", "#8b5cf6,#ec4899"], ["ocean", "#2563eb,#22d3ee"], ["emerald", "#10b981,#2dd4bf"], ["sunset", "#fb7185,#fbbf24"], ["graphite", "#475569,#0ea5e9"]];
  const [lic, setLic] = useState<License | null>(info.license);
  const [roles, setRoles] = useState<RoleDef[]>(info.roles);
  const [orgs, setOrgs] = useState<string[]>(info.orgs);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [audit, setAudit] = useState<Audit[]>([]);
  const adminAudit = audit.filter((e) => e.action !== "report_submitted");
  const [chainOk, setChainOk] = useState(true);
  const [orgCfg, setOrgCfg] = useState<{ deadline_day: number; review_on: boolean; default_folders: string[] }>({ deadline_day: 0, review_on: true, default_folders: [] });
  const loadProfiles = async () => { setLoading(true); try { setProfiles(await invoke<Row[]>("sv_list_profiles", { masterLogin: login, masterPassword: pw })); } catch { /* */ } setLoading(false); };
  const loadAudit = async () => { try { const r = await invoke<{ entries: Audit[]; chain_ok: boolean }>("sv_log", { masterLogin: login, masterPassword: pw }); setAudit(r.entries); setChainOk(r.chain_ok); } catch { /* */ } };
  const loadOrgCfg = async () => { try { setOrgCfg(await invoke<{ deadline_day: number; review_on: boolean; default_folders: string[] }>("sv_orgcfg_get", { masterLogin: login, masterPassword: pw, org: info.org })); } catch { /* */ } };
  const saveOrgCfg = async (patch: Partial<{ deadline_day: number; review_on: boolean; default_folders: string[] }>) => { const next = { ...orgCfg, ...patch }; setOrgCfg(next); try { await invoke("sv_orgcfg_set", { masterLogin: login, masterPassword: pw, org: info.org, deadlineDay: next.deadline_day, reviewOn: next.review_on, defaultFolders: next.default_folders }); loadAudit(); } catch { /* */ } };
  const [net, setNet] = useState<{ server: boolean; ms: number } | null>(null);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const recheck = () => { setOnline(typeof navigator !== "undefined" ? navigator.onLine : true); invoke<{ server: boolean; ms: number; iface: string }>("sv_net_status").then((n) => setNet({ server: n.server, ms: n.ms })).catch(() => setNet({ server: false, ms: 0 })); };
  useEffect(() => { loadProfiles(); loadAudit(); loadOrgCfg(); recheck(); const iv = setInterval(recheck, 15000); const on = () => setOnline(navigator.onLine); window.addEventListener("online", on); window.addEventListener("offline", on); return () => { clearInterval(iv); window.removeEventListener("online", on); window.removeEventListener("offline", on); }; }, []);
  const netOk = online && (net ? net.server : true);

  const ini = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || s.slice(0, 1).toUpperCase();
  const fmtB = (n: number) => n < 1024 ? n + " Б" : n < 1048576 ? (n / 1024).toFixed(0) + " КБ" : n < 1073741824 ? (n / 1048576).toFixed(1) + " МБ" : (n / 1073741824).toFixed(1) + " ГБ";
  const nameOf = (p: Row) => p.display_name || p.login;
  const roleName = (k: string) => roles.find((r) => r.key === k)?.name || k;
  const can = (k: string) => hasPerm(info, k);

  const active = useMemo(() => profiles.filter((p) => !p.revoked), [profiles]);
  const revoked = useMemo(() => profiles.filter((p) => p.revoked), [profiles]);
  const totalUsed = useMemo(() => profiles.reduce((a, p) => a + (p.used_bytes || 0), 0), [profiles]);
  const totalQuota = useMemo(() => profiles.reduce((a, p) => a + (p.quota_bytes || 0), 0), [profiles]);
  const pctUsed = totalQuota > 0 ? Math.round((totalUsed / totalQuota) * 100) : 0;
  const dirN = active.filter((p) => !isReviewer(p)).length;
  const revN = active.filter((p) => isReviewer(p)).length;
  function isReviewer(p: Row) { return p.role === "reviewer" || (roles.find((r) => r.key === p.role)?.perms || []).includes("view_all"); }

  const dueDirectors = useMemo(() => active.filter((p) => !isReviewer(p)), [active, roles]);
  const disciplineDirs = useMemo<DirLite[]>(() => dueDirectors.map((p) => ({ login: p.login, name: nameOf(p), last_submit: p.last_submit ?? null })), [dueDirectors]);

  const [pview, setPview] = useState(() => { try { return localStorage.getItem("sv-m-view") || "cards"; } catch { return "cards"; } });
  const chPview = (v: string) => { setPview(v); try { localStorage.setItem("sv-m-view", v); } catch { /* */ } };
  const [pq, setPq] = useState("");
  const pfiltered = useMemo(() => { if (!pq.trim()) return profiles; const q = pq.toLowerCase(); return profiles.filter((p) => (nameOf(p) + " " + p.login + " " + roleName(p.role)).toLowerCase().includes(q)); }, [profiles, pq, roles]);

  const [newOpen, setNewOpen] = useState(false);
  const [mToast, setMToast] = useState("");
  const mNotify = (m: string) => { setMToast(m); setTimeout(() => setMToast(""), 3200); };
  const [editRow, setEditRow] = useState<Row | null>(null);

  const grad = (s: string) => `linear-gradient(135deg,${avatarGrad(s)})`;
  const usageStr = (p: Row) => isReviewer(p) ? "видит всё" : (fmtB(p.used_bytes || 0) + (p.quota_bytes ? " / " + fmtB(p.quota_bytes) : " · без лимита"));
  const stPill = (p: Row) => p.revoked ? <span className="st fix">отозван</span> : <span className="st ok">активен</span>;
  const healthW = (p: Row) => p.quota_bytes ? Math.min(100, Math.round((p.used_bytes || 0) / p.quota_bytes * 100)) : 0;

  const Pill = ({ id, label, icon }: { id: string; label: string; icon: React.ReactNode }) => (
    <button className={section === id ? "on" : ""} onClick={() => { setMenu(false); setSection(id); }}>{icon}<span>{label}</span></button>
  );

  const pcard = (p: Row) => (
    <div key={p.login} className="rcard" onClick={() => setEditRow(p)} style={p.revoked ? { opacity: .72 } : undefined}>
      <div className="rcov" style={{ background: grad(nameOf(p)) }}><span className="rini">{ini(nameOf(p))}</span><span className="flag">{isReviewer(p) ? <>{nic(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>, 12)} видит всё</> : p.revoked ? <>{nic(<><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>, 12)} отозван</> : <>{nic(<><circle cx="12" cy="7" r="4" /><path d="M5.5 21a7 7 0 0 1 13 0" /></>, 12)} {roleName(p.role).toLowerCase()}</>}</span></div>
      <div className="rb"><div className="rn">{nameOf(p)}</div><div className="rd">@{p.login}</div><div className="rstats"><span className="rpill">{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, 12)}{p.used_bytes != null && p.role !== "reviewer" ? "" : ""}{usageStr(p)}</span></div>{!isReviewer(p) && p.quota_bytes ? <div className="health"><i style={{ width: healthW(p) + "%", background: healthW(p) > 90 ? "var(--danger)" : healthW(p) > 75 ? "var(--warn)" : undefined }} /></div> : null}</div>
    </div>
  );
  const prow = (p: Row) => (
    <div key={p.login} className="rlrow" onClick={() => setEditRow(p)}><span className="rini2" style={{ background: grad(nameOf(p)) }}>{ini(nameOf(p))}</span><div style={{ minWidth: 0 }}><div className="nm" style={{ fontSize: 14 }}>{nameOf(p)}</div><div className="sub">@{p.login} · {roleName(p.role)}</div></div><div className="rmini"><div className="rmetric"><div className="mn" style={{ fontSize: 13 }}>{isReviewer(p) ? "—" : fmtB(p.used_bytes || 0)}</div><div className="ml">место</div></div>{stPill(p)}<span className="rchev">{nic(<path d="m9 18 6-6-6-6" />, 16)}</span></div></div>
  );

  const licDays = lic && lic.exp ? Math.max(0, Math.round((lic.exp * 1000 - Date.now()) / 864e5)) : 0;
  const licExp = lic && lic.exp ? new Date(lic.exp * 1000).toLocaleDateString("ru-RU") : "—";
  const licSub = !!(lic && lic.kind !== "perpetual" && lic.exp);
  const licWarn = licSub && (licDays <= 7);
  const licExpired = !!(lic && !lic.valid);
  useEffect(() => {
    if (!licSub) return;
    const days = Math.round((lic!.exp * 1000 - Date.now()) / 864e5);
    if (days > 7) return;
    try { const key = "sv-licnotify-" + login + "-" + new Date().toISOString().slice(0, 10); if (!localStorage.getItem(key)) { localStorage.setItem(key, "1"); invoke("sv_notify", { title: "SecureVault — лицензия", body: days <= 0 ? "Срок лицензии истёк. Обновите ключ, иначе доступ будет ограничен." : "Лицензия истекает через " + days + " дн. Обновите ключ." }).catch(() => { /* */ }); } } catch { /* */ }
  }, [lic]);

  return (
    <div className="ws" data-theme={theme} data-accent={accent || undefined} style={{ height: "100%", overflow: "auto", position: "relative" }} onClick={() => menu && setMenu(false)}>
      <div className="aura"><b /><b /><b /></div>
      {(!online || (net && !net.server)) && (
        <div className="offbar" role="alert"><span className="offbar-ic">{nic(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>, 20)}</span><div className="offbar-tx"><b>{!online ? "Нет интернета" : "Сервер недоступен"}</b><span>Изменения не сохранятся, пока связь не вернётся.</span></div><button className="offbar-btn" onClick={recheck}>{nic(<><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></>, 15)}Повторить</button></div>
      )}
      <div className="wrap" style={{ maxWidth: 1240 }}>
        <div className="pbar glass shadow">
          <div className="bn"><i>{nic(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, 13)}</i><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{info.org}<span style={{ fontWeight: 600, fontSize: 11, color: "var(--muted)", fontFamily: "var(--fbody)" }}>&nbsp;· мастер</span></span></div>
          <nav className="pills">
            <Pill id="dash" label="Обзор" icon={nic(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>)} />
            <Pill id="prof" label="Профили" icon={nic(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>)} />
            <Pill id="roles" label="Роли" icon={nic(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>)} />
            <Pill id="sec" label="Безопасность" icon={nic(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>)} />
            <Pill id="lg" label="Журнал" icon={nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>)} />
            <Pill id="org" label="Организации" icon={nic(<><path d="M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M3 10l9-6 9 6z" /></>)} />
          </nav>
          <div className="r">
            <button className="topnet tipbtn tipdown" data-tip={!online ? "Нет интернета" : net ? (net.server ? `Сервер в сети · ${net.ms} мс` : "Сервер недоступен") : "Проверка…"}><span className={"topnet-dot " + (netOk ? "on" : "off")} />{nic(<><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" /></>, 17)}</button>
            <div className="avatar" onClick={(e) => e.stopPropagation()}>
              <button className="btnav" onClick={() => setMenu((m) => !m)}><span className="ava on-dot">{ini(info.me_name || login)}</span></button>
              <div className="menu glass shadow" hidden={!menu}>
                <div className="mhd"><span className="ava" style={{ width: 34, height: 34 }}>{ini(info.me_name || login)}</span><div><div style={{ fontWeight: 700, fontSize: 13 }}>{info.me_name || login}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>Мастер · полный доступ</div></div></div>
                <button className="mi" onClick={() => { setMenu(false); setSection("me"); }}>{nic(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>)}Мой профиль</button>
                <button className="mi" style={{ color: "var(--danger)" }} onClick={onExit}>{nic(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>)}Выйти</button>
              </div>
            </div>
          </div>
        </div>

        {lic && !lic.valid && <div style={{ marginBottom: 14 }}><RenewBanner server={info.server} login={login} pw={pw} onRenewed={setLic} /></div>}

        {loading && section === "prof" ? <BrandLoading />
          : section === "dash" ? <>
            <div className="shead"><div className="headava">{ini(info.me_name || login)}</div><div style={{ flex: 1, minWidth: 200 }}><h1>Обзор организации</h1></div>
              {can("submit") || true ? <button className="chip grad" onClick={() => setNewOpen(true)}>{nic(<path d="M12 5v14M5 12h14" />)}Создать профиль</button> : null}
            </div>
            {(licWarn || licExpired) && <div className="licbanner" style={{ borderColor: licExpired ? "var(--danger)" : "var(--warn)", background: `color-mix(in srgb, ${licExpired ? "var(--danger)" : "var(--warn)"} 10%, transparent)` }}>
              <span className="licb-ic" style={{ background: licExpired ? "var(--danger)" : "var(--warn)" }}>{nic(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 18)}</span>
              <div style={{ flex: 1, minWidth: 0 }}><div className="nm" style={{ fontSize: 14, fontWeight: 700 }}>{licExpired ? "Лицензия истекла" : (licDays <= 0 ? "Лицензия истекает сегодня" : "Лицензия истекает через " + licDays + " дн.")}</div><div className="sub">{licExpired ? "Обновите офлайн-ключ, чтобы снять ограничения." : "Обновите ключ заранее — до " + licExp + "."}</div></div>
              <button className="chip grad" onClick={() => setSection("sec")}>Обновить ключ</button>
            </div>}
            <div className="strip">
              <div className="kpi glass in" onClick={() => setSection("prof")} style={{ cursor: "pointer" }}><span className="d" style={{ background: "var(--info)" }} /><div className="n">{profiles.length}</div><div className="k">Профилей</div></div>
              <div className="kpi glass in" onClick={() => setSection("prof")} style={{ animationDelay: ".05s", cursor: "pointer" }}><span className="d" style={{ background: "var(--good)" }} /><div className="n" style={{ color: "var(--good)" }}>{active.length}</div><div className="k">Активных</div></div>
              <div className="kpi glass in" onClick={() => setSection("prof")} style={{ animationDelay: ".1s", cursor: "pointer" }}><span className="d" style={{ background: "var(--danger)" }} /><div className="n" style={{ color: "var(--danger)" }}>{revoked.length}</div><div className="k">Отозвано</div></div>
              <div className="kpi glass in" style={{ animationDelay: ".15s" }}><span className="d" style={{ background: "var(--warn)" }} /><div className="n" style={{ color: "var(--warn)" }}>{totalQuota > 0 ? pctUsed + "%" : fmtB(totalUsed)}</div><div className="k">{totalQuota > 0 ? "Место занято" : "Место (всего)"}</div></div>
            </div>
            <ApprovalsCard login={login} pw={pw} notify={mNotify} />
            <DisciplineCard dirs={disciplineDirs} deadlineDay={orgCfg.deadline_day} canEdit onSaveDeadline={(d) => saveOrgCfg({ deadline_day: d })} onPick={(lg) => { const p = profiles.find((x) => x.login === lg); if (p) setEditRow(p); }} />
            <div className="three">
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="lic shadow">
                  <div style={{ display: "flex", alignItems: "center", gap: 9, position: "relative", zIndex: 1, fontSize: 12, opacity: .9 }}>{nic(<><path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /><path d="M12 2l2.5 2 3.5-.5L18 7l2 2.5-2 2.5.5 3.5L15 18l-3 2-3-2-3.5.5L5 15l-2-2.5L5 10l-.5-3.5L8 6z" /></>, 15)}Лицензия</div>
                  <div className="lbig">{lic ? (lic.kind === "perpetual" ? "Бессрочная" : "Подписка") : "—"}</div>
                  <div className="lrow2"><span style={{ opacity: .85 }}>Профилей</span><b>{profiles.length}</b></div>
                  <div className="lrow2"><span style={{ opacity: .85 }}>Статус</span><b>{lic && lic.valid ? "активна" : "истекла"}</b></div>
                  {lic && lic.kind !== "perpetual" && <div className="lrow2"><span style={{ opacity: .85 }}>До</span><b>{licExp}{licDays ? ` · ${licDays} дн.` : ""}</b></div>}
                  <button className="chip" style={{ width: "100%", justifyContent: "center", marginTop: 14, position: "relative", zIndex: 1, background: "rgba(255,255,255,.2)", border: "none", color: "#fff" }} onClick={() => setSection("sec")}>Управлять лицензией</button>
                </div>
                <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(var(--warn),#ffa94d)" }} />Требует внимания</h3>
                  {(() => { const over = active.filter((p) => p.quota_bytes && (p.used_bytes || 0) / p.quota_bytes > 0.85); const list: React.ReactNode[] = [];
                    over.slice(0, 3).forEach((p) => list.push(<div key={"o" + p.login} className="f" onClick={() => setEditRow(p)}><span className="fi" style={{ background: "linear-gradient(135deg,#f03e5e,#ff6b81)" }}>{nic(<><path d="M22 12H2M5 12V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M6 16h.01M10 16h.01" /></>, 18)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{nameOf(p)}</div><div className="sub">место {fmtB(p.used_bytes || 0)} / {fmtB(p.quota_bytes!)}</div></div><span className="st fix">{healthW(p)}%</span></div>));
                    if (lic && lic.kind !== "perpetual" && licDays < 90) list.push(<div key="lic" className="f" onClick={() => setSection("sec")}><span className="fi" style={{ background: "linear-gradient(135deg,#f08c00,#ffa94d)" }}>{nic(<><path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /><path d="M12 2l2.5 2 3.5-.5L18 7l2 2.5-2 2.5.5 3.5L15 18l-3 2-3-2-3.5.5L5 15l-2-2.5L5 10l-.5-3.5L8 6z" /></>, 18)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">Лицензия</div><div className="sub">истекает через {licDays} дн.</div></div><span className="st wait">скоро</span></div>);
                    if (revoked.length) list.push(<div key="rev" className="f"><span className="fi" style={{ background: "linear-gradient(135deg,#64748b,#94a3b8)" }}>{nic(<><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>, 18)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{revoked.length} отозванных</div><div className="sub">данные сохранены, вход закрыт</div></div></div>);
                    return list.length ? list : <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)", padding: "4px 2px" }}><span style={{ color: "var(--good)", display: "flex" }}>{nic(<path d="M20 6 9 17l-5-5" />)}</span>Всё в порядке.</div>;
                  })()}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="card glass shadow"><h3><span className="rail5" />Место по профилям<button className="allbtn" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--a1)", border: "none", background: "none" }} onClick={() => setSection("prof")}>все</button></h3>
                  {(() => { const top = active.filter((p) => !isReviewer(p)).slice().sort((a, b) => (b.used_bytes || 0) - (a.used_bytes || 0)).slice(0, 6); const max = Math.max(1, ...top.map((p) => p.used_bytes || 0)); return top.length ? top.map((p) => { const q = p.quota_bytes || 0; const pct = q ? Math.min(100, Math.round((p.used_bytes || 0) / q * 100)) : Math.round((p.used_bytes || 0) / max * 100); return <div key={p.login} className="rankrow" onClick={() => setEditRow(p)} style={{ cursor: "pointer" }}><span className="rt">{nameOf(p)}</span><span className="rbar"><i style={{ width: pct + "%", background: pct > 90 ? "var(--danger)" : pct > 75 ? "var(--warn)" : undefined }} /></span><span className="rv">{fmtB(p.used_bytes || 0)}</span></div>; }) : <div className="sub">Нет данных.</div>; })()}
                </div>
                <div className="card glass shadow"><h3><span className="rail5" />Последние действия<button className="allbtn" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--a1)", border: "none", background: "none" }} onClick={() => { setSection("lg"); loadAudit(); }}>журнал</button></h3>
                  {adminAudit.length === 0 ? <div className="sub">Пока пусто.</div> : adminAudit.slice(0, 5).map((e, i) => { const a = ACTIONS[e.action] || { label: e.action, tone: "muted" as const }; const col = a.tone === "green" ? "var(--good)" : a.tone === "danger" ? "var(--danger)" : a.tone === "accent" ? "var(--a1)" : "var(--muted)"; return <div key={i} className="f"><span className="fi" style={{ width: 30, height: 30, background: `color-mix(in srgb, ${col} 16%, transparent)`, color: col }}>{nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>, 15)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{a.label}: {e.target}</div><div className="sub">{new Date(e.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div></div></div>; })}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="card glass shadow"><h3><span className="rail5" />По ролям</h3>
                  <div className="donut-wrap">{(() => { const tot = profiles.length || 1; const segs = [{ n: dirN, c: "var(--a1)", t: "Директора" }, { n: revN, c: "var(--a3)", t: "Проверяющие" }, { n: revoked.length, c: "var(--muted-2)", t: "Отозваны" }].filter((s) => s.n > 0); const R = 52, C = 2 * Math.PI * R; let acc = 0; return <><svg viewBox="0 0 130 130" className="donut"><circle cx="65" cy="65" r={R} fill="none" stroke="color-mix(in srgb,var(--text) 8%,transparent)" strokeWidth="13" />{segs.map((s, i) => { const len = (s.n / tot) * C, off = acc; acc += len; return <circle key={i} cx="65" cy="65" r={R} fill="none" stroke={s.c} strokeWidth="13" strokeLinecap="round" strokeDasharray={`${Math.max(0, len - 3)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 65 65)" />; })}<text x="65" y="60" textAnchor="middle" className="donut-n">{profiles.length}</text><text x="65" y="78" textAnchor="middle" className="donut-l">профиля</text></svg><div className="donut-leg"><div className="dleg"><span className="d" style={{ background: "var(--a1)" }} /><span className="dleg-t">Директора</span><span className="dleg-n">{dirN}</span></div><div className="dleg"><span className="d" style={{ background: "var(--a3)" }} /><span className="dleg-t">Проверяющие</span><span className="dleg-n">{revN}</span></div><div className="dleg"><span className="d" style={{ background: "var(--muted-2)" }} /><span className="dleg-t">Отозваны</span><span className="dleg-n">{revoked.length}</span></div></div></>; })()}</div>
                </div>
                <div className="card glass shadow"><h3><span className="rail5" />Быстрые действия</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <button className="chip grad" style={{ justifyContent: "flex-start" }} onClick={() => setNewOpen(true)}>{nic(<path d="M12 5v14M5 12h14" />)}Создать профиль</button>
                    <button className="chip" style={{ justifyContent: "flex-start" }} onClick={() => setSection("roles")}>{nic(<><path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /></>)}Настроить роли</button>
                    <button className="chip" style={{ justifyContent: "flex-start" }} onClick={() => setSection("sec")}>{nic(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></>)}Безопасность</button>
                  </div>
                </div>
              </div>
            </div>
          </>
            : section === "prof" ? <>
              <div className="shead"><div style={{ flex: 1, minWidth: 160 }}><h1>Профили</h1></div>
                <div className="dsearch"><span style={{ display: "flex", color: "var(--muted)" }}>{nic(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, 15)}</span><input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Поиск по имени, логину, роли…" /></div>
                <div className="vswitch">
                  <button className={pview === "cards" ? "on" : ""} onClick={() => chPview("cards")}>{nic(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>, 15)}Карточки</button>
                  <button className={pview === "list" ? "on" : ""} onClick={() => chPview("list")}>{nic(<><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>, 15)}Список</button>
                  <button className={pview === "roles" ? "on" : ""} onClick={() => chPview("roles")}>{nic(<><rect x="3" y="3" width="5" height="18" rx="1.5" /><rect x="10" y="3" width="5" height="18" rx="1.5" /><rect x="17" y="3" width="4" height="18" rx="1.5" /></>, 15)}По ролям</button>
                </div>
                <button className="chip grad sm" onClick={() => setNewOpen(true)}>{nic(<path d="M12 5v14M5 12h14" />, 15)}Создать</button>
              </div>
              {pfiltered.length === 0 ? <div className="card glass shadow"><div className="empty">{profiles.length === 0 ? "Профилей пока нет. Нажмите «Создать»." : "Ничего не найдено."}</div></div>
                : pview === "cards" ? <div className="rgrid">{pfiltered.map(pcard)}</div>
                  : pview === "list" ? <div className="card glass shadow rlist" style={{ padding: 0 }}>{pfiltered.map(prow)}</div>
                    : <div className="kanban">{([["dir", "Директора", "var(--a1)"], ["rev", "Проверяющие", "var(--a3)"], ["off", "Отозваны", "var(--muted-2)"]] as [string, string, string][]).map(([k, title, col]) => { const items = pfiltered.filter((p) => k === "off" ? p.revoked : (!p.revoked && (k === "rev" ? isReviewer(p) : !isReviewer(p)))); return <div key={k} className="kcol card glass shadow"><div className="khead"><span className="kdot" style={{ background: col }} />{title}<span className="kn">{items.length}</span></div>{items.length ? items.map((p) => <div key={p.login} className="kchip" onClick={() => setEditRow(p)}><span className="rini3" style={{ background: grad(nameOf(p)) }}>{ini(nameOf(p))}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{nameOf(p)}</div><div className="sub">{usageStr(p)}</div></div></div>) : <div className="sub" style={{ padding: "8px 4px" }}>—</div>}</div>; })}</div>}
            </>
              : section === "roles" ? <MRoles login={login} pw={pw} roles={roles} setRoles={setRoles} counts={profiles} roleName={roleName} />
                : section === "sec" ? <MSecurity server={info.server} login={login} pw={pw} org={info.org} roles={roles} lic={lic} setLic={setLic} notify={mNotify} />
                  : section === "lg" ? <>
                    <div className="shead"><div style={{ flex: 1 }}><h1>Журнал</h1></div>
                      <span className={"chainbadge " + (chainOk ? "ok" : "bad")}>{nic(chainOk ? <path d="M20 6 9 17l-5-5" /> : <><path d="M18 6 6 18M6 6l12 12" /></>, 13)}{chainOk ? "Цепочка цела" : "Цепочка нарушена"}</span>
                    </div>
                    <div className="card glass shadow" style={{ padding: "10px 14px" }}>
                      {adminAudit.length === 0 ? <div className="empty">Пока пусто. Действия появятся здесь.</div>
                        : <div className="tl">{(() => { const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }; const today = dayStart(Date.now()); let cur = ""; const out: React.ReactNode[] = []; adminAudit.forEach((e, i) => { const t = Date.parse(e.at); const ds = isNaN(t) ? 0 : dayStart(t); const lbl = ds === today ? "Сегодня" : ds === today - 864e5 ? "Вчера" : new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }); if (lbl !== cur) { out.push(<div key={"d" + i} className="tlday">{lbl}</div>); cur = lbl; } const a = ACTIONS[e.action] || { label: e.action, tone: "muted" as const }; const col = a.tone === "green" ? "var(--good)" : a.tone === "danger" ? "var(--danger)" : a.tone === "accent" ? "var(--a1)" : "var(--muted)"; out.push(<div key={i} className="tlitem"><span className="tldot" style={{ background: col }} /><span className="tlic" style={{ background: `color-mix(in srgb, ${col} 16%, transparent)`, color: col }}>{nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>, 17)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{a.label}: {e.target}{e.org ? " · " + e.org : ""}</div><div className="sub">{new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</div></div></div>); }); return out; })()}</div>}
                    </div>
                  </>
                    : section === "org" ? <MOrgs login={login} pw={pw} orgs={orgs} setOrgs={setOrgs} profiles={profiles} roles={roles} mine={info.org} />
                      : <>
                        <div className="shead"><h1>Мой профиль</h1></div>
                        <div className="card glass shadow" style={{ marginBottom: 14 }}><h3><span className="rail5" />Оформление</h3>
                          <div className="psetrow"><div className="pt"><div className="nm">Тёмная тема</div><div className="sub">Переключить вид приложения</div></div><div className={"switch2" + (theme === "dark" ? " on" : "")} onClick={onToggleTheme}><i /></div></div>
                          <div className="psetrow" style={{ flexWrap: "wrap" }}><div className="pt"><div className="nm">Акцент</div><div className="sub">Цвет интерфейса — на ваш вкус</div></div>
                            <div className="sws">{accents.map(([v, g]) => <span key={v || "d"} className={"sw" + (accent === v ? " on" : "")} onClick={() => chAccent(v)} style={{ background: "linear-gradient(135deg," + g + ")" }} />)}</div>
                          </div>
                        </div>
                        <MeSection login={login} pw={pw} info={info} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} showTheme={false} />
                      </>}
      </div>

      {newOpen && <MNewProfile masterLogin={login} pw={pw} roles={roles} orgs={orgs} defaultOrg={info.org} onClose={() => setNewOpen(false)} onCreated={() => { setNewOpen(false); loadProfiles(); loadAudit(); }} />}
      <Toast msg={mToast} />
      {editRow && <ProfileEdit row={editRow} masterLogin={login} pw={pw} roleName={roleName} roles={roles} perms={roles.find((r) => r.key === editRow.role)?.perms || []} onClose={() => setEditRow(null)} onChanged={() => { setEditRow(null); loadProfiles(); loadAudit(); }} />}
    </div>
  );
}

function MNewProfile({ masterLogin, pw, roles, orgs, defaultOrg, onClose, onCreated }: { masterLogin: string; pw: string; roles: RoleDef[]; orgs: string[]; defaultOrg: string; onClose: () => void; onCreated: () => void }) {
  const [dispName, setDispName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState(roles[0]?.key || "director");
  const [org, setOrg] = useState(defaultOrg || orgs[0] || "");
  const [quotaGb, setQuotaGb] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [individual, setIndividual] = useState(false);
  const [cPerms, setCPerms] = useState<string[]>(roles[0]?.perms || []);
  const pickRole = (k: string) => { setRole(k); if (!individual) setCPerms(roles.find((r) => r.key === k)?.perms || []); };
  const togP = (k: string) => setCPerms((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]);
  const create = async () => {
    if (!login.trim()) { setErr("Укажите логин"); return; }
    if (pass.length < 6) { setErr("Пароль не короче 6 символов"); return; }
    setBusy(true); setErr("");
    try {
      const perms = individual ? cPerms : (roles.find((r) => r.key === role)?.perms || []);
      const qb = quotaGb.trim() ? Math.round(parseFloat(quotaGb.replace(",", ".")) * 1073741824) : 0;
      await invoke("sv_create_profile", { masterLogin, masterPassword: pw, org, login: login.trim(), password: pass, role, perms, quotaBytes: isNaN(qb) ? 0 : qb, displayName: dispName.trim() });
      onCreated();
    } catch (e) { setErr("" + String(e)); setBusy(false); }
  };
  return (
    <Drawer open onClose={() => !busy && onClose()} title="Новый профиль">
      <label style={lbl}>Имя и фамилия</label>
      <input style={input} value={dispName} onChange={(e) => setDispName(e.target.value)} placeholder="напр. Денис Орлов" />
      <div style={{ height: 14 }} />
      <label style={lbl}>Логин</label>
      <input style={input} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="напр. denis" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <div style={{ height: 14 }} />
      <label style={lbl}>Роль</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>{roles.map((r) => <button key={r.key} className={"rolechip" + (role === r.key ? " on" : "")} onClick={() => pickRole(r.key)}>{r.name}</button>)}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <div className={"switch2" + (individual ? " on" : "")} onClick={() => { setIndividual((v) => { const nv = !v; if (!nv) setCPerms(roles.find((r) => r.key === role)?.perms || []); return nv; }); }}><i /></div>
        <div><div style={{ fontSize: 13, fontWeight: 600 }}>Индивидуальные права</div><div style={{ fontSize: 11, color: "var(--muted)" }}>Свой набор, независимо от роли</div></div>
      </div>
      {individual && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 10, padding: 10, borderRadius: 11, background: "var(--surface-2)", border: "1px solid var(--border-2)" }}>{PERM_FLAT.map((p) => <button key={p.key} onClick={() => togP(p.key)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8, border: "none", background: cPerms.includes(p.key) ? "var(--accent-tint)" : "transparent", color: cPerms.includes(p.key) ? "var(--text)" : "var(--muted)", fontSize: 12, fontWeight: 600, textAlign: "left", cursor: "pointer" }}><span style={{ width: 16, height: 16, borderRadius: 5, flexShrink: 0, display: "grid", placeItems: "center", background: cPerms.includes(p.key) ? "var(--accent)" : "transparent", border: "1.5px solid " + (cPerms.includes(p.key) ? "var(--accent)" : "var(--border)"), color: "#fff" }}>{cPerms.includes(p.key) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</span>{p.label}</button>)}</div>}
      {orgs.length > 1 && <><div style={{ height: 14 }} /><label style={lbl}>Организация</label><select style={{ ...input, marginTop: 6 }} value={org} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o) => <option key={o} value={o}>{o}</option>)}</select></>}
      <div style={{ height: 14 }} />
      <label style={lbl}>Лимит места, ГБ</label>
      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
        <input style={{ ...input, marginTop: 0, maxWidth: 120 }} value={quotaGb} onChange={(e) => setQuotaGb(e.target.value.replace(/[^0-9.,]/g, ""))} placeholder="без лимита" inputMode="decimal" />
        <div style={{ display: "flex", gap: 6 }}>{["1", "5", "10"].map((g) => <button key={g} style={{ ...ghost, padding: "7px 11px" }} onClick={() => setQuotaGb(g)}>{g}</button>)}</div>
      </div>
      <div style={{ height: 14 }} />
      <label style={lbl}>Пароль</label>
      <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
        <input style={{ ...input, marginTop: 0 }} value={pass} onChange={(e) => setPass(e.target.value)} placeholder="минимум 6 символов" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button style={{ ...ghost, whiteSpace: "nowrap" }} onClick={() => setPass(genPassword())}>Сгенерировать</button>
      </div>
      <button style={{ ...btn, width: "100%", marginTop: 20, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={create}>{busy ? <><span className="spinner spinner--on-accent" /> Создаю…</> : "Создать профиль"}</button>
      {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{err}</div>}
    </Drawer>
  );
}

function MRoles({ login, pw, roles, setRoles, counts, roleName }: { login: string; pw: string; roles: RoleDef[]; setRoles: (r: RoleDef[]) => void; counts: Row[]; roleName: (k: string) => string }) {
  const [cur, setCur] = useState(roles[0]?.key || "director");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const role = roles.find((r) => r.key === cur) || roles[0];
  const roleCount = (k: string) => counts.filter((p) => p.role === k && !p.revoked).length;
  const has = (p: string) => (role?.perms || []).includes(p);
  const toggle = (p: string) => { const next = roles.map((r) => r.key === cur ? { ...r, perms: has(p) ? r.perms.filter((x) => x !== p) : [...r.perms, p] } : r); setRoles(next); setOk(false); };
  const save = async () => { setBusy(true); setOk(false); try { await invoke("sv_save_roles", { masterLogin: login, masterPassword: pw, roles }); setOk(true); } catch { /* */ } setBusy(false); };
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyOk, setApplyOk] = useState(0);
  const [confirmApply, setConfirmApply] = useState(false);
  const targets = counts.filter((p) => p.role === cur && !p.revoked);
  const applyToExisting = async () => {
    setApplyBusy(true); setApplyOk(0); let n = 0;
    try { await invoke("sv_save_roles", { masterLogin: login, masterPassword: pw, roles }); } catch { /* */ }
    for (const p of targets) {
      try { await invoke("sv_set_perms", { masterLogin: login, masterPassword: pw, login: p.login, role: cur, perms: role?.perms || [] }); n++; } catch { /* */ }
    }
    setApplyOk(n); setApplyBusy(false); setConfirmApply(false);
  };
  return <>
    <div className="shead"><div style={{ flex: 1, minWidth: 160 }}><h1>Роли и права</h1></div>
      <button className="chip grad" onClick={save} disabled={busy}>{busy ? <span className="spinner spinner--on-accent" /> : ok ? "Сохранено ✓" : "Сохранить"}</button>
    </div>
    <div className="two">
      <div className="card glass shadow"><h3><span className="rail5" />Роли</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{roles.map((r) => <button key={r.key} className={"rolechip" + (cur === r.key ? " on" : "")} onClick={() => { setCur(r.key); setOk(false); }}>{r.name}<span className="cnt">{roleCount(r.key)}</span></button>)}</div>
        <div className="sub" style={{ marginTop: 14, lineHeight: 1.5 }}>Роль «{roleName(cur)}» сейчас у {roleCount(cur)} профиля(ей). Изменения прав применяются к <b style={{ color: "var(--text-2)" }}>новым</b> профилям этой роли; у существующих права меняются при сбросе пароля.</div>
      </div>
      <div className="card glass shadow"><h3><span className="rail5" />Права роли «{roleName(cur)}»</h3>
        {PERMS.map((g) => <div key={g.group}><div className="permgroup">{g.group}</div>{g.items.map((it) => <div key={it.key} className="permrow"><div className="pt"><div className="nm">{it.label}</div></div><div className={"switch2" + (has(it.key) ? " on" : "")} onClick={() => toggle(it.key)}><i /></div></div>)}</div>)}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border-2)" }}>
          {!confirmApply ? <>
            <button className="chip" style={{ width: "100%", justifyContent: "center" }} disabled={targets.length === 0} onClick={() => { setConfirmApply(true); setApplyOk(0); }}>Применить к {targets.length} существующим профилям</button>
            {applyOk > 0 && <div className="sub" style={{ marginTop: 8, color: "var(--good)" }}>Права обновлены у {applyOk} профиля(ей) ✓</div>}
            <div className="sub" style={{ marginTop: 8, fontSize: 11 }}>По умолчанию новые права получают только новые профили. Эта кнопка перезапишет права у всех профилей роли «{roleName(cur)}» (кроме тех, у кого настроены индивидуальные права — они тоже будут перезаписаны).</div>
          </> : <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 11, background: "var(--warn-tint,rgba(240,180,40,.1))", border: "1px solid var(--warn)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Перезаписать права у {targets.length} профиля(ей)?</div>
            <div className="sub" style={{ fontSize: 12 }}>Всем профилям роли «{roleName(cur)}» будут выставлены текущие права роли. Индивидуальные настройки этих профилей будут заменены.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="chip grad" style={{ flex: 1, justifyContent: "center" }} disabled={applyBusy} onClick={applyToExisting}>{applyBusy ? <span className="spinner spinner--on-accent" /> : "Да, применить"}</button>
              <button className="chip" style={{ flex: 1, justifyContent: "center" }} disabled={applyBusy} onClick={() => setConfirmApply(false)}>Отмена</button>
            </div>
          </div>}
        </div>
      </div>
    </div>
  </>;
}

function OrgSettings({ login, pw, org, dirs, onBack, onRenamed }: { login: string; pw: string; org: string; dirs: DirLite[]; onBack: () => void; onRenamed: (oldName: string, newName: string) => void }) {
  const [cfg, setCfg] = useState<{ deadline_day: number; review_on: boolean; default_folders: string[] }>({ deadline_day: 0, review_on: true, default_folders: [] });
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<string[]>([]);
  const [nf, setNf] = useState("");
  const [savingF, setSavingF] = useState(false);
  const [rn, setRn] = useState(org);
  const [rnBusy, setRnBusy] = useState(false);
  useEffect(() => { (async () => { setLoading(true); try { const c = await invoke<{ deadline_day: number; review_on: boolean; default_folders: string[] }>("sv_orgcfg_get", { masterLogin: login, masterPassword: pw, org }); setCfg(c); setFolders(c.default_folders); } catch { /* */ } setLoading(false); })(); }, [org]);
  const save = async (patch: Partial<{ deadline_day: number; review_on: boolean; default_folders: string[] }>) => { const next = { ...cfg, ...patch }; setCfg(next); try { await invoke("sv_orgcfg_set", { masterLogin: login, masterPassword: pw, org, deadlineDay: next.deadline_day, reviewOn: next.review_on, defaultFolders: next.default_folders }); } catch { /* */ } };
  const dirtyF = JSON.stringify(folders) !== JSON.stringify(cfg.default_folders);
  const addF = () => { const v = nf.trim(); if (v && !folders.includes(v)) setFolders((f) => [...f, v]); setNf(""); };
  const saveF = async () => { setSavingF(true); try { await save({ default_folders: folders }); } catch { /* */ } setSavingF(false); };
  const doRename = async () => { const nn = rn.trim(); if (!nn || nn === org) return; setRnBusy(true); try { await invoke("sv_rename_org", { masterLogin: login, masterPassword: pw, oldv: org, newv: nn }); onRenamed(org, nn); } catch { /* */ } setRnBusy(false); };
  if (loading) return <><div className="shead"><button className="backb" onClick={onBack}>{nic(<path d="m15 18-6-6 6-6" />, 15)}Организации</button></div><BrandLoading /></>;
  return <>
    <div className="shead"><button className="backb" style={{ marginRight: 6 }} onClick={onBack}>{nic(<path d="m15 18-6-6 6-6" />, 15)}Организации</button><div style={{ flex: 1, minWidth: 160 }}><h1>{org}</h1><div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>Правила этой организации · у каждой свои</div></div></div>
    <DisciplineCard dirs={dirs} deadlineDay={cfg.deadline_day} canEdit onSaveDeadline={(d) => save({ deadline_day: d })} />
    <div className="two">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card glass shadow"><h3><span className="rail5" />Режим проверки</h3>
          <div className="psetrow"><div className="pt"><div className="nm">Проверять отчёты</div><div className="sub">Проверяющий ставит «Принято» / «На доработку», видны статусы</div></div><div className={"switch2" + (cfg.review_on ? " on" : "")} onClick={() => save({ review_on: !cfg.review_on })}><i /></div></div>
          <div className="feat" style={{ marginTop: 6 }}>
            <span className="fi2" style={{ background: cfg.review_on ? "color-mix(in srgb,var(--good) 18%,transparent)" : "color-mix(in srgb,var(--info) 18%,transparent)", color: cfg.review_on ? "var(--good)" : "var(--info)" }}>{nic(cfg.review_on ? <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></> : <><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" /></>, 15)}</span>
            <div style={{ flex: 1 }}><div className="nm">{cfg.review_on ? "Проверка включена" : "Режим хранилища"}</div><div className="sub">{cfg.review_on ? "Отчёты проходят проверку и получают статус." : "Просто сдают файлы — без статусов и очереди. Подходит для больших масштабов."}</div></div>
          </div>
        </div>
        <div className="card glass shadow"><h3><span className="rail5" />Название организации</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...input, marginTop: 0 }} value={rn} onChange={(e) => setRn(e.target.value)} />
            <button style={{ ...btn, minWidth: 130 }} disabled={rnBusy || !rn.trim() || rn.trim() === org} onClick={doRename}>{rnBusy ? <span className="spinner spinner--on-accent" /> : "Переименовать"}</button>
          </div>
        </div>
      </div>
      <div className="card glass shadow"><h3><span className="rail5" />Папки по умолчанию</h3>
        <div className="sub" style={{ marginBottom: 10 }}>Создаются в организации автоматически — профили видят их при входе. Своя структура под эту организацию.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {folders.length === 0 ? <div className="sub" style={{ padding: "4px 2px" }}>Папок по умолчанию нет.</div> : folders.map((f, i) => <div key={f} className="f" style={{ margin: 0 }}><span className="fi" style={{ background: "linear-gradient(135deg,var(--a1),var(--a2))" }}>{nic(<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />, 16)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{f}</div></div><button className="chip sm" onClick={() => setFolders((x) => x.filter((_, j) => j !== i))}>{nic(<path d="M18 6 6 18M6 6l12 12" />, 13)}</button></div>)}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...input, marginTop: 0 }} value={nf} onChange={(e) => setNf(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addF(); }} placeholder="Например: Отчёты, Документы…" />
          <button style={{ ...ghost }} onClick={addF}>Добавить</button>
        </div>
        {dirtyF && <button className="chip grad" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} disabled={savingF} onClick={saveF}>{savingF ? <span className="spinner spinner--on-accent" /> : "Сохранить папки"}</button>}
      </div>
    </div>
  </>;
}

type BackupCfg = { endpoint: string; bucket: string; region: string; access_key: string; schedule: string; has_secret: boolean; has_pass: boolean; last_run: string; last_status: string; last_output: string; running: boolean };
function MBackupCard({ login, pw, notify }: { login: string; pw: string; notify: (m: string) => void }) {
  const [cfg, setCfg] = useState<BackupCfg | null>(null);
  const [f, setF] = useState({ endpoint: "", bucket: "", region: "", access_key: "", secret_key: "", repo_pass: "", schedule: "manual" });
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const load = () => invoke<BackupCfg>("sv_backup_get", { masterLogin: login, masterPassword: pw }).then((c) => { setCfg(c); setF((p) => ({ ...p, endpoint: c.endpoint, bucket: c.bucket, region: c.region, access_key: c.access_key, schedule: c.schedule || "manual" })); }).catch(() => { /* */ });
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!cfg?.running) return; const iv = setInterval(load, 4000); return () => clearInterval(iv); }, [cfg?.running]);
  const save = async () => { setBusy("save"); try { await invoke("sv_backup_set", { masterLogin: login, masterPassword: pw, endpoint: f.endpoint.trim(), bucket: f.bucket.trim(), region: f.region.trim(), accessKey: f.access_key.trim(), secretKey: f.secret_key, repoPass: f.repo_pass, schedule: f.schedule }); setF((p) => ({ ...p, secret_key: "", repo_pass: "" })); setSaved(true); setTimeout(() => setSaved(false), 1600); await load(); } catch (e) { notify("" + String(e)); } setBusy(""); };
  const run = async () => { setBusy("run"); try { await invoke("sv_backup_run", { masterLogin: login, masterPassword: pw }); notify("Резервная копия запущена…"); setTimeout(load, 1200); } catch (e) { notify("" + String(e)); } setBusy(""); };
  const fld = (label: string, key: keyof typeof f, ph: string, type = "text") => <div><label style={{ ...lbl, display: "block", marginBottom: 4 }}>{label}</label><input type={type} style={{ ...input, marginTop: 0 }} value={f[key]} onChange={(e) => setF((p) => ({ ...p, [key]: e.target.value }))} placeholder={ph} autoCapitalize="off" autoCorrect="off" spellCheck={false} /></div>;
  const st = cfg?.running ? "running" : cfg?.last_status || "";
  const stCol = st === "ok" ? "var(--good)" : st === "error" ? "var(--danger)" : st === "running" ? "var(--warn)" : "var(--muted)";
  return <div className="card glass shadow"><h3><span className="rail5" />Резервные копии (S3){saved && <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: "var(--good)" }}>сохранено ✓</span>}</h3>
    <div className="sub" style={{ marginBottom: 12, lineHeight: 1.5 }}>Зашифрованная копия (restic) во внешнее S3-хранилище. Ключ архива держите и офлайн — без него копию не восстановить.</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {fld("Endpoint (адрес S3)", "endpoint", "s3.amazonaws.com или minio.my.ru")}
      {fld("Бакет", "bucket", "securevault-backup")}
      {fld("Регион", "region", "ru-central1")}
      {fld("Access Key", "access_key", "AKIA…")}
      {fld("Secret Key", "secret_key", cfg?.has_secret ? "•••••• (установлен)" : "секретный ключ", "password")}
      {fld("Ключ архива", "repo_pass", cfg?.has_pass ? "•••••• (установлен)" : "пароль шифрования копии", "password")}
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
      <label style={{ ...lbl }}>Расписание:</label>
      <div style={{ display: "flex", gap: 6 }}>{([["manual", "Вручную"], ["daily", "Ежедневно"], ["weekly", "Еженедельно"]] as [string, string][]).map(([k, l]) => <button key={k} className={"rolechip" + (f.schedule === k ? " on" : "")} style={{ padding: "6px 11px", fontSize: 12.5 }} onClick={() => setF((p) => ({ ...p, schedule: k }))}>{l}</button>)}</div>
    </div>
    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <button style={{ ...btn }} disabled={!!busy} onClick={save}>{busy === "save" ? <span className="spinner spinner--on-accent" /> : "Сохранить"}</button>
      <button style={{ ...ghost }} disabled={!!busy || cfg?.running} onClick={run}>{busy === "run" || cfg?.running ? <><span className="spinner" /> Выполняется…</> : "Сделать копию сейчас"}</button>
    </div>
    {(cfg?.last_run || cfg?.running) && <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--border-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: stCol }} /><b style={{ color: stCol }}>{st === "running" ? "Выполняется…" : st === "ok" ? "Успешно" : st === "error" ? "Ошибка" : "—"}</b>{cfg?.last_run && <span style={{ color: "var(--muted)" }}>· {new Date(cfg.last_run).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}</div>
      {cfg?.last_output && st !== "running" && <div style={{ marginTop: 6, fontFamily: "ui-monospace,monospace", fontSize: 10.5, color: "var(--muted-2)", whiteSpace: "pre-wrap", maxHeight: 90, overflow: "auto" }}>{cfg.last_output}</div>}
    </div>}
  </div>;
}

function MSecurity({ server, login, pw, org, roles, lic, setLic, notify }: { server: string; login: string; pw: string; org: string; roles: RoleDef[]; lic: License | null; setLic: (l: License) => void; notify: (m: string) => void }) {
  const METHODS = ["password", "flash", "yubikey"] as const;
  const [policy, setPolicy] = useState<Record<string, string[]>>({});
  const [polSaved, setPolSaved] = useState(false);
  useEffect(() => { (async () => { try { const s = await invoke<string>("sv_login_policy_get", { masterLogin: login, masterPassword: pw, org }); if (s) setPolicy(JSON.parse(s)); } catch { /* */ } })(); }, []);
  const rowMethods = (rk: string) => policy[rk] && policy[rk].length ? policy[rk] : ["password"];
  const savePolicy = async (p: Record<string, string[]>) => { try { await invoke("sv_login_policy_set", { masterLogin: login, masterPassword: pw, org, policy: JSON.stringify(p) }); setPolSaved(true); setTimeout(() => setPolSaved(false), 1600); } catch { /* */ } };
  const toggleM = (rk: string, m: string) => { if (m === "password") return; const cur = new Set(rowMethods(rk)); cur.has(m) ? cur.delete(m) : cur.add(m); cur.add("password"); const next = { ...policy, [rk]: [...cur] }; setPolicy(next); savePolicy(next); };
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const renew = async () => { if (!code.trim()) return; setBusy(true); setErr(""); try { setLic(await invoke<License>("sv_renew_license", { server, login, password: pw, licenseCode: code.trim() })); setCode(""); } catch (e) { setErr("" + String(e)); } setBusy(false); };
  const lSub = !!(lic && lic.kind !== "perpetual" && lic.exp);
  const lDays = lic && lic.exp ? Math.max(0, Math.round((lic.exp * 1000 - Date.now()) / 864e5)) : 0;
  const mIco = (i: number) => nic(i === 0 ? <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></> : i === 1 ? <><rect x="7.5" y="8" width="9" height="13" rx="2" /><path d="M10 8V4.5h4V8M12 12.5v4" /></> : <><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" /><circle cx="7" cy="12" r="1.6" /></>, 15);
  return <>
    <div className="shead"><div style={{ flex: 1 }}><h1>Безопасность</h1></div></div>
    <div className="two">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card glass shadow"><h3><span className="rail5" />Способы входа по ролям{polSaved && <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: "var(--good)" }}>сохранено ✓</span>}</h3>
          <div className="sub" style={{ marginBottom: 8 }}>Отметьте, какие входы разрешены каждой роли. Пароль включён всегда; флешка и YubiKey сохраняются и заработают, как только появятся носители.</div>
          <table className="matrix"><thead><tr><th>Роль</th><th>Пароль</th><th>Флешка</th><th>YubiKey</th></tr></thead><tbody>{roles.map((role) => { const ms = rowMethods(role.key); return <tr key={role.key}><td>{role.name}</td>{METHODS.map((m, ci) => { const on = ms.includes(m); const locked = m === "password"; return <td key={m} onClick={() => toggleM(role.key, m)} style={{ cursor: locked ? "default" : "pointer", opacity: locked ? 1 : undefined }} title={locked ? "Пароль включён всегда" : on ? "Выключить" : "Включить"}><span className={"mc" + (on ? " on" : "")}>{mIco(ci)}</span></td>; })}</tr>; })}</tbody></table>
          <div className="sub" style={{ marginTop: 10, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}><span className="st draft" style={{ fontSize: 9 }}>СКОРО</span>Флешка и YubiKey пока в разработке — настройка сохраняется и применится автоматически.</div>
        </div>
        <MBackupCard login={login} pw={pw} notify={notify} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card glass shadow"><h3><span className="rail5" />Мастер-ключ «2 из 3»</h3>
          <div className="sub">Опасные операции подтверждаются двумя держателями из трёх — по схеме Шамира.</div>
          <div className="qseg"><i className="on" /><i className="on" /><i /></div>
          <div className="sub" style={{ marginTop: 6, fontWeight: 700, color: "var(--text-2)" }}>Нужно 2 из 3</div>
          <div className="sub" style={{ marginTop: 10, fontSize: 11 }}>Работает в упрощённой форме: опасные операции подтверждает второй человек (см. «Массовое удаление»).</div>
        </div>
        <MassDeleteCard login={login} pw={pw} notify={notify} />
        <div className="card glass shadow"><h3><span className="rail5" />Лицензия</h3>
          <div className="feat"><span className="fi2">{nic(<><path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /></>, 15)}</span><div style={{ flex: 1 }}><div className="nm">{lic ? (lic.kind === "perpetual" ? "Бессрочная" : "Подписка") : "—"}</div><div className="sub">{lic && lic.kind !== "perpetual" && lic.exp ? "до " + new Date(lic.exp * 1000).toLocaleDateString("ru-RU") : "офлайн-ключ"}</div></div><span className={"st " + (lic && lic.valid ? "ok" : "fix")}>{lic && lic.valid ? "активна" : "истекла"}</span></div>
          {lSub && (() => { const col = !lic!.valid ? "var(--danger)" : lDays <= 7 ? "var(--danger)" : lDays <= 30 ? "var(--warn)" : "var(--good)"; const pct = Math.max(4, Math.min(100, Math.round(lDays / 365 * 100))); return <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 12.5, color: "var(--muted)" }}>До окончания</span><span style={{ fontSize: 17, fontWeight: 800, color: col, fontFamily: "var(--fsora)" }}>{!lic!.valid ? "истекла" : lDays + " дн."}</span></div>
            <div className="dtrack"><i style={{ width: pct + "%", background: col, height: "100%", display: "block", borderRadius: 6 }} /></div>
          </div>; })()}
          <label style={{ ...lbl, display: "block", marginTop: 14, marginBottom: 6 }}>Обновить ключ лицензии</label>
          <div style={{ display: "flex", gap: 8 }}><input style={{ ...input, marginTop: 0 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="вставьте офлайн-ключ…" autoCapitalize="off" autoCorrect="off" spellCheck={false} /><button style={{ ...btn, minWidth: 110 }} disabled={busy || !code.trim()} onClick={renew}>{busy ? <span className="spinner spinner--on-accent" /> : "Обновить"}</button></div>
          {err && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{err}</div>}
        </div>
      </div>
    </div>
  </>;
}

function MOrgs({ login, pw, orgs, setOrgs, profiles, roles, mine }: { login: string; pw: string; orgs: string[]; setOrgs: (o: string[]) => void; profiles: Row[]; roles: RoleDef[]; mine: string }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const add = async () => { if (!name.trim()) return; setBusy(true); try { setOrgs(await invoke<string[]>("sv_add_org", { masterLogin: login, masterPassword: pw, org: name.trim() })); setName(""); setAdding(false); } catch { /* */ } setBusy(false); };
  const grad = (s: string) => `linear-gradient(135deg,${avatarGrad(s)})`;
  const count = (o: string) => profiles.filter((p) => p.org === o).length;
  const isRev = (p: Row) => p.role === "reviewer" || (roles.find((r) => r.key === p.role)?.perms || []).includes("view_all");
  const orgDirs = (o: string): DirLite[] => profiles.filter((p) => p.org === o && !p.revoked && !isRev(p)).map((p) => ({ login: p.login, name: p.display_name || p.login, last_submit: p.last_submit ?? null }));
  if (sel) return <OrgSettings login={login} pw={pw} org={sel} dirs={orgDirs(sel)} onBack={() => setSel(null)} onRenamed={(o, nn) => { setOrgs(orgs.map((x) => x === o ? nn : x)); setSel(nn); }} />;
  return <>
    <div className="shead"><div style={{ flex: 1 }}><h1>Организации</h1></div>
      <button className="chip grad sm" onClick={() => { setAdding(true); setName(""); }}>{nic(<path d="M12 5v14M5 12h14" />, 15)}Добавить</button>
    </div>
    {adding && <div className="card glass shadow" style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center" }}><input style={{ ...input, marginTop: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Название организации" autoFocus /><button style={{ ...btn }} disabled={busy || !name.trim()} onClick={add}>{busy ? <span className="spinner spinner--on-accent" /> : "Создать"}</button><button style={{ ...ghost }} onClick={() => setAdding(false)}>Отмена</button></div>}
    <div className="rgrid">{orgs.map((o) => <div key={o} className="rcard" style={{ cursor: "pointer" }} onClick={() => setSel(o)}><div className="rcov" style={{ background: grad(o) }}><span className="rini">{nic(<><path d="M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M3 10l9-6 9 6z" /></>, 18)}</span>{o === mine && <span className="flag">{nic(<path d="M20 6 9 17l-5-5" />, 12)} ваша</span>}</div><div className="rb"><div className="rn">{o}</div><div className="rd">изолированная · свои ключи</div><div className="rstats"><span className="rpill">{nic(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></>, 12)}{count(o)} профилей</span><span className="rpill">{nic(<><circle cx="12" cy="12" r="3" /><path d="M12 1v6m0 10v6M4.2 4.2l4.3 4.3m7 7l4.3 4.3M1 12h6m10 0h6" /></>, 12)}настроить</span></div></div></div>)}</div>
  </>;
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

function ProfileEdit({ row, masterLogin, pw, roleName, perms, roles, onClose, onChanged }: { row: Row; masterLogin: string; pw: string; roleName: (k: string) => string; perms: string[]; roles: RoleDef[]; onClose: () => void; onChanged: () => void }) {
  const [np, setNp] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [reset, setReset] = useState<string | null>(null);
  const [curRole, setCurRole] = useState(row.role);
  const [curPerms, setCurPerms] = useState<string[]>(row.perms && row.perms.length ? row.perms : perms);
  const [rpOk, setRpOk] = useState(false);
  const [confirmRev, setConfirmRev] = useState(false);
  const hasP = (k: string) => curPerms.includes(k);
  const togP = (k: string) => { setCurPerms((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]); setRpOk(false); };
  const pickRole = (k: string) => { setCurRole(k); setCurPerms(roles.find((r) => r.key === k)?.perms || []); setRpOk(false); };
  const custom = JSON.stringify([...curPerms].sort()) !== JSON.stringify([...(roles.find((r) => r.key === curRole)?.perms || [])].sort());
  const savePerms = async () => { setBusy("perms"); setErr(""); setRpOk(false); try { await invoke("sv_set_perms", { masterLogin, masterPassword: pw, login: row.login, role: curRole, perms: curPerms }); setRpOk(true); row.role = curRole; row.perms = curPerms; } catch (e) { setErr("" + String(e)); } setBusy(""); };
  const [qGb, setQGb] = useState(row.quota_bytes ? (row.quota_bytes / 1073741824).toFixed(row.quota_bytes % 1073741824 ? 1 : 0) : "");
  const [qOk, setQOk] = useState(false);
  const used = row.used_bytes || 0;
  const [dName, setDName] = useState(row.display_name || "");
  const [nOk, setNOk] = useState(false);
  const saveName = async () => { setBusy("name"); setErr(""); setNOk(false); try { await invoke("sv_set_name", { masterLogin, masterPassword: pw, login: row.login, displayName: dName.trim() }); setNOk(true); row.display_name = dName.trim(); } catch (e) { setErr("" + String(e)); } setBusy(""); };

  const saveQuota = async () => {
    const qb = qGb.trim() ? Math.round(parseFloat(qGb.replace(",", ".")) * 1073741824) : 0;
    setBusy("quota"); setErr(""); setQOk(false);
    try { await invoke("sv_set_quota", { masterLogin, masterPassword: pw, login: row.login, quotaBytes: isNaN(qb) ? 0 : qb }); setQOk(true); row.quota_bytes = isNaN(qb) ? 0 : qb; }
    catch (e) { setErr("" + String(e)); }
    setBusy("");
  };

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
          <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)" }}>{row.display_name || row.login}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{row.display_name ? row.login + " · " : ""}{row.org} · {roleName(row.role)} · <span style={{ color: row.revoked ? "var(--danger)" : "var(--green)" }}>{row.revoked ? "отозван" : "активен"}</span></div>
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

      <div style={{ ...box, padding: "16px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)", marginBottom: 3 }}>Имя и фамилия</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>Отображается проверяющему и администратору вместо логина.</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input style={{ ...input, marginTop: 0 }} value={dName} onChange={(e) => { setDName(e.target.value); setNOk(false); }} placeholder="напр. Денис Орлов" />
          <button style={{ ...btn, whiteSpace: "nowrap", opacity: busy === "name" ? 0.7 : 1 }} disabled={!!busy} onClick={saveName}>{busy === "name" ? <span className="spinner spinner--on-accent" /> : nOk ? "Сохранено ✓" : "Сохранить"}</button>
        </div>
      </div>

      <div style={{ ...box, padding: "16px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)", marginBottom: 3 }}>Лимит места</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>Сколько места выделено этому профилю. Занято сейчас: <b style={{ color: "var(--text)" }}>{fmtGB(used)}</b>. Пусто = без лимита.</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input style={{ ...input, marginTop: 0, maxWidth: 130 }} value={qGb} onChange={(e) => { setQGb(e.target.value.replace(/[^0-9.,]/g, "")); setQOk(false); }} placeholder="без лимита" inputMode="decimal" />
          <span style={{ fontSize: 13, color: "var(--muted-2)" }}>ГБ</span>
          <div style={{ display: "flex", gap: 6 }}>{["1", "5", "10", "50"].map((g) => (<button key={g} style={{ ...ghost, padding: "6px 10px", fontSize: 12 }} onClick={() => { setQGb(g); setQOk(false); }}>{g}</button>))}</div>
          <button style={{ ...btn, whiteSpace: "nowrap", marginLeft: "auto", opacity: busy === "quota" ? 0.7 : 1 }} disabled={!!busy} onClick={saveQuota}>{busy === "quota" ? <span className="spinner spinner--on-accent" /> : qOk ? "Сохранено ✓" : "Сохранить"}</button>
        </div>
      </div>

      <div style={{ ...box, padding: "16px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--text)", marginBottom: 3 }}>Роль и права</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>Выберите роль-шаблон или настройте права индивидуально. Действуют со следующего входа сотрудника.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>{roles.map((r) => <button key={r.key} onClick={() => pickRole(r.key)} style={{ padding: "7px 12px", borderRadius: 10, fontWeight: 700, fontSize: 12.5, cursor: "pointer", border: "1px solid " + (curRole === r.key ? "transparent" : "var(--border)"), background: curRole === r.key ? "var(--accent)" : "transparent", color: curRole === r.key ? "#fff" : "var(--text-2)" }}>{r.name}</button>)}{custom && <span style={{ alignSelf: "center", fontSize: 11, fontWeight: 700, color: "var(--accent-2)", background: "var(--accent-tint)", borderRadius: 8, padding: "4px 9px" }}>индивидуально</span>}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>{PERM_FLAT.map((p) => <button key={p.key} onClick={() => togP(p.key)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 9px", borderRadius: 9, border: "none", background: hasP(p.key) ? "var(--accent-tint)" : "transparent", color: hasP(p.key) ? "var(--text)" : "var(--muted)", fontSize: 12.5, fontWeight: 600, textAlign: "left", cursor: "pointer" }}><span style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, display: "grid", placeItems: "center", background: hasP(p.key) ? "var(--accent)" : "transparent", border: "1.5px solid " + (hasP(p.key) ? "var(--accent)" : "var(--border)"), color: "#fff" }}>{hasP(p.key) && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</span>{p.label}</button>)}</div>
        <button style={{ ...btn, width: "100%", marginTop: 12, opacity: busy === "perms" ? 0.7 : 1 }} disabled={!!busy} onClick={savePerms}>{busy === "perms" ? <span className="spinner spinner--on-accent" /> : rpOk ? "Сохранено ✓" : "Сохранить роль и права"}</button>
      </div>

      {!row.revoked && !confirmRev ? (
        <button style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: 12, borderRadius: 9, border: "1px solid var(--danger)", background: "transparent", color: "var(--danger)", fontWeight: 600, fontSize: 14 }} disabled={!!busy} onClick={() => setConfirmRev(true)}>Отозвать доступ</button>
      ) : !row.revoked ? (
        <div style={{ ...box, padding: "14px 16px", borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger) 7%, transparent)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Отозвать доступ «{row.display_name || row.login}»?</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>Сотрудник сразу перестанет входить и работать. Данные сохранятся. Доступ можно вернуть позже.</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...ghost }} onClick={() => setConfirmRev(false)}>Отмена</button>
            <button style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, flex: 1, padding: 11, borderRadius: 9, border: "none", background: "var(--danger)", color: "#fff", fontWeight: 700, fontSize: 13.5, opacity: busy === "revoke" ? 0.7 : 1 }} disabled={!!busy} onClick={toggleRevoke}>{busy === "revoke" ? <span className="spinner spinner--on-accent" /> : "Да, отозвать доступ"}</button>
          </div>
        </div>
      ) : (
        <button style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: 12, borderRadius: 9, border: "1px solid var(--green)", background: "transparent", color: "var(--green)", fontWeight: 600, fontSize: 14, opacity: busy === "revoke" ? 0.7 : 1 }} disabled={!!busy} onClick={toggleRevoke}>{busy === "revoke" ? <span className="spinner" /> : "Восстановить доступ"}</button>
      )}
      {err && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 10, textAlign: "center" }}>{err}</div>}
    </Drawer>
  );
}

function MeSection({ login, pw, info, theme, onToggleTheme, onExit, allowPassword = true, showTheme = true }: { login: string; pw: string; info: MasterInfo; theme: string; onToggleTheme: () => void; onExit: () => void; allowPassword?: boolean; showTheme?: boolean }) {
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

      {showTheme && <div style={{ ...box, marginBottom: 16 }}>
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
      </div>}

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

export function DirectorHome({ info, pw, theme, onToggleTheme, onExit }: { info: MasterInfo; pw: string; theme: string; onToggleTheme: () => void; onExit: () => void }) {
  const login = info.login;
  const [section, setSection] = useState("ov");
  const [recs, setRecs] = useState<DRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [menu, setMenu] = useState(false);
  const [accent, setAccent] = useState(() => prefsCached(info.login).accent || "");
  const chAccent = (v: string) => { setAccent(v); prefsSet(info.login, pw, { accent: v }); };

  const [reviewOn, setReviewOn] = useState(true);
  const [deadlineDay, setDeadlineDay] = useState(0);
  const loadRecs = async () => { setLoading(true); try { setRecs(await invoke<DRec[]>("sv_dir_list", { login, password: pw })); } catch { /* */ } setLoading(false); };
  const loadFolders = async () => { try { setFolders(await invoke<string[]>("sv_dir_folders", { login, password: pw })); } catch { /* */ } };
  const loadCfg = () => invoke<{ review_on: boolean; deadline_day: number }>("sv_my_orgcfg", { login, password: pw }).then((c) => { setReviewOn(c.review_on); setDeadlineDay(c.deadline_day); }).catch(() => { /* */ });
  useEffect(() => { loadRecs(); loadFolders(); loadCfg(); const f = () => { loadCfg(); loadRecs(); }; window.addEventListener("focus", f); return () => window.removeEventListener("focus", f); }, []);

  const topCats = useMemo(() => {
    const set = new Set<string>();
    folders.forEach((f) => { if (f) set.add(f.split("/")[0]); });
    recs.forEach((r) => { if (r.folder) set.add(r.folder.split("/")[0]); });
    return [...set].sort();
  }, [folders, recs]);
  const go = (p: string) => { setSection("reports"); setPath(p); };
  const [jump, setJump] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const openFromLog = (rid: string) => { const r = recs.find((x) => x.id === rid); if (!r) return; setSection("reports"); setPath(r.folder || ""); setJump((j) => ({ id: rid, n: j.n + 1 })); };
  const canLog = hasPerm(info, "view_log");

  const recent = useMemo(() => [...recs].slice(0, 6), [recs]);
  const extColor = (n: string) => { const x = n.toLowerCase(); if (/\.(xlsx|xls|csv)$/.test(x)) return "linear-gradient(135deg,#12b886,#20c997)"; if (/\.pdf$/.test(x)) return "linear-gradient(135deg,#f03e5e,#ff6b81)"; if (/\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(x)) return "linear-gradient(135deg,#8b5cf6,#d946ef)"; if (/\.(docx?|rtf|svdoc|odt)$/.test(x)) return "linear-gradient(135deg,#2563eb,#60a5fa)"; return "linear-gradient(135deg,var(--a1),var(--a2))"; };
  const goFile = (r: DRec) => { setSection("reports"); setPath(r.folder || ""); setJump((j) => ({ id: r.id, n: j.n + 1 })); };
  const notSentD = (r: DRec) => r.kind === "file" && r.status !== "sent" && r.status !== "ok" && r.status !== "fix";
  const statusCount = useMemo(() => ({ review: recs.filter((r) => r.status === "sent").length, draft: recs.filter((r) => notSentD(r)).length, ok: recs.filter((r) => r.status === "ok").length, fix: recs.filter((r) => r.status === "fix").length }), [recs]);
  const issues = useMemo(() => recs.filter((r) => r.status === "fix" || notSentD(r)).slice(0, 6), [recs]);
  const sendReview = (r: DRec) => setDConfirm({ title: "Отправить на проверку?", text: "«" + r.name + "» уйдёт проверяющему. Пока идёт проверка, статус меняет проверяющий — вы сможете поправить после замечания.", danger: false, onYes: async () => { try { await invoke("sv_dir_submit_review", { login, password: pw, id: r.id }); loadRecs(); } catch { /* */ } } });
  const onReview = useMemo(() => recs.filter((r) => r.status === "sent").slice(0, 6), [recs]);
  const favRecs = useMemo(() => { let fav: string[] = []; try { fav = prefsCached(login).fav || []; } catch { /* */ } const set = new Set(fav); return recs.filter((r) => set.has(r.id)).slice(0, 5); }, [recs, login]);
  const totalSize = useMemo(() => recs.reduce((a, r) => a + (r.size || 0), 0), [recs]);
  const ovWeek = useMemo(() => { const t0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })(); const wd = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]; const days: { label: string; n: number; today: boolean }[] = []; for (let i = 6; i >= 0; i--) { const d0 = t0 - i * 864e5; const n = recs.filter((r) => { const t = Date.parse(r.at); return !isNaN(t) && t >= d0 && t < d0 + 864e5; }).length; days.push({ label: wd[new Date(d0).getDay()], n, today: i === 0 }); } return days; }, [recs]);
  const ovWeekMax = Math.max(1, ...ovWeek.map((d) => d.n));
  const fmtBytes = (n: number) => n < 1024 ? n + " Б" : n < 1048576 ? (n / 1024).toFixed(0) + " КБ" : n < 1073741824 ? (n / 1048576).toFixed(1) + " МБ" : (n / 1073741824).toFixed(1) + " ГБ";
  const greeting = (() => { const h = new Date().getHours(); return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер"; })();
  const myDeadline = useMemo(() => {
    if (deadlineDay <= 0) return null;
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const last = recs.reduce((m, r) => Math.max(m, Date.parse(r.at) || 0), 0);
    const done = last >= periodStart;
    const dl = new Date(now.getFullYear(), now.getMonth(), deadlineDay, 23, 59, 59);
    const daysLeft = Math.ceil((dl.getTime() - now.getTime()) / 864e5);
    const month = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("ru-RU", { month: "long" });
    return { done, daysLeft, month };
  }, [deadlineDay, recs]);
  const initials = (info.me_name || login).trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase() || login.slice(0, 1).toUpperCase();
  const lastOpened = useMemo(() => { try { const id = localStorage.getItem("sv-last-" + login); return id ? recs.find((r) => r.id === id) : undefined; } catch { return undefined; } }, [recs, login, section]);
  const [trashN, setTrashN] = useState(0);
  const [quota, setQuota] = useState<{ quota_bytes: number; used_bytes: number } | null>(null);
  const [net, setNet] = useState<{ server: boolean; ms: number; iface: string } | null>(null);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [openTrashSig, setOpenTrashSig] = useState(0);
  const [dConfirm, setDConfirm] = useState<{ title: string; text: string; danger?: boolean; onYes: () => void } | null>(null);
  useEffect(() => {
    invoke<{ id: string }[]>("sv_dir_trash", { login, password: pw }).then((t) => setTrashN(t.length)).catch(() => { /* */ });
    const loadQuota = () => invoke<{ quota_bytes: number; used_bytes: number }>("sv_my_quota", { login, password: pw }).then(setQuota).catch(() => { /* */ });
    loadQuota();
    const ping = () => invoke<{ server: boolean; ms: number; iface: string }>("sv_net_status").then(setNet).catch(() => setNet({ server: false, ms: 0, iface: "" }));
    ping();
    const iv = setInterval(ping, 15000);
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on); window.addEventListener("offline", on);
    return () => { clearInterval(iv); window.removeEventListener("online", on); window.removeEventListener("offline", on); };
  }, [section]);
  const netOk = online && (net ? net.server : true);
  const recheck = () => { setOnline(typeof navigator !== "undefined" ? navigator.onLine : true); invoke<{ server: boolean; ms: number; iface: string }>("sv_net_status").then(setNet).catch(() => setNet({ server: false, ms: 0, iface: "" })); };
  const openTrashFromOv = () => { setSection("reports"); setPath(""); setOpenTrashSig((s) => s + 1); };

  const Pill = ({ id, label, icon }: { id: string; label: string; icon: React.ReactNode }) => (
    <button className={!menu && section === id ? "on" : ""} onClick={() => { setMenu(false); if (id === "reports") go(""); else setSection(id); }}>{icon}{label}</button>
  );
  const accents: [string, string][] = [["", "#6366f1,#22d3ee"], ["royal", "#4f46e5,#a855f7"], ["violet", "#8b5cf6,#ec4899"], ["ocean", "#2563eb,#22d3ee"], ["emerald", "#10b981,#2dd4bf"], ["sunset", "#fb7185,#fbbf24"], ["graphite", "#475569,#0ea5e9"]];

  return (
    <div className="ws" data-theme={theme} data-accent={accent || undefined} style={{ height: "100%", overflow: "auto", position: "relative" }} onClick={() => menu && setMenu(false)}>
      <div className="aura"><b /><b /><b /></div>
      {(!online || (net && !net.server)) && (
        <div className="offbar" role="alert">
          <span className="offbar-ic">{nic(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>, 20)}</span>
          <div className="offbar-tx">
            <b>{!online ? "Нет подключения к интернету" : "Сервер недоступен"}</b>
            <span>{!online ? "Проверьте Wi-Fi или кабель. Пока связи нет, файлы не загрузятся и не откроются." : "Не удаётся связаться с сервером. Загрузка и открытие файлов не сработают, пока связь не восстановится."}</span>
          </div>
          <button className="offbar-btn" onClick={recheck}>{nic(<><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></>, 15)}Повторить</button>
        </div>
      )}
      <div className="wrap">
        <div className="pbar glass shadow">
          <div className="bn"><i>{nic(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />)}</i></div>
          <nav className="pills">
            <Pill id="ov" label="Обзор" icon={nic(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>)} />
            <Pill id="reports" label="Диск" icon={nic(<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />)} />
            {canLog && <Pill id="log" label="Журнал" icon={nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>)} />}
          </nav>
          <div className="r">
            {quota && (() => {
              const q = quota.quota_bytes, u = quota.used_bytes;
              const pct = q > 0 ? Math.min(100, Math.round((u / q) * 100)) : 0;
              const col = pct > 90 ? "var(--danger)" : pct > 75 ? "var(--warn)" : "var(--a1)";
              return <button className="topchip tipbtn tipdown" data-tip={q > 0 ? `Занято ${fmtBytes(u)} из ${fmtBytes(q)}` : `Занято ${fmtBytes(u)} · без лимита`} onClick={() => go("")}>
                <span className="topchip-ic">{nic(<><path d="M22 12H2M5 12V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M6 16h.01M10 16h.01" /></>, 15)}</span>
                {q > 0
                  ? <span className="topchip-bar"><i style={{ width: pct + "%", background: col }} /></span>
                  : null}
                <span className="topchip-t">{q > 0 ? `${fmtBytes(u)} / ${fmtBytes(q)}` : fmtBytes(u)}</span>
              </button>;
            })()}
            <button className="topnet tipbtn tipdown" data-tip={!online ? "Нет интернета" : net ? (net.server ? `Сервер в сети · ${net.ms} мс${net.iface ? " · " + net.iface : ""}` : "Сервер недоступен") : "Проверка…"}>
              <span className={"topnet-dot " + (netOk ? "on" : "off")} />
              {online
                ? nic(<><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" /></>, 17)
                : nic(<><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" /></>, 17)}
            </button>
            <NotifBell login={login} pw={pw} onOpen={(n) => { if (n.rid) openFromLog(n.rid); }} />
            <div className="avatar" onClick={(e) => e.stopPropagation()}>
              <button className="btnav" onClick={() => setMenu((m) => !m)}><span className="ava on-dot">{login.slice(0, 1).toUpperCase()}</span></button>
              <div className="menu glass shadow" hidden={!menu}>
                <div className="mhd"><span className="ava" style={{ width: 34, height: 34 }}>{login.slice(0, 1).toUpperCase()}</span><div><div style={{ fontWeight: 700, fontSize: 13 }}>{login}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>Директор · {info.org}</div></div></div>
                <button className="mi" onClick={() => { setMenu(false); setSection("profile"); }}>{nic(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>)}Мой профиль</button>
                <button className="mi" style={{ color: "var(--danger)" }} onClick={onExit}>{nic(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>)}Выйти</button>
              </div>
            </div>
          </div>
        </div>

        {section === "ov" && <>
          <div className="shead"><div className="headava">{initials}</div><div style={{ flex: 1, minWidth: 200 }}><h1>{greeting}{info.me_name ? ", " + info.me_name.split(" ")[0] : ""}</h1><div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>{info.org} · {recs.length} файлов · {fmtSize(totalSize)}{reviewOn && statusCount.fix > 0 ? " · " : ""}{reviewOn && statusCount.fix > 0 && <span style={{ color: "var(--danger)", fontWeight: 700 }}>{statusCount.fix} замечани{statusCount.fix === 1 ? "е" : statusCount.fix < 5 ? "я" : "й"}</span>}</div></div>
            {hasPerm(info, "submit") && <button className="chip grad" onClick={() => go("")}>{nic(<path d="M12 5v14M5 12h14" />)}Создать</button>}
          </div>
          <div className="strip">
            <div className="kpi glass in" onClick={() => go("")} style={{ cursor: "pointer" }}><span className="d" style={{ background: "var(--info)" }} /><div className="n">{recs.length}</div><div className="k">Всего файлов</div></div>
            {reviewOn ? <>
              <div className="kpi glass in" onClick={() => go("")} style={{ animationDelay: ".05s", cursor: "pointer" }}><span className="d" style={{ background: "var(--info)" }} /><div className="n" style={{ color: "var(--info)" }}>{statusCount.draft}</div><div className="k">Черновики</div></div>
              <div className="kpi glass in" onClick={() => go("")} style={{ animationDelay: ".1s", cursor: "pointer" }}><span className="d" style={{ background: "var(--warn)" }} /><div className="n" style={{ color: "var(--warn)" }}>{statusCount.review}</div><div className="k">На проверке</div></div>
              <div className="kpi glass in" onClick={() => go("")} style={{ animationDelay: ".15s", cursor: "pointer" }}><span className="d" style={{ background: "var(--danger)" }} /><div className="n" style={{ color: "var(--danger)" }}>{statusCount.fix}</div><div className="k">Замечания</div></div>
            </> : <>
              <div className="kpi glass in" onClick={() => go("")} style={{ animationDelay: ".05s", cursor: "pointer" }}><span className="d" style={{ background: "var(--a3)" }} /><div className="n">{topCats.length}</div><div className="k">Папок</div></div>
              <div className="kpi glass in" style={{ animationDelay: ".1s" }}><span className="d" style={{ background: "var(--good)" }} /><div className="n">{fmtSize(totalSize)}</div><div className="k">Объём</div></div>
              <div className="kpi glass in" style={{ animationDelay: ".15s" }}><span className="d" style={{ background: "var(--warn)" }} /><div className="n">{ovWeek.reduce((a, d) => a + d.n, 0)}</div><div className="k">За неделю</div></div>
            </>}
          </div>
          {myDeadline && <div className="card glass shadow" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 14, borderLeft: "3px solid " + (myDeadline.done ? "var(--good)" : myDeadline.daysLeft < 0 ? "var(--danger)" : myDeadline.daysLeft <= 3 ? "var(--warn)" : "var(--a1)") }}>
            <span className="fi lg" style={{ background: myDeadline.done ? "linear-gradient(135deg,var(--good),#2dd4bf)" : myDeadline.daysLeft < 0 ? "linear-gradient(135deg,#f03e5e,#ff6b81)" : "linear-gradient(135deg,var(--a1),var(--a2))", flexShrink: 0 }}>{nic(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>, 20)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="nm" style={{ fontSize: 15, fontWeight: 700 }}>Срок сдачи отчёта — до {deadlineDay}-го числа</div>
              <div className="sub">{myDeadline.done ? "Вы уже сдавали в этом месяце — спасибо." : myDeadline.daysLeft < 0 ? `Срок прошёл ${-myDeadline.daysLeft} дн. назад` : myDeadline.daysLeft === 0 ? "Сдать нужно сегодня" : `Осталось ${myDeadline.daysLeft} дн. до срока`} · {myDeadline.month}</div>
            </div>
            <span className="st" style={{ background: `color-mix(in srgb, ${myDeadline.done ? "var(--good)" : myDeadline.daysLeft < 0 ? "var(--danger)" : myDeadline.daysLeft <= 3 ? "var(--warn)" : "var(--a1)"} 16%, transparent)`, color: myDeadline.done ? "var(--good)" : myDeadline.daysLeft < 0 ? "var(--danger)" : myDeadline.daysLeft <= 3 ? "var(--warn)" : "var(--a1)" }}>{myDeadline.done ? "сдано" : myDeadline.daysLeft < 0 ? "просрочено" : "ожидается"}</span>
            {hasPerm(info, "submit") && !myDeadline.done && <button className="chip grad" onClick={() => go("")}>{nic(<path d="M12 5v14M5 12h14" />, 15)}Сдать</button>}
          </div>}
          <div className="three">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {lastOpened && <div className="card glass shadow resume" onClick={() => goFile(lastOpened)}>
                <div className="resume-row">
                  <span className="fi lg" style={{ background: extColor(lastOpened.name) }}>{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}><div className="sub" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--muted)" }}>Продолжить</div><div className="nm" style={{ fontSize: 15, fontWeight: 700 }}>{lastOpened.name}</div><div className="sub">{lastOpened.folder || "корень"}</div></div>
                  <span className="resume-go">{nic(<path d="M9 18l6-6-6-6" />)}</span>
                </div>
              </div>}
              <div className="card glass shadow"><h3><span className="rail5" />Действия</h3><div className="qa">
                {hasPerm(info, "submit") && <button className="chip grad" onClick={() => go("")}>{nic(<path d="M12 5v14M5 12h14" />)}Создать отчёт</button>}
                {hasPerm(info, "submit") && <button className="chip" onClick={() => go("")}>{nic(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></>)}Добавить файл</button>}
                {canLog && <button className="chip" onClick={() => setSection("log")}>{nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>)}Журнал</button>}
              </div></div>
              <div className="card glass shadow"><h3><span className="rail5" />Мой диск</h3>
                {topCats.length === 0 ? <div className="sub">Папок пока нет</div> : topCats.slice(0, 6).map((c) => (
                  <div key={c} className="fold" onClick={() => go(c)}><span className="foli">{nic(<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />)}</span><div style={{ flex: 1 }}><div className="nm">{c}</div><div className="sub">{recs.filter((r) => (r.folder || "").split("/")[0] === c).length} файл.</div></div></div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {reviewOn && <div className="card glass shadow"><h3><span className="rail5" style={(statusCount.fix + statusCount.draft) > 0 ? { background: "linear-gradient(var(--warn),#ffa94d)" } : undefined} />Требует внимания{(statusCount.fix + statusCount.draft) > 0 && <span className="n" style={{ marginLeft: 2 }}>{statusCount.fix + statusCount.draft}</span>}</h3>
                {issues.length === 0 ? <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)", padding: "4px 2px" }}><span style={{ color: "var(--good)", display: "flex" }}>{nic(<path d="M20 6 9 17l-5-5" />)}</span>Всё сдано — черновиков и замечаний нет.</div>
                  : issues.map((r) => (
                    <div key={r.id} className="f" onClick={() => goFile(r)}>
                      <span className="fi" style={{ background: extColor(r.name) }}>{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{r.name}</div><div className="sub">{r.folder ? r.folder + " · " : ""}{notSentD(r) ? "не отправлен на проверку" : "замечание проверяющего"}</div></div>
                      {hasPerm(info, "submit") ? <button className="chip grad sm" onClick={(e) => { e.stopPropagation(); sendReview(r); }}>Сдать</button> : <span className={"st " + (notSentD(r) ? "draft" : "fix")}>{notSentD(r) ? "черновик" : "замечание"}</span>}
                    </div>
                  ))}
              </div>}
              {reviewOn && <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(var(--warn),#ffa94d)" }} />На проверке{onReview.length > 0 && <span className="n" style={{ marginLeft: 2 }}>{onReview.length}</span>}</h3>
                {onReview.length === 0 ? <div className="sub" style={{ padding: "4px 2px" }}>Нет файлов на проверке.</div>
                  : onReview.map((r) => (
                    <div key={r.id} className="f" onClick={() => goFile(r)}>
                      <span className="fi" style={{ background: extColor(r.name) }}>{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{r.name}</div><div className="sub">{r.folder ? r.folder + " · " : ""}ждёт решения проверяющего</div></div>
                      <span className="st wait">на проверке</span>
                    </div>
                  ))}
              </div>}
              <div className="card glass shadow"><h3><span className="rail5" />Последние файлы</h3>
                {loading ? <BrandLoading pad={16} />
                  : recent.length === 0 ? <div className="empty">Пока ничего не сдано. Нажмите «Создать».</div>
                    : recent.map((r) => (
                      <div key={r.id} className="f" onClick={() => goFile(r)}>
                        <span className="fi" style={{ background: extColor(r.name) }}>{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{r.name}</div><div className="sub">{fmtDate(r.at)}{r.folder ? " · " + r.folder : ""}</div></div>
                        {r.comments > 0 && <button className="cbtn">{nic(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />)}{r.comments}</button>}
                      </div>
                    ))}
              </div>
              <div className="card glass shadow"><h3><span className="rail5" />Активность за неделю</h3>
                <div className="week" style={{ height: 112, "--wmax": "100%", "--wgap": "10px" } as React.CSSProperties}>{ovWeek.map((d, i) => (<div key={i} className={"wd" + (d.today ? " today" : "")}><span className="wn">{d.n || ""}</span><div className="wtrack"><i className="wb" style={{ height: Math.max(4, Math.round((d.n / ovWeekMax) * 100)) + "%" }} /></div><span className="wl">{d.label}</span></div>))}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {favRecs.length > 0 && <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(#f59e0b,#fbbf24)" }} />Избранное</h3>
                <div className="favgrid">{favRecs.map((r) => (
                  <div key={r.id} className="favcard" onClick={() => goFile(r)}>
                    <span className="fi" style={{ background: extColor(r.name) }}>{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>)}</span>
                    <div className="nm" title={r.name}>{r.name}</div>
                    <div className="sub">{r.folder || "корень"}</div>
                  </div>
                ))}</div>
              </div>}
              {reviewOn && <div className="card glass shadow"><h3><span className="rail5" />Статусы</h3>
                {recs.length === 0 ? <div className="sub" style={{ padding: "4px 2px" }}>Пока нет файлов.</div> : (() => {
                  const segs = [{ k: "ok", n: statusCount.ok, c: "var(--good)", t: "Принято" }, { k: "review", n: statusCount.review, c: "var(--warn)", t: "На проверке" }, { k: "fix", n: statusCount.fix, c: "var(--danger)", t: "Замечания" }].filter((s) => s.n > 0);
                  const tot = recs.length, R = 52, C = 2 * Math.PI * R; let acc = 0;
                  return <div className="donut-wrap">
                    <svg viewBox="0 0 130 130" className="donut">
                      <circle cx="65" cy="65" r={R} fill="none" stroke="color-mix(in srgb,var(--text) 8%,transparent)" strokeWidth="13" />
                      {segs.map((s) => { const len = (s.n / tot) * C, off = acc; acc += len; return <circle key={s.k} cx="65" cy="65" r={R} fill="none" stroke={s.c} strokeWidth="13" strokeLinecap="round" strokeDasharray={`${Math.max(0, len - 3)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 65 65)" />; })}
                      <text x="65" y="60" textAnchor="middle" className="donut-n">{tot}</text>
                      <text x="65" y="78" textAnchor="middle" className="donut-l">файлов</text>
                    </svg>
                    <div className="donut-leg">{segs.map((s) => (<div key={s.k} className="dleg" onClick={() => go("")}><span className="d" style={{ background: s.c }} /><span className="dleg-t">{s.t}</span><span className="dleg-n">{s.n}</span></div>))}</div>
                  </div>;
                })()}
              </div>}
              <div className="card glass shadow trashcard" onClick={openTrashFromOv}>
                <span className="trashcard-ic">{nic(<><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>, 18)}</span>
                <div style={{ flex: 1, minWidth: 0 }}><div className="nm">Корзина</div><div className="sub">{trashN > 0 ? `${trashN} удалённых — можно вернуть` : "Пусто"}</div></div>
                <span className="resume-go">{nic(<path d="M9 18l6-6-6-6" />, 15)}</span>
              </div>
            </div>
          </div>
        </>}

        {section === "reports" && <div style={{ marginTop: 2 }}><DirReports login={login} pw={pw} info={info} recs={recs} loading={loading} reloadRecs={loadRecs} folders={folders} reloadFolders={loadFolders} path={path} setPath={setPath} jump={jump} openTrashSig={openTrashSig} reviewOn={reviewOn} /></div>}
        {section === "log" && <JournalMine login={login} pw={pw} onOpenFile={openFromLog} />}
        {section === "profile" && <>
          <div className="card glass shadow" style={{ marginBottom: 14 }}><h3><span className="rail5" />Оформление</h3>
            <div className="psetrow"><div className="pt"><div className="nm">Тёмная тема</div><div className="sub">Переключить вид приложения</div></div><div className={"switch2" + (theme === "dark" ? " on" : "")} onClick={onToggleTheme}><i /></div></div>
            <div className="psetrow" style={{ flexWrap: "wrap" }}><div className="pt"><div className="nm">Акцент</div><div className="sub">Цвет интерфейса — на ваш вкус</div></div>
              <div className="sws">{accents.map(([v, g]) => <span key={v || "d"} className={"sw" + (accent === v ? " on" : "")} onClick={() => chAccent(v)} style={{ background: "linear-gradient(135deg," + g + ")" }} />)}</div>
            </div>
          </div>
          <MeSection login={login} pw={pw} info={info} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} allowPassword={false} showTheme={false} />
        </>}
      </div>
      <ConfirmModal data={dConfirm} onClose={() => setDConfirm(null)} />
    </div>
  );
}

function DirReports({ login, pw, info, recs, loading, reloadRecs, folders, reloadFolders, path, setPath, heading = "Диск", sub = "", jump, openTrashSig, owner = "", rv = false, review = false, reviewOn = true, onStatus }: { login: string; pw: string; info: MasterInfo; recs: DRec[]; loading: boolean; reloadRecs: () => void; folders: string[]; reloadFolders: () => void; path: string; setPath: (p: string) => void; heading?: string; sub?: string; jump?: { id: string; n: number }; openTrashSig?: number; owner?: string; rv?: boolean; review?: boolean; reviewOn?: boolean; onStatus?: (id: string, status: string) => void }) {
  const can = (k: string) => hasPerm(info, k);
  // адаптер команд: по умолчанию «диск» (sv_dir_*), в режиме проверяющего (rv) — sv_rv_* с owner-профилем
  const dOpen = (id: string) => invoke<string>(rv ? "sv_rv_open" : "sv_dir_open", { login, password: pw, id });
  const dOpenFile = (id: string, name: string) => invoke(rv ? "sv_rv_open_file" : "sv_dir_open_file", { login, password: pw, id, filename: name });
  const dSubmit = (folder: string, title: string, kind: string, b64: string) => invoke(rv ? "sv_rv_submit" : "sv_dir_submit", rv ? { login, password: pw, owner, folder, title, kind, contentB64: b64 } : { login, password: pw, folder, title, kind, contentB64: b64 });
  const dReplace = async (replaces: string, folder: string, title: string, kind: string, b64: string) => { if (rv) { await invoke("sv_rv_submit", { login, password: pw, owner, folder, title, kind, contentB64: b64 }); await invoke("sv_rv_delete", { login, password: pw, id: replaces }); } else { await invoke("sv_dir_replace", { login, password: pw, replaces, folder, title, kind, contentB64: b64 }); } };
  const dRename = (id: string, name: string) => invoke(rv ? "sv_rv_rename" : "sv_dir_rename", { login, password: pw, id, name });
  const dMove = (id: string, folder: string) => invoke(rv ? "sv_rv_move" : "sv_dir_move", { login, password: pw, id, folder });
  const dFolderMove = (old: string, newPath: string) => invoke("sv_dir_folder_move", { login, password: pw, old, newPath });
  const dDelete = (id: string) => invoke(rv ? "sv_rv_delete" : "sv_dir_delete", { login, password: pw, id });
  const dMkfolder = (p: string) => invoke("sv_dir_mkfolder", { login, password: pw, path: p });
  const canAdd = can("submit") || (rv && can("edit"));
  const [grid, setGrid] = useState(() => prefsCached(login).view !== "list");
  const chView = (g: boolean) => { setGrid(g); prefsSet(login, pw, { view: g ? "cards" : "list" }); };
  const [favTick, setFavTick] = useState(0);
  const [favAllOpen, setFavAllOpen] = useState(false);
  const [highlight, setHighlight] = useState("");
  const goToFile = (r: DRec) => { setFavAllOpen(false); setDq(""); setPath(r.folder || ""); setHighlight(r.id); setTimeout(() => setHighlight(""), 2600); };
  useEffect(() => { if (jump && jump.id) { setHighlight(jump.id); const t = setTimeout(() => setHighlight(""), 2600); return () => clearTimeout(t); } }, [jump?.n]);
  useEffect(() => { if (openTrashSig) openTrash(); /* eslint-disable-next-line */ }, [openTrashSig]);
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const exitSel = () => { setSelMode(false); setSel(new Set()); };
  const bulkDownload = async () => { const ids = [...sel]; let i = 0; for (const id of ids) { i++; const r = recs.find((x) => x.id === id); if (!r) continue; setOpening(`Скачиваю ${i} из ${ids.length}…`); try { const b = await dOpen(id); await saveToDisk(r.name, b); } catch (e) { notify("" + String(e)); } } setOpening(""); exitSel(); };
  const bulkTrash = () => setConfirmData({ title: "Переместить в Корзину?", text: `${sel.size} файл(ов) уйдут в Корзину. Восстановить можно 30 дней.`, danger: false, onYes: async () => { const ids = [...sel]; setOpening("Удаляю…"); for (const id of ids) { try { await dDelete(id); } catch (e) { notify("" + String(e)); } } setOpening(""); exitSel(); reloadRecs(); } });
  type MItem = { label: string; icon: React.ReactNode; danger?: boolean; onClick: () => void };
  const [menu, setMenu] = useState<{ x: number; y: number; items: MItem[] } | null>(null);
  const [renameT, setRenameT] = useState<{ kind: "file" | "folder"; id?: string; path?: string } | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [movePick, setMovePick] = useState<{ files?: string[]; folder?: string } | null>(null);
  type DragInfo = { isFile: boolean; key: string; fileId: string; label: string; grad: string; fmt: string; icon: React.ReactNode };
  const dragRef = useRef<(DragInfo & { sx: number; sy: number; started: boolean }) | null>(null);
  const dropFolderRef = useRef("");
  const reorderRef = useRef<{ key: string; after: boolean } | null>(null);
  const justDragged = useRef(false);
  const [dragGhost, setDragGhost] = useState<(DragInfo & { x: number; y: number }) | null>(null);
  const [dropFolder, setDropFolder] = useState("");
  const [reorderMark, setReorderMark] = useState<{ key: string; after: boolean } | null>(null);
  const [clip, setClip] = useState<{ ids: string[]; cut: boolean } | null>(null);
  const [orderTick, setOrderTick] = useState(0);
  const onWinMove = (e: PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    if (!d.started) { if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return; d.started = true; document.body.style.userSelect = "none"; }
    setDragGhost({ ...d, x: e.clientX, y: e.clientY });
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const item = el?.closest("[data-key]") as HTMLElement | null;
    const tkey = item?.getAttribute("data-key") || "";
    const ttype = item?.getAttribute("data-type") || "";
    let moveFolder = ""; let rk: { key: string; after: boolean } | null = null;
    if (d.isFile && ttype === "folder") moveFolder = tkey.slice(2);
    else if (item && tkey && tkey !== d.key && ((d.isFile && ttype === "file") || (!d.isFile && ttype === "folder"))) { const rect = item.getBoundingClientRect(); rk = { key: tkey, after: grid ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2 }; }
    dropFolderRef.current = moveFolder; reorderRef.current = rk;
    setDropFolder(moveFolder); setReorderMark(rk);
  };
  const onWinUp = () => {
    window.removeEventListener("pointermove", onWinMove);
    document.body.style.userSelect = "";
    const d = dragRef.current; dragRef.current = null;
    const mf = dropFolderRef.current; const rk = reorderRef.current;
    dropFolderRef.current = ""; reorderRef.current = null;
    setDragGhost(null); setDropFolder(""); setReorderMark(null);
    if (d && d.started) { justDragged.current = true; setTimeout(() => { justDragged.current = false; }, 60); if (mf && d.isFile) doMoveFile(d.fileId, mf); else if (rk) doReorder(d.key, rk.key, rk.after); }
  };
  const startDrag = (e: React.PointerEvent, info: DragInfo) => {
    if (selMode || !can("edit") || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { ...info, sx: e.clientX, sy: e.clientY, started: false };
    window.addEventListener("pointermove", onWinMove);
    window.addEventListener("pointerup", onWinUp, { once: true });
  };
  const markStyle = (key: string): React.CSSProperties => reorderMark && reorderMark.key === key ? { boxShadow: grid ? (reorderMark.after ? "inset -3px 0 0 0 var(--a1)" : "inset 3px 0 0 0 var(--a1)") : (reorderMark.after ? "inset 0 -3px 0 0 var(--a1)" : "inset 0 3px 0 0 var(--a1)") } : {};
  const doCopy = (ids: string[], cut: boolean) => { if (!ids.length) return; setClip({ ids, cut }); notify(cut ? `Вырезано: ${ids.length}` : `Скопировано: ${ids.length}`); };
  const doPaste = async () => { if (!clip || !clip.ids.length) return; const cp = clip; setOpening(cp.cut ? "Перемещаю…" : "Вставляю…"); try { for (const id of cp.ids) { if (cp.cut) await invoke("sv_dir_move", { login, password: pw, id, folder: path }); else await invoke("sv_dir_copy", { login, password: pw, id, folder: path }); } reloadRecs(); } catch (e) { notify("" + String(e)); } if (cp.cut) setClip(null); setOpening(""); };
  const doReorder = (draggedKey: string, targetKey: string, after: boolean) => {
    const allKeys = [...subfolders.map((f) => "d:" + f), ...files.map((r) => r.id)];
    const without = allKeys.filter((k) => k !== draggedKey);
    let idx = without.indexOf(targetKey); if (idx < 0) return; if (after) idx++;
    without.splice(idx, 0, draggedKey);
    prefsSet(login, pw, { order: { ...(prefsCached(login).order || {}), [path]: without } });
    setOrderTick((x) => x + 1);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rv || !(e.metaKey || e.ctrlKey) || !can("edit")) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if ((k === "c" || k === "x") && sel.size > 0) { e.preventDefault(); doCopy([...sel], k === "x"); }
      else if (k === "v" && clip && clip.ids.length) { e.preventDefault(); doPaste(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, clip, path]);
  const openMenu = (e: React.MouseEvent, items: MItem[]) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ x: Math.min(r.left, window.innerWidth - 224), y: Math.min(r.bottom + 5, window.innerHeight - 12 - items.length * 40), items }); };
  const submitReview = (r: DRec) => setConfirmData({ title: "Отправить на проверку?", text: "«" + r.name + "» уйдёт проверяющему. Пока идёт проверка, статус меняет проверяющий — вы сможете поправить после замечания.", danger: false, onYes: async () => { try { await invoke("sv_dir_submit_review", { login, password: pw, id: r.id }); notify("«" + r.name + "» отправлен на проверку ✓"); reloadRecs(); } catch (e) { notify("" + String(e)); } } });
  const notSent = (r: DRec) => r.status !== "sent" && r.status !== "ok" && r.status !== "fix";
  const canSendReview = (r: DRec) => !rv && reviewOn && can("submit") && r.kind === "file" && r.status !== "sent" && r.status !== "ok";
  const acceptFile = (r: DRec) => { onStatus?.(r.id, r.status === "ok" ? "sent" : "ok"); };
  const remarkFile = (r: DRec) => { setRemarkT(r); setCmFor(r); };
  const fileMenu = (e: React.MouseEvent, r: DRec) => openMenu(e, [
    ...(canSendReview(r) ? [{ label: "Сдать на проверку", icon: gi(Ic.chk, 16, 2.4), onClick: () => submitReview(r) }] : []),
    ...(review && r.kind === "file" ? [{ label: r.status === "ok" ? "Снять «принято»" : "Принять", icon: gi(Ic.chk, 16, 2.4), onClick: () => acceptFile(r) }] : []),
    ...(review && r.kind === "file" ? [{ label: r.status === "fix" ? "Снять замечание" : "Вернуть с замечанием", icon: gi(Ic.warn, 16, 2), danger: r.status !== "fix", onClick: () => r.status === "fix" ? onStatus?.(r.id, "sent") : remarkFile(r) }] : []),
    ...(can("edit") ? [{ label: "Переименовать", icon: gi(Ic.pencil, 16, 2), onClick: () => { setRenameT({ kind: "file", id: r.id }); setRenameVal(r.name); } }] : []),
    ...(can("edit") ? [{ label: "Переместить в…", icon: gi(Ic.move, 16, 2), onClick: () => setMovePick({ files: [r.id] }) }] : []),
    ...(can("edit") && !rv ? [{ label: "Копировать", icon: gi(Ic.copy, 16, 2), onClick: () => doCopy([r.id], false) }] : []),
    ...(can("edit") && !rv ? [{ label: "Вырезать", icon: gi(Ic.cut, 16, 2), onClick: () => doCopy([r.id], true) }] : []),
    ...(r.kind === "file" && can("edit") ? [{ label: "Заменить файлом", icon: gi(Ic.rep, 16, 2), onClick: () => startReplace(r) }] : []),
    ...(r.kind === "file" && !rv ? [{ label: "История версий", icon: gi(Ic.hist, 16, 2), onClick: () => openVersions(r) }] : []),
  ]);
  const folderMenu = (e: React.MouseEvent, f: string) => { if (!canAdd) return; openMenu(e, [
    { label: "Переименовать", icon: gi(Ic.pencil, 16, 2), onClick: () => { setRenameT({ kind: "folder", path: f }); setRenameVal(base(f)); } },
    { label: "Переместить в…", icon: gi(Ic.move, 16, 2), onClick: () => setMovePick({ folder: f }) },
  ]); };
  const doRename = async () => {
    if (!renameT) { return; } const v = renameVal.trim(); if (!v) { setRenameT(null); return; }
    setOpening("Переименовываю…");
    try {
      if (renameT.kind === "file" && renameT.id) { await dRename(renameT.id, v); reloadRecs(); }
      else if (renameT.kind === "folder" && renameT.path) { const par = parentOf(renameT.path); const np = par ? par + "/" + v : v; await dFolderMove(renameT.path, np); if (path === renameT.path) setPath(np); else if (path.startsWith(renameT.path + "/")) setPath(np + path.slice(renameT.path.length)); reloadFolders(); reloadRecs(); }
    } catch (e) { notify("" + String(e)); }
    setRenameT(null); setOpening("");
  };
  const doMove = async (dest: string) => {
    if (!movePick) { return; } const mp = movePick; setMovePick(null); setOpening("Перемещаю…");
    try {
      if (mp.files) { for (const id of mp.files) { await dMove(id, dest); } reloadRecs(); exitSel(); }
      else if (mp.folder) { const np = dest ? dest + "/" + base(mp.folder) : base(mp.folder); await dFolderMove(mp.folder, np); reloadFolders(); reloadRecs(); }
    } catch (e) { notify("" + String(e)); }
    setOpening("");
  };
  const doMoveFile = async (id: string, folder: string) => { setOpening("Перемещаю…"); try { await dMove(id, folder); reloadRecs(); notify("Перемещено в «" + (base(folder) || "корень") + "»"); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const favs = useMemo(() => new Set(prefsCached(login).fav || []), [login, favTick]);
  const isFavorite = (id: string) => favs.has(id);
  const toggleFavorite = (id: string) => { toggleFav(login, pw, id); setFavTick((x) => x + 1); };
  const [dq, setDq] = useState("");
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
  const [remarkT, setRemarkT] = useState<DRec | null>(null);
  const [toast, setToast] = useState("");
  const [opening, setOpening] = useState("");
  const [versionsFor, setVersionsFor] = useState<DRec | null>(null);
  const [versions, setVersions] = useState<DVersion[]>([]);
  const [versLoading, setVersLoading] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<DTrash[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const replaceRec = useRef<DRec | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3500); };

  const join = (b: string, n: string) => (b ? b + "/" + n : n);
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const base = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
  const allNodes = useMemo(() => { const set = new Set<string>(); const add = (p: string) => { if (!p) return; const segs = p.split("/"); let cur = ""; for (const s of segs) { cur = cur ? cur + "/" + s : s; set.add(cur); } }; folders.forEach(add); recs.forEach((r) => add(r.folder)); return set; }, [folders, recs]);
  const searching = dq.trim().length > 0;
  const subfolders = useMemo(() => {
    const q = dq.trim().toLowerCase();
    const list = [...allNodes].filter((f) => (q ? base(f).toLowerCase().includes(q) : parentOf(f) === path));
    if (q) return list.sort();
    const ord = (prefsCached(login).order || {})[path] || [];
    const idx = new Map(ord.map((k, i) => [k, i] as const));
    return list.sort((a, b) => { const ia = idx.has("d:" + a) ? (idx.get("d:" + a) as number) : Infinity; const ib = idx.has("d:" + b) ? (idx.get("d:" + b) as number) : Infinity; return ia !== ib ? ia - ib : (a < b ? -1 : 1); });
  }, [allNodes, path, dq, login, orderTick]);
  const files = useMemo(() => {
    const q = dq.trim().toLowerCase();
    const list = recs.filter((r) => (q ? r.name.toLowerCase().includes(q) : (r.folder || "") === path));
    if (q) return list;
    const ord = (prefsCached(login).order || {})[path] || [];
    const idx = new Map(ord.map((k, i) => [k, i] as const));
    return [...list].sort((a, b) => { const ia = idx.has(a.id) ? (idx.get(a.id) as number) : Infinity; const ib = idx.has(b.id) ? (idx.get(b.id) as number) : Infinity; return ia !== ib ? ia - ib : (a.at < b.at ? 1 : -1); });
  }, [recs, path, dq, login, orderTick]);
  const folderCount = (f: string) => recs.filter((r) => (r.folder || "") === f || (r.folder || "").startsWith(f + "/")).length;
  const crumbs = path ? path.split("/") : [];

  const gi = (node: React.ReactNode, s = 16, sw: number = 2, stroke = "currentColor") => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{node}</svg>;
  const Ic: Record<string, React.ReactNode> = {
    fld: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />,
    doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
    xls: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
    tiles: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    up: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />,
    plus: <path d="M12 5v14M5 12h14" />,
    back: <path d="m15 18-6-6 6-6" />,
    chev: <path d="m9 18 6-6-6-6" />,
    star: <path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" />,
    chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    dl: <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></>,
    rep: <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />,
    hist: <><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
    img: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="9" r="1.6" /><path d="m21 16-5-5L5 21" /></>,
    chk: <path d="M20 6 9 17l-5-5" />,
    sel: <><path d="M9 11l3 3L20 5" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></>,
    x: <path d="M18 6 6 18M6 6l12 12" />,
    more: <><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></>,
    move: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v6M9 14l3 3 3-3" /></>,
    copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    cut: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></>,
    paste: <><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /></>,
    docx: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h5" /></>,
    pencil: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
    trash: <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />,
    warn: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  };
  const starIcon = (on: boolean, s = 15) => <svg width={s} height={s} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.8 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" /></svg>;
  const favStar = (id: string, s = 15) => rv ? null : <button className="favbtn" title={isFavorite(id) ? "Убрать из избранного" : "В избранное"} aria-label="Избранное" onClick={(e) => { e.stopPropagation(); toggleFavorite(id); }} style={{ background: "transparent", border: "none", padding: 2, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0, color: isFavorite(id) ? "#f59e0b" : "var(--muted-2)" }}>{starIcon(isFavorite(id), s)}</button>;
  const favFiles = useMemo(() => recs.filter((r) => favs.has(r.id)), [recs, favs]);
  const favFolders = useMemo(() => [...allNodes].filter((n) => favs.has("d:" + n)).sort(), [allNodes, favs]);
  const extKind = (n: string) => { const x = n.toLowerCase(); if (/\.(xlsx|xls|csv)$/.test(x)) return "xls"; if (/\.pdf$/.test(x)) return "pdf"; if (/\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(x)) return "img"; if (/\.(docx?|rtf|svdoc|odt)$/.test(x)) return "doc"; return "txt"; };
  const kindNode = (vk: string) => (vk === "xls" ? Ic.xls : vk === "img" ? Ic.img : vk === "doc" ? Ic.docx : vk === "pdf" ? Ic.doc : Ic.docx);
  const GRAD: Record<string, string> = { xls: "linear-gradient(135deg,#12b886,#20c997)", pdf: "linear-gradient(135deg,#f03e5e,#ff6b81)", img: "linear-gradient(135deg,#8b5cf6,#d946ef)", doc: "linear-gradient(135deg,#2563eb,#60a5fa)", txt: "linear-gradient(135deg,#64748b,#94a3b8)" };
  const recGrad = (r: DRec) => GRAD[extKind(r.name)] || GRAD.txt;
  const fmtLabel = (n: string) => { const m = n.toLowerCase().match(/\.([a-z0-9]+)$/); const e = m ? m[1] : ""; if (!e) return "ФАЙЛ"; if (e === "svdoc") return "ДОК"; if (e === "jpeg") return "JPG"; return e.toUpperCase(); };
  const FG = ["linear-gradient(135deg,var(--warn),#ffa94d)", "linear-gradient(135deg,#0ea5e9,#22d3ee)", "linear-gradient(135deg,var(--a1),var(--a2))", "linear-gradient(135deg,#8b5cf6,#ec4899)", "linear-gradient(135deg,#10b981,#2dd4bf)", "linear-gradient(135deg,#fb7185,#fbbf24)"];
  const fgrad = (name: string) => { let h = 0; for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0; return FG[h % FG.length]; };
  const fmtWhen = (s: string) => { try { const d = new Date(s); const diff = Date.now() - d.getTime(); if (diff < 36e5) return "недавно"; if (diff < 864e5) return "сегодня"; if (diff < 1728e5) return "вчера"; return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }); } catch { return ""; } };
  const folderWhen = (f: string) => { const ds = recs.filter((r) => (r.folder || "") === f || (r.folder || "").startsWith(f + "/")).map((r) => r.at).filter(Boolean).sort(); return ds.length ? fmtWhen(ds[ds.length - 1]) : "—"; };
  const ST: Record<string, [string, string]> = { ok: ["принято", "ok"], fix: ["замечание", "fix"], sent: ["на проверке", "wait"], draft: ["черновик", "draft"], "": ["черновик", "draft"] };
  const stPill = (s: string) => { const [lbl, cls] = ST[s] || ST[""]; return <span className={"st " + cls}>{lbl}</span>; };
  const stCover = (r: DRec) => {
    const [lbl, cls] = ST[r.status] || ST[""];
    const col = cls === "ok" ? "#12b886" : cls === "fix" ? "#f03e5e" : cls === "draft" ? "#64748b" : "#f08c00";
    const icon = cls === "ok" ? <path d="M20 6 9 17l-5-5" /> : cls === "fix" ? <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></> : cls === "draft" ? <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></> : <><circle cx="12" cy="12" r="9" /><path d="M12 12V8" /><path d="M12 12h3.5" /></>;
    const clickable = can("comments");
    return (
      <button className="stbadge" title={clickable ? lbl + " · открыть комментарий" : lbl} onClick={clickable ? (e) => { e.stopPropagation(); setCmFor(r); } : undefined} style={{ background: col, cursor: clickable ? "pointer" : "default", boxShadow: `0 1px 4px rgba(20,24,60,.28), 0 0 6px color-mix(in srgb, ${col} 50%, transparent)` }}>
        <span className="sl">{lbl}</span>
        <span className="si"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={cls === "ok" ? 3.2 : 2.4} strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>
      </button>
    );
  };
  const sendCover = (r: DRec) => (
    <button className="stbadge" title="Сдать на проверку" onClick={(e) => { e.stopPropagation(); submitReview(r); }} style={{ background: "#12b886", boxShadow: "0 1px 4px rgba(20,24,60,.28), 0 0 6px color-mix(in srgb, #12b886 50%, transparent)" }}>
      <span className="sl">сдать</span>
      <span className="si"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg></span>
    </button>
  );
  const quick = useMemo<DRec[]>(() => [...recs].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 4), [recs]);

  const createFolder = async () => { if (!fname.trim()) { setNewFolder(false); return; } try { await dMkfolder(join(path, fname.trim())); setFname(""); setNewFolder(false); reloadFolders(); } catch (e) { notify("" + String(e)); } };
  const saveToDisk = async (name: string, b64: string) => { try { await invoke<string>("sv_save_file", { filename: name, contentB64: b64 }); notify("Сохранено в папку «Загрузки»: " + name); } catch (e) { notify("" + String(e)); } };
  const submitReport = async () => {
    if (!title.trim()) { setErr("Укажите название"); return; }
    setErr(""); setBusy(true);
    try { await dSubmit(path, title.trim(), "report", txtToB64(text)); setTitle(""); setText(""); setReportOpen(false); reloadRecs(); }
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
        await dSubmit(path, f.name, "file", b64);
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
    try {
      if (sheet.id) await dReplace(sheet.id, sheet.folder, name, "file", bytesToB64(bytes));
      else await dSubmit(sheet.folder, name, "file", bytesToB64(bytes));
      setSheet(null); reloadRecs();
    }
    catch (e) { notify("" + String(e)); }
    setSheetSaving(false);
  };
  const saveDoc = async (bytes: Uint8Array, name: string) => {
    if (!doc) return;
    setDocSaving(true);
    try {
      if (doc.id) await dReplace(doc.id, doc.folder, name, "file", bytesToB64(bytes));
      else await dSubmit(doc.folder, name, "file", bytesToB64(bytes));
      setDoc(null); reloadRecs();
    }
    catch (e) { notify("" + String(e)); }
    setDocSaving(false);
  };
  const openRec = async (r: DRec) => {
    if (r.kind === "file") { try { localStorage.setItem("sv-last-" + login, r.id); } catch { /* */ } }
    if (r.kind === "file" && isDoc(r.name)) { setOpening("Открываю документ…"); try { const b = await dOpen(r.id); setDoc({ id: r.id, name: r.name, folder: r.folder || "", content: b64ToTxt(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file" && isSheet(r.name)) { setOpening("Открываю таблицу…"); try { const b = await dOpen(r.id); setSheet({ id: r.id, name: r.name, folder: r.folder || "", bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file" && isViewable(r.name)) { setOpening("Открываю файл…"); try { const b = await dOpen(r.id); setViewer({ rec: r, bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (r.kind === "file") { setFileView(r); return; }
    setView(r); setViewText(""); setViewBusy(true); setOpening("Расшифровываю…");
    try { const b = await dOpen(r.id); setViewText(b64ToTxt(b)); } catch (e) { setViewText("Ошибка: " + String(e)); }
    setViewBusy(false); setOpening("");
  };
  const saveEdit = async () => { if (!view) return; setViewBusy(true); try { if (view.id) await dReplace(view.id, view.folder || "", view.name, "report", txtToB64(viewText)); else await dSubmit(view.folder || "", view.name, "report", txtToB64(viewText)); setView(null); reloadRecs(); } catch (e) { notify("" + String(e)); } setViewBusy(false); };
  const del = (r: DRec) => setConfirmData({ title: "Переместить в Корзину?", text: "«" + r.name + "» уйдёт в Корзину. Восстановить можно в течение 30 дней.", danger: false, onYes: async () => { try { await dDelete(r.id); setView(null); setFileView(null); reloadRecs(); } catch (e) { notify("" + String(e)); } } });
  const openFileInApp = async (r: DRec) => { setFileView(null); setOpening("Открываю в программе…"); try { await dOpenFile(r.id, r.name); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const openNative = async (id: string, name: string) => { setOpening("Открываю в программе…"); try { await dOpenFile(id, name); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const downloadRec = async (r: DRec) => { setOpening("Готовлю файл…"); try { const b = await dOpen(r.id); await saveToDisk(r.name, b); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const startReplace = (r: DRec) => { replaceRec.current = r; replaceInput.current?.click(); };
  const onReplaceFile = async (f: File | null) => { const r = replaceRec.current; replaceRec.current = null; if (!r || !f) return; setOpening("Заменяю…"); try { const b64 = await fileToB64(f); await dReplace(r.id, r.folder || "", f.name, "file", b64); reloadRecs(); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const openVersions = async (r: DRec) => { setVersionsFor(r); setVersions([]); setVersLoading(true); try { setVersions(await invoke<DVersion[]>("sv_dir_versions", { login, password: pw, id: r.id })); } catch (e) { notify("" + String(e)); } setVersLoading(false); };
  const asRec = (v: DVersion): DRec => ({ id: v.id, kind: "file", name: v.name, size: v.size, folder: versionsFor?.folder || "", comments: 0, at: v.at, status: v.status });
  const restoreVersion = async (v: DVersion) => { setOpening("Возвращаю версию…"); try { await invoke("sv_dir_restore_version", { login, password: pw, id: v.id }); setVersionsFor(null); reloadRecs(); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const loadTrash = async () => { setTrashLoading(true); try { setTrash(await invoke<DTrash[]>("sv_dir_trash", { login, password: pw })); } catch (e) { notify("" + String(e)); } setTrashLoading(false); };
  const openTrash = () => { setTrashOpen(true); loadTrash(); };
  const restoreFromTrash = async (t: DTrash) => { setOpening("Восстанавливаю…"); try { await invoke("sv_dir_restore", { login, password: pw, id: t.id }); await loadTrash(); reloadRecs(); reloadFolders(); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const purgeOne = (t: DTrash) => setConfirmData({ title: "Удалить навсегда?", text: "«" + t.name + "» будет стёрт безвозвратно — восстановить будет нельзя.", danger: true, onYes: async () => { setOpening("Стираю…"); try { await invoke("sv_dir_purge", { login, password: pw, id: t.id, all: false }); await loadTrash(); } catch (e) { notify("" + String(e)); } setOpening(""); } });
  const emptyTrash = () => setConfirmData({ title: "Очистить корзину?", text: "Все файлы в Корзине будут стёрты безвозвратно.", danger: true, onYes: async () => { setOpening("Очищаю…"); try { await invoke("sv_dir_purge", { login, password: pw, id: "", all: true }); await loadTrash(); } catch (e) { notify("" + String(e)); } setOpening(""); } });

  return (
    <>
      <div className="shead">
        <div style={{ flex: 1, minWidth: 160 }}>
          <h1>{heading}</h1>
          {sub && <div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
        </div>
        <div className="dsearch">{gi(Ic.search, 15, 2)}<input value={dq} onChange={(e) => setDq(e.target.value)} placeholder="Поиск по диску…" autoCapitalize="off" spellCheck={false} /></div>
        <div className="seg">
          <button className={grid ? "on" : ""} onClick={() => chView(true)} title="Карточки">{gi(Ic.tiles, 15, 2)}</button>
          <button className={!grid ? "on" : ""} onClick={() => chView(false)} title="Список">{gi(Ic.list, 15, 2)}</button>
        </div>
        {selMode ? <>
          <button className="chip sm" onClick={() => { const all = files.length > 0 && files.every((r) => sel.has(r.id)); setSel(all ? new Set() : new Set(files.map((r) => r.id))); }}>{gi(Ic.sel, 15, 2)}{files.length > 0 && files.every((r) => sel.has(r.id)) ? "Снять всё" : "Выбрать всё"}</button>
          <button className="chip sm" onClick={exitSel}>{gi(Ic.x, 15, 2)}Отмена</button>
        </> : <>
          {!rv && clip && clip.ids.length > 0 && <button className="chip grad sm" onClick={doPaste}>{gi(Ic.paste, 15, 2)}Вставить{clip.ids.length > 1 ? " " + clip.ids.length : ""}</button>}
          {files.length > 0 && <button className="chip sm" onClick={() => setSelMode(true)} title="Выбрать несколько">{gi(Ic.sel, 15, 2)}Выбрать</button>}
          {!rv && <button className="chip sm" onClick={openTrash} title="Корзина">{gi(Ic.trash, 15, 2)}Корзина</button>}
          {canAdd && <button className="chip sm" onClick={() => setAddOpen(true)}>{gi(Ic.up, 15, 2)}Добавить</button>}
          {canAdd && <button className="chip grad sm" onClick={() => setCreate(true)}>{gi(Ic.plus, 15, 2.4)}Создать</button>}
        </>}
      </div>

      <div className="crumb">
        {path && <button className="backb" onClick={() => setPath(parentOf(path))}>{gi(Ic.back, 15, 2.2)}Назад</button>}
        <a onClick={() => setPath("")}>Все папки</a>
        {crumbs.map((c, i) => { const p = crumbs.slice(0, i + 1).join("/"); const last = i === crumbs.length - 1; return <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><span>/</span>{last ? <b>{c}</b> : <a onClick={() => setPath(p)}>{c}</a>}</span>; })}
      </div>


      <div>
        {loading ? (
          <BrandLoading />
        ) : subfolders.length === 0 && files.length === 0 && !searching && !canAdd ? (
          <div className="empty">
            <div style={{ width: 52, height: 52, borderRadius: 15, margin: "0 auto 12px", display: "grid", placeItems: "center", background: "color-mix(in srgb,var(--a1) 13%,transparent)", color: "var(--a1)" }}>{gi(Ic.fld, 24, 1.8)}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{path ? "В этой папке пусто" : "Пока пусто"}</div>
            <div style={{ marginTop: 4 }}>Здесь появятся папки и файлы.</div>
          </div>
        ) : (
          <>
            {!path && !searching && (quick.length > 0 || (!rv && (favFiles.length > 0 || favFolders.length > 0))) && (
              <div className="two-blocks" style={rv ? { gridTemplateColumns: "1fr" } : undefined}>
                {!rv && <div className="card glass shadow">
                  <div className="block-head"><span style={{ color: "#f59e0b", display: "flex" }}>{starIcon(true, 16)}</span>Избранное{(favFiles.length + favFolders.length) > 0 && <span className="n">{favFiles.length + favFolders.length}</span>}{(favFiles.length + favFolders.length) > 5 && <button className="allbtn" onClick={() => setFavAllOpen(true)}>Все {favFiles.length + favFolders.length}</button>}</div>
                  {favFolders.length === 0 && favFiles.length === 0
                    ? <div className="sub" style={{ padding: "4px 2px 2px", lineHeight: 1.5 }}>Нажмите звёздочку ★ на файле или папке — они появятся здесь для быстрого доступа.</div>
                    : <div className="block-row">
                      {favFolders.slice(0, 5).map((f) => (
                        <div key={"ff" + f} className="qcard" style={{ background: fgrad(base(f)) }} onClick={() => { setPath(f); setDq(""); }}>
                          <span className="qi">{gi(Ic.fld, 16, 2)}</span>
                          <div><div className="qn">{base(f)}</div><div className="qm">{folderCount(f)} эл.</div></div>
                        </div>
                      ))}
                      {favFiles.slice(0, Math.max(0, 5 - favFolders.length)).map((r) => (
                        <div key={"fq" + r.id} className="qcard" style={{ background: recGrad(r) }} onClick={() => goToFile(r)}>
                          <span className="qi">{gi(kindNode(extKind(r.name)), 16, 2)}</span>
                          <div><div className="qn">{r.name}</div><div className="qm">{fmtLabel(r.name)}{r.folder ? " · " + r.folder.split("/").pop() : ""}</div></div>
                        </div>
                      ))}
                    </div>}
                </div>}
                <div className="card glass shadow">
                  <div className="block-head"><span style={{ color: "var(--a1)", display: "flex" }}>{gi(Ic.hist, 16, 2)}</span>Последние</div>
                  {quick.length === 0
                    ? <div className="sub" style={{ padding: "4px 2px" }}>Пока нет файлов.</div>
                    : <div className="block-row">
                      {quick.slice(0, 3).map((r) => (
                        <div key={"rc" + r.id} className="qcard" style={{ background: recGrad(r) }} onClick={() => goToFile(r)}>
                          <span className="qi">{gi(kindNode(extKind(r.name)), 16, 2)}</span>
                          <div><div className="qn">{r.name}</div><div className="qm">{fmtLabel(r.name)}{r.folder ? " · " + r.folder.split("/").pop() : ""}</div></div>
                        </div>
                      ))}
                    </div>}
                </div>
              </div>
            )}
            {grid ? (
              <>
                <div className="sec">{gi(Ic.fld, 15, 2, "var(--warn)")}<h2>{searching ? "Папки по запросу" : "Папки"}</h2>{subfolders.length > 0 && <span className="n">{subfolders.length}</span>}<span className="sp" /></div>
                <div className="folders">
                  {subfolders.map((f) => (
                    <div key={"gf" + f} data-folder={f} data-key={"d:" + f} data-type="folder" style={markStyle("d:" + f)} className={"folder" + (dropFolder === f ? " dragover" : "")} onPointerDown={(e) => startDrag(e, { isFile: false, key: "d:" + f, fileId: "", label: base(f), grad: fgrad(base(f)), fmt: "папка", icon: gi(Ic.fld, 24, 1.7) })} onClick={() => { if (justDragged.current) return; setPath(f); setDq(""); }}>
                      <div className="cover" style={{ background: fgrad(base(f)) }}><span className="tab" />{gi(Ic.fld, 22, 1.7)}</div>
                      <div className="fb"><div style={{ display: "flex", alignItems: "center", gap: 4 }}><div className="fn" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{base(f)}</div>{favStar("d:" + f, 14)}{canAdd && <button className="favbtn" aria-label="Меню папки" onClick={(e) => folderMenu(e, f)} style={{ background: "transparent", border: "none", padding: 2, display: "grid", placeItems: "center", cursor: "pointer", color: "var(--muted-2)" }}>{gi(Ic.more, 16, 2)}</button>}</div><div className="fm"><span>{folderCount(f)} эл.</span><span>·</span><span>{folderWhen(f)}</span></div></div>
                    </div>
                  ))}
                  {canAdd && !searching && <button className="addcard" onClick={() => { setNewFolder(true); setFname(""); }}><span className="pc">{gi(Ic.plus, 20, 2)}</span><span style={{ fontWeight: 700, fontSize: 13 }}>Новая папка</span></button>}
                </div>
                {(files.length > 0 || searching) && (
                  <>
                    <div className="sec">{gi(Ic.doc, 15, 2, "var(--info)")}<h2>{searching ? "Файлы по запросу" : "Файлы"}</h2><span className="n">{files.length}</span><span className="sp" /></div>
                    <div className="fgrid">
                      {files.map((r) => (
                        <div key={"g" + r.id} className={"fcard" + (highlight === r.id ? " hl" : "") + (selMode && sel.has(r.id) ? " sel" : "")} ref={(el) => { if (el && highlight === r.id) el.scrollIntoView({ behavior: "smooth", block: "center" }); }} data-key={r.id} data-type="file" style={markStyle(r.id)} onPointerDown={(e) => startDrag(e, { isFile: true, key: r.id, fileId: r.id, label: r.name, grad: recGrad(r), fmt: fmtLabel(r.name), icon: gi(kindNode(extKind(r.name)), 24, 1.7) })} onClick={() => { if (justDragged.current) return; selMode ? toggleSel(r.id) : openRec(r); }}>
                          <div className="ftop" style={{ background: recGrad(r) }}>
                            {gi(kindNode(extKind(r.name)), 30, 1.6)}
                            {selMode && <span className="selcb">{sel.has(r.id) ? gi(Ic.chk, 14, 3) : null}</span>}
                            {!selMode && r.comments > 0 && (can("comments") ? <button className="cbadge" data-tip="Открыть переписку" onClick={(e) => { e.stopPropagation(); setCmFor(r); }} style={{ cursor: "pointer", border: "none" }}>{gi(Ic.chat, 12, 2)}{r.comments}</button> : <span className="cbadge">{gi(Ic.chat, 12, 2)}{r.comments}</span>)}
                            {!selMode && reviewOn && r.kind !== "report" && <span className="sbadge">{notSent(r) && canSendReview(r) ? sendCover(r) : stCover(r)}</span>}
                          </div>
                          <div className="fbtm">
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><div className="nm" style={{ flex: 1, minWidth: 0 }}>{r.name}</div>{!selMode && favStar(r.id)}</div>
                            <div className="sub">{searching && r.folder ? r.folder + " · " : ""}{fmtLabel(r.name)} · {fmtSize(r.size)}</div>
                            {!selMode && <div className="fx">
                              {review && r.kind === "file" && <button className="tipbtn rvacc" data-tip={r.status === "ok" ? "Снять «принято»" : "Принять"} onClick={(e) => { e.stopPropagation(); acceptFile(r); }}>{gi(<path d="M20 6 9 17l-5-5" />, 15, 2.6)}</button>}
                              {review && r.kind === "file" && <button className="tipbtn rvrem" data-tip={r.status === "fix" ? "Снять замечание" : "Вернуть с замечанием"} onClick={(e) => { e.stopPropagation(); r.status === "fix" ? onStatus?.(r.id, "sent") : remarkFile(r); }}>{gi(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 15, 2)}</button>}
                              {!review && can("export") && <button className="tipbtn" data-tip="Скачать" onClick={(e) => { e.stopPropagation(); downloadRec(r); }}>{gi(Ic.dl, 15, 2)}</button>}
                              {can("comments") && <button className="tipbtn" data-tip="Комментарии" onClick={(e) => { e.stopPropagation(); setCmFor(r); }}>{gi(Ic.chat, 15, 2)}</button>}
                              <button className="tipbtn" data-tip="Ещё" onClick={(e) => fileMenu(e, r)}>{gi(Ic.more, 15, 2)}</button>
                              {!review && can("delete") && <button className="del tipbtn" data-tip="Удалить" onClick={(e) => { e.stopPropagation(); del(r); }}>{gi(Ic.trash, 15, 2)}</button>}
                            </div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {searching && subfolders.length === 0 && files.length === 0 && <div className="empty">Ничего не найдено по запросу «{dq}»</div>}
              </>
            ) : (
              <>
                <div className="sec">{gi(Ic.fld, 15, 2, "var(--warn)")}<h2>{searching ? "Результаты поиска" : "Содержимое"}</h2><span className="n">{subfolders.length + files.length}</span><span className="sp" /></div>
                <div className="card glass shadow lwrap" style={{ padding: 0, width: "100%" }}>
                  {canAdd && !searching && (
                    <button className="lrow" style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", borderTop: "none" }} onClick={() => { setNewFolder(true); setFname(""); }}>
                      <span className="li" style={{ background: "color-mix(in srgb,var(--a1) 16%,transparent)", color: "var(--a1)" }}>{gi(Ic.plus, 18, 2.2)}</span>
                      <div style={{ minWidth: 0 }}><div className="lnm" style={{ color: "var(--a1)" }}>Новая папка</div><div className="lsub">Создать папку здесь</div></div>
                    </button>
                  )}
                  {subfolders.map((f) => (
                    <div key={"lf" + f} data-folder={f} data-key={"d:" + f} data-type="folder" style={markStyle("d:" + f)} className={"lrow" + (dropFolder === f ? " dragover" : "")} onPointerDown={(e) => startDrag(e, { isFile: false, key: "d:" + f, fileId: "", label: base(f), grad: fgrad(base(f)), fmt: "папка", icon: gi(Ic.fld, 24, 1.7) })} onClick={() => { if (justDragged.current) return; setPath(f); setDq(""); }}>
                      <span className="li" style={{ background: fgrad(base(f)) }}>{gi(Ic.fld, 18, 2)}</span>
                      <div style={{ minWidth: 0 }}><div className="lnm">{base(f)}</div><div className="lsub">{folderCount(f)} эл. · {folderWhen(f)}</div></div>
                      <div className="lmeta">{favStar("d:" + f)}{canAdd && <button className="favbtn" aria-label="Меню папки" onClick={(e) => folderMenu(e, f)} style={{ background: "transparent", border: "none", padding: 4, display: "grid", placeItems: "center", cursor: "pointer", color: "var(--muted-2)" }}>{gi(Ic.more, 16, 2)}</button>}<span className="chev">{gi(Ic.chev, 16, 2)}</span></div>
                    </div>
                  ))}
                  {files.map((r) => (
                    <div key={"lr" + r.id} className={"lrow" + (highlight === r.id ? " hl" : "") + (selMode && sel.has(r.id) ? " sel" : "")} ref={(el) => { if (el && highlight === r.id) el.scrollIntoView({ behavior: "smooth", block: "center" }); }} data-key={r.id} data-type="file" style={markStyle(r.id)} onPointerDown={(e) => startDrag(e, { isFile: true, key: r.id, fileId: r.id, label: r.name, grad: recGrad(r), fmt: fmtLabel(r.name), icon: gi(kindNode(extKind(r.name)), 24, 1.7) })} onClick={() => { if (justDragged.current) return; selMode ? toggleSel(r.id) : openRec(r); }}>
                      {selMode && <span className="selcb">{sel.has(r.id) ? gi(Ic.chk, 13, 3) : null}</span>}
                      <span className="li" style={{ background: recGrad(r) }}>{gi(kindNode(extKind(r.name)), 18, 2)}</span>
                      <div style={{ minWidth: 0 }}><div className="lnm">{r.name}</div><div className="lsub">{searching && r.folder ? r.folder + " · " : ""}{fmtLabel(r.name)} · {fmtDate(r.at)} · {fmtSize(r.size)}</div></div>
                      {!selMode && <div className="lmeta">
                        {favStar(r.id)}
                        {reviewOn && r.kind !== "report" && (notSent(r) && canSendReview(r) ? <button className="chip grad sm" style={{ gap: 5 }} onClick={(e) => { e.stopPropagation(); submitReview(r); }}>{gi(Ic.chk, 13, 2.6)}Сдать</button> : stPill(r.status))}
                        {r.comments > 0 && can("comments") && <button className="cbtn" onClick={(e) => { e.stopPropagation(); setCmFor(r); }}>{gi(Ic.chat, 13, 2)}{r.comments}</button>}
                        <span className="lx">
                          {review && r.kind === "file" && <button className="tipbtn rvacc" data-tip={r.status === "ok" ? "Снять «принято»" : "Принять"} onClick={(e) => { e.stopPropagation(); acceptFile(r); }}>{gi(<path d="M20 6 9 17l-5-5" />, 15, 2.6)}</button>}
                          {review && r.kind === "file" && <button className="tipbtn rvrem" data-tip={r.status === "fix" ? "Снять замечание" : "Вернуть с замечанием"} onClick={(e) => { e.stopPropagation(); r.status === "fix" ? onStatus?.(r.id, "sent") : remarkFile(r); }}>{gi(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 15, 2)}</button>}
                          {!review && can("export") && <button className="tipbtn" data-tip="Скачать" onClick={(e) => { e.stopPropagation(); downloadRec(r); }}>{gi(Ic.dl, 15, 2)}</button>}
                          {can("comments") && r.comments === 0 && <button className="tipbtn" data-tip="Комментарии" onClick={(e) => { e.stopPropagation(); setCmFor(r); }}>{gi(Ic.chat, 15, 2)}</button>}
                          <button className="tipbtn" data-tip="Ещё" onClick={(e) => fileMenu(e, r)}>{gi(Ic.more, 15, 2)}</button>
                          {!review && can("delete") && <button className="del tipbtn" data-tip="Удалить" onClick={(e) => { e.stopPropagation(); del(r); }}>{gi(Ic.trash, 15, 2)}</button>}
                        </span>
                        <span className="chev">{gi(Ic.chev, 16, 2)}</span>
                      </div>}
                    </div>
                  ))}
                  {searching && subfolders.length + files.length === 0 && <div className="empty">Ничего не найдено по запросу «{dq}»</div>}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {selMode && (
        <div className="selbar glass shadow">
          <span className="cnt">{sel.size > 0 ? "Выбрано " + sel.size : "Выберите файлы"}</span>
          {can("export") && <button className="sb prim" onClick={bulkDownload} style={{ opacity: sel.size === 0 ? 0.5 : 1, pointerEvents: sel.size === 0 ? "none" : "auto" }}>{gi(Ic.dl, 15, 2)}Скачать</button>}
          {can("edit") && <button className="sb" onClick={() => setMovePick({ files: [...sel] })} style={{ opacity: sel.size === 0 ? 0.5 : 1, pointerEvents: sel.size === 0 ? "none" : "auto" }}>{gi(Ic.move, 15, 2)}Переместить</button>}
          {can("delete") && <button className="sb dng" onClick={bulkTrash} style={{ opacity: sel.size === 0 ? 0.5 : 1, pointerEvents: sel.size === 0 ? "none" : "auto" }}>{gi(Ic.trash, 15, 2)}В корзину</button>}
          <button className="sb" onClick={exitSel}>Готово</button>
        </div>
      )}

      {dragGhost && (
        <div style={{ position: "fixed", left: dragGhost.x + 12, top: dragGhost.y + 10, zIndex: 2000, pointerEvents: "none", width: 152, borderRadius: 14, overflow: "hidden", background: "var(--surface)", border: "1px solid var(--glassln)", boxShadow: "0 18px 44px rgba(20,24,60,.45)", transform: "rotate(-4deg)", opacity: 0.96 }}>
          <div style={{ height: 48, display: "grid", placeItems: "center", color: "#fff", background: dragGhost.grad }}>{dragGhost.icon}</div>
          <div style={{ padding: "7px 10px", borderTop: "1px solid var(--glassln)" }}><div style={{ fontWeight: 700, fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{dragGhost.label}</div><div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>{dragGhost.fmt}</div></div>
        </div>
      )}

      <input ref={replaceInput} type="file" style={{ display: "none" }} onChange={(e) => onReplaceFile(e.target.files?.[0] || null)} />
      <input ref={addInput} type="file" multiple style={{ display: "none" }} onChange={(e) => { const fs = Array.from(e.target.files || []); setAddFiles((prev) => [...prev, ...fs]); if (e.target) e.target.value = ""; }} />

      <Drawer open={newFolder} onClose={() => setNewFolder(false)} title="Новая папка">
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 14 }}>Будет создана в папке <b style={{ color: "var(--text-2)" }}>{path || "Все папки"}</b>.</div>
        <input autoFocus value={fname} onChange={(e) => setFname(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFolder()} placeholder="название папки (напр. 2026)" autoCapitalize="off" spellCheck={false} style={{ width: "100%", height: 42, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", padding: "0 14px", fontSize: 14, outline: "none", fontFamily: "inherit" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button style={{ ...btn, flexGrow: 1 }} onClick={createFolder}>Создать</button>
          <button style={ghost} onClick={() => setNewFolder(false)}>Отмена</button>
        </div>
      </Drawer>

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
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)" }}>{fileView.name}</div><div style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(fileView.at)} · {fmtSize(fileView.size)}</div></div>
            {reviewOn && fileView.kind === "file" && stPill(fileView.status)}
          </div>
          {canSendReview(fileView) && <button style={{ ...btn, width: "100%", marginBottom: 10, background: "linear-gradient(135deg,var(--good),#2dd4bf)" }} onClick={() => { submitReview(fileView); setFileView(null); }}>Сдать на проверку</button>}
          {can("export") && <button style={{ ...btn, width: "100%", marginBottom: 10 }} onClick={() => downloadRec(fileView)}>Скачать</button>}
          {can("export") && <button style={{ ...ghost, width: "100%", marginBottom: 10 }} onClick={() => openFileInApp(fileView)}>Открыть в программе</button>}
          {can("delete") && <button style={{ ...ghost, width: "100%", color: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => del(fileView)}>Удалить</button>}
        </>}
      </Drawer>

      {sheet && <SheetEditor initial={sheet.bytes} name={sheet.name} saving={sheetSaving} onSave={saveSheet} onDownload={can("export") ? (b, n) => saveToDisk(n, bytesToB64(b)) : undefined} onOpenNative={sheet.id && can("export") ? () => openNative(sheet.id as string, sheet.name) : undefined} onClose={() => !sheetSaving && setSheet(null)} />}
      {doc && <DocEditor initial={doc.content} name={doc.name} saving={docSaving} onSave={saveDoc} onClose={() => !docSaving && setDoc(null)} />}
      {viewer && <FileViewer bytes={viewer.bytes} name={viewer.rec.name} saving={!!opening} onDownload={can("export") ? () => saveToDisk(viewer.rec.name, bytesToB64(viewer.bytes)) : undefined} onOpenNative={can("export") ? () => openNative(viewer.rec.id, viewer.rec.name) : undefined} onClose={() => setViewer(null)} />}
      <Drawer open={!!versionsFor} onClose={() => setVersionsFor(null)} title="История версий">
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
          <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: "grid", placeItems: "center", color: "#fff", background: versionsFor ? recGrad(versionsFor) : "linear-gradient(135deg,var(--a1),var(--a2))" }}>{gi(kindNode(extKind(versionsFor?.name || "")), 20, 1.7)}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{versionsFor?.name}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{versions.length > 0 ? versions.length + (versions.length === 1 ? " версия" : versions.length < 5 ? " версии" : " версий") + " · " : ""}хранятся последние 5</div>
          </div>
        </div>
        {versLoading ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13 }}><span className="spinner" /> Загрузка…</div>
          : versions.length === 0 ? <div className="empty" style={{ padding: "24px 10px" }}>Пока одна версия. Замените файл — прежняя сохранится здесь.</div>
            : <div className="vtl">
              {versions.map((v, i) => { const num = versions.length - i; return (
                <div className="vrow" key={v.id}>
                  <span className="vdot" style={{ background: v.current ? "linear-gradient(135deg,var(--a1),var(--a2))" : "var(--muted-2)" }}>{num}</span>
                  <div className={"vcard" + (v.current ? " cur" : "")}>
                    <div className="vhead"><span className="vn">Версия {num}</span>{v.current && <span className="vbadge">текущая</span>}</div>
                    <div className="vmeta">{fmtDate(v.at)} · {fmtSize(v.size)}{v.submitter && v.submitter !== login ? " · " + v.submitter : ""}</div>
                    <div className="vacts">
                      <button className="prim" onClick={() => { setVersionsFor(null); openRec(asRec(v)); }}>{gi(Ic.eye, 14, 2)}Просмотреть</button>
                      {can("export") && <button onClick={() => downloadRec(asRec(v))}>{gi(Ic.dl, 14, 2)}Скачать</button>}
                      {!v.current && can("edit") && <button onClick={() => restoreVersion(v)}>{gi(Ic.rep, 14, 2)}Вернуть</button>}
                    </div>
                  </div>
                </div>
              ); })}
            </div>}
      </Drawer>

      <Drawer open={favAllOpen} onClose={() => setFavAllOpen(false)} title="Избранное">
        {(favFolders.length + favFiles.length) === 0
          ? <div className="empty" style={{ padding: "28px 10px" }}>Избранное пусто</div>
          : <div className="quick-row">
            {favFolders.map((f) => (
              <div key={"af" + f} className="qcard" style={{ background: fgrad(base(f)), position: "relative" }} onClick={() => { setFavAllOpen(false); setPath(f); setDq(""); }}>
                <button onClick={(e) => { e.stopPropagation(); toggleFavorite("d:" + f); }} title="Убрать из избранного" style={{ position: "absolute", top: 7, right: 7, width: 26, height: 26, borderRadius: 8, border: "none", background: "rgba(0,0,0,.28)", color: "#fff", display: "grid", placeItems: "center", cursor: "pointer", zIndex: 2 }}>{starIcon(true, 13)}</button>
                <span className="qi">{gi(Ic.fld, 16, 2)}</span>
                <div><div className="qn">{base(f)}</div><div className="qm">{folderCount(f)} эл.</div></div>
              </div>
            ))}
            {favFiles.map((r) => (
              <div key={"af" + r.id} className="qcard" style={{ background: recGrad(r), position: "relative" }} onClick={() => goToFile(r)}>
                <button onClick={(e) => { e.stopPropagation(); toggleFavorite(r.id); }} title="Убрать из избранного" style={{ position: "absolute", top: 7, right: 7, width: 26, height: 26, borderRadius: 8, border: "none", background: "rgba(0,0,0,.28)", color: "#fff", display: "grid", placeItems: "center", cursor: "pointer", zIndex: 2 }}>{starIcon(true, 13)}</button>
                <span className="qi">{gi(kindNode(extKind(r.name)), 16, 2)}</span>
                <div><div className="qn">{r.name}</div><div className="qm">{fmtLabel(r.name)}{r.folder ? " · " + r.folder.split("/").pop() : ""}</div></div>
              </div>
            ))}
          </div>}
      </Drawer>

      <Drawer open={trashOpen} onClose={() => setTrashOpen(false)} title="Корзина">
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 15 }}>
          <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: "grid", placeItems: "center", color: "var(--danger)", background: "color-mix(in srgb,var(--danger) 13%,transparent)" }}>{gi(Ic.trash, 20, 1.9)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)" }}>{trash.length > 0 ? trash.length + " в Корзине" : "Корзина"}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Хранятся 30 дней, затем стираются</div>
          </div>
          {trash.length > 0 && <button onClick={emptyTrash} style={{ ...ghost, color: "var(--danger)", borderColor: "color-mix(in srgb,var(--danger) 42%,transparent)", padding: "7px 12px", flexShrink: 0 }}>Очистить всё</button>}
        </div>
        {trashLoading ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13 }}><span className="spinner" /> Загрузка…</div>
          : trash.length === 0 ? (
            <div className="empty" style={{ padding: "30px 10px" }}>
              <div style={{ width: 52, height: 52, borderRadius: 15, margin: "0 auto 12px", display: "grid", placeItems: "center", background: "color-mix(in srgb,var(--text) 7%,transparent)", color: "var(--muted-2)" }}>{gi(Ic.trash, 24, 1.7)}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Корзина пуста</div>
              <div style={{ marginTop: 4 }}>Удалённые файлы будут появляться здесь.</div>
            </div>
          ) : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {trash.map((t) => (
              <div className="vcard" key={t.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: "grid", placeItems: "center", color: "#fff", background: GRAD[extKind(t.name)] || GRAD.doc }}>{gi(kindNode(extKind(t.name)), 19, 1.7)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.folder ? t.folder + " · " : ""}удалён {fmtWhen(t.deleted_at)} · {fmtSize(t.size)}</div>
                  </div>
                </div>
                <div className="vacts">
                  <button className="prim" onClick={() => restoreFromTrash(t)}>{gi(Ic.rep, 14, 2)}Восстановить</button>
                  <button className="dng" onClick={() => purgeOne(t)}>{gi(Ic.trash, 14, 2)}Удалить навсегда</button>
                </div>
              </div>
            ))}
          </div>}
      </Drawer>

      {menu && (<>
        <div style={{ position: "fixed", inset: 0, zIndex: 1300 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
        <div className="ws-ctx glass shadow" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((m, i) => <button key={i} className={"ci" + (m.danger ? " dng" : "")} onClick={() => { setMenu(null); m.onClick(); }}>{m.icon}{m.label}</button>)}
        </div>
      </>)}

      <Drawer open={!!renameT} onClose={() => setRenameT(null)} title={renameT?.kind === "folder" ? "Переименовать папку" : "Переименовать файл"}>
        <input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doRename()} placeholder="новое имя" spellCheck={false} style={{ width: "100%", height: 42, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", padding: "0 14px", fontSize: 14, outline: "none", fontFamily: "inherit" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button style={{ ...btn, flexGrow: 1 }} onClick={doRename}>Переименовать</button>
          <button style={ghost} onClick={() => setRenameT(null)}>Отмена</button>
        </div>
      </Drawer>

      <Drawer open={!!movePick} onClose={() => setMovePick(null)} title="Переместить в…">
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12 }}>{movePick?.folder ? "Выберите, куда переместить папку." : `Выберите папку для ${movePick?.files && movePick.files.length > 1 ? movePick.files.length + " файлов" : "файла"}.`}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(() => {
            const all = ["", ...[...allNodes].sort()];
            const mf = movePick?.folder;
            const dests = mf ? all.filter((d) => d !== mf && !(d + "/").startsWith(mf + "/") && d !== parentOf(mf)) : all;
            return dests.map((d) => (
              <button key={d || "__root"} className="f" onClick={() => doMove(d)} style={{ width: "100%", textAlign: "left", border: "1px solid var(--border)", background: "var(--surface-2)" }}>
                <span className="fi" style={{ background: d ? fgrad(base(d)) : "color-mix(in srgb,var(--text) 20%,transparent)" }}>{gi(Ic.fld, 17, 2)}</span>
                <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{d ? base(d) : "Все папки (корень)"}</div>{d && <div className="sub">{d}</div>}</div>
              </button>
            ));
          })()}
        </div>
      </Drawer>

      {cmFor && <CommentsDrawer login={login} pw={pw} owner={rv ? owner : login} toName={rv ? (sub || owner) : undefined} rec={cmFor} hint={remarkT ? "Опишите, что нужно исправить. Как только отправите комментарий — файл вернётся автору на доработку с пометкой «замечание». Нажмёте «Отмена» — ничего не изменится." : undefined} onClose={() => { setCmFor(null); setRemarkT(null); }} onPosted={() => { if (remarkT) { onStatus?.(remarkT.id, "fix"); setRemarkT(null); } reloadRecs(); }} notify={notify} />}
      <ConfirmModal data={confirmData} onClose={() => setConfirmData(null)} />
      <Toast msg={toast} />
      {opening && <LoadingOverlay text={opening} />}
    </>
  );
}

function DatePick({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => (value ? new Date(value + "T00:00:00") : new Date()));
  const mn = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const y = view.getFullYear(), m = view.getMonth();
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const cells: (number | null)[] = [...Array(startDow).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const fmt = (d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const label = value ? (() => { const d = new Date(value + "T00:00:00"); return `${d.getDate()} ${mn[d.getMonth()].slice(0, 3).toLowerCase()} ${d.getFullYear()}`; })() : placeholder;
  return (
    <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
      <button className={"dpick" + (value ? " has" : "")} onClick={() => setOpen((o) => !o)}>{nic(<><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></>, 15)}{label}{value && <span className="dclr" onClick={(e) => { e.stopPropagation(); onChange(""); }}>{nic(<path d="M18 6 6 18M6 6l12 12" />, 13)}</span>}</button>
      {open && <><div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} /><div className="dpop glass shadow">
        <div className="dpop-h"><button onClick={() => setView(new Date(y, m - 1, 1))}>{nic(<path d="m15 18-6-6 6-6" />, 16)}</button><span>{mn[m]} {y}</span><button onClick={() => setView(new Date(y, m + 1, 1))}>{nic(<path d="m9 18 6-6-6-6" />, 16)}</button></div>
        <div className="dgrid dgrid-h">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((w) => <span key={w}>{w}</span>)}</div>
        <div className="dgrid">{cells.map((c, i) => c === null ? <span key={i} /> : <button key={i} className={"dcell" + (fmt(c) === value ? " sel" : "") + (fmt(c) === todayStr ? " today" : "")} onClick={() => { onChange(fmt(c)); setOpen(false); }}>{c}</button>)}</div>
      </div></>}
    </div>
  );
}

function ReviewerActivity({ login, pw }: { login: string; pw: string }) {
  const [items, setItems] = useState<RvAct[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [who, setWho] = useState("");
  const [limit, setLimit] = useState(40);
  const [df, setDf] = useState("");
  const [dt, setDt] = useState("");
  useEffect(() => { (async () => { try { setItems(await invoke<RvAct[]>("sv_rv_activity", { login, password: pw })); } catch { /* */ } setLoading(false); })(); }, []);
  const actors = useMemo(() => { const m = new Map<string, string>(); items.forEach((i) => { if (!m.has(i.actor)) m.set(i.actor, i.actor_name || i.actor); }); return [...m.entries()]; }, [items]);
  useEffect(() => { setLimit(40); }, [filter, who, df, dt]);
  const filtered = useMemo(() => { const from = df ? new Date(df + "T00:00:00").getTime() : 0; const to = dt ? new Date(dt + "T23:59:59").getTime() : Infinity; return items.filter((i) => { if (filter !== "all" && logMeta(i.action).cat !== filter) return false; if (who !== "" && i.actor !== who) return false; const t = Date.parse(i.at); if (!isNaN(t) && (t < from || t > to)) return false; return true; }); }, [items, filter, who, df, dt]);
  const shown = filtered.slice(0, limit);
  const groups = useMemo(() => { const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }; const today = dayStart(Date.now()); const g: { day: string; items: RvAct[] }[] = []; let cur = ""; shown.forEach((it) => { const t = Date.parse(it.at); const ds = isNaN(t) ? 0 : dayStart(t); const lbl = ds === today ? "Сегодня" : ds === today - 864e5 ? "Вчера" : new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }); if (lbl !== cur) { g.push({ day: lbl, items: [] }); cur = lbl; } g[g.length - 1].items.push(it); }); return g; }, [shown]);
  const relTime = (iso: string) => { const t = Date.parse(iso); if (isNaN(t)) return ""; const s = Math.floor((Date.now() - t) / 1000); if (s < 60) return "только что"; if (s < 3600) return Math.floor(s / 60) + " мин назад"; if (s < 86400) return Math.floor(s / 3600) + " ч назад"; return new Date(t).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
  const ini = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || s.slice(0, 1).toUpperCase();
  return <>
    <div className="shead"><div style={{ flex: 1, minWidth: 160 }}><h1>Журнал по профилям</h1><div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>Действия всех профилей организации</div></div></div>
    <div className="filters">
      {([["all", "Все"], ["submit", "Сдано"], ["edit", "Изменения"], ["comment", "Комментарии"]] as const).map(([k, l]) => <button key={k} className={"fchip" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}
      {actors.length > 1 && <span style={{ width: 1, background: "var(--glassln)", margin: "2px 4px" }} />}
      {actors.length > 1 && <button className={"fchip" + (who === "" ? " on" : "")} onClick={() => setWho("")}>Все профили</button>}
      {actors.length > 1 && actors.map(([a, n]) => <button key={a} className={"fchip" + (who === a ? " on" : "")} onClick={() => setWho(a)}>{n}</button>)}
    </div>
    <div className="filters" style={{ alignItems: "center" }}>
      <span style={{ fontSize: 12.5, color: "var(--muted)", fontWeight: 600 }}>Период:</span>
      <DatePick value={df} onChange={setDf} placeholder="с даты" />
      <span style={{ color: "var(--muted-2)" }}>—</span>
      <DatePick value={dt} onChange={setDt} placeholder="по дату" />
      {(df || dt) && <button className="fchip" onClick={() => { setDf(""); setDt(""); }}>Сбросить</button>}
    </div>
    <div className="card glass shadow" style={{ padding: "10px 14px" }}>
      {loading ? <BrandLoading />
        : filtered.length === 0 ? <div className="empty">Пока нет действий.</div>
          : <div className="tl">{groups.map((g, gi) => <Fragment key={gi}><div className="tlday">{g.day}</div>{g.items.map((it, i) => { const m = logMeta(it.action); return (
            <div className="tlitem" key={i}><span className="tldot" style={{ background: m.color }} /><span className="tlic" style={{ background: `color-mix(in srgb, ${m.color} 16%, transparent)`, color: m.color }}>{nic(m.icon, 17)}</span>
              <div style={{ flex: 1, minWidth: 0 }}><div className="nm"><span style={{ color: m.color }}>{it.actor_name || it.actor}</span> · {m.label.toLowerCase()}</div><div className="sub">{relTime(it.at)}</div>{it.target && <span className="ctxchip">{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, 12)}{it.target}</span>}</div>
              <span className="ava" style={{ width: 26, height: 26, fontSize: 10, background: `linear-gradient(135deg,${avatarGrad(it.actor)})` }}>{ini(it.actor_name || it.actor)}</span>
            </div>
          ); })}</Fragment>)}</div>}
      {filtered.length > limit && <button className="chip" style={{ margin: "12px auto 4px", display: "flex" }} onClick={() => setLimit((l) => l + 40)}>Показать ещё</button>}
    </div>
  </>;
}

export function ReviewerHome({ info, pw, theme, onToggleTheme, onExit }: { info: MasterInfo; pw: string; theme: string; onToggleTheme: () => void; onExit: () => void }) {
  const login = info.login;
  const can = (k: string) => hasPerm(info, k);
  const [section, setSection] = useState("dash");
  const [menu, setMenu] = useState(false);
  const [accent, setAccent] = useState(() => { try { return prefsCached(login).accent || ""; } catch { return ""; } });
  const chAccent = (a: string) => { setAccent(a); prefsSet(login, pw, { accent: a }); };
  const accents: [string, string][] = [["", "#6366f1,#22d3ee"], ["royal", "#4f46e5,#a855f7"], ["violet", "#8b5cf6,#ec4899"], ["ocean", "#2563eb,#22d3ee"], ["emerald", "#10b981,#2dd4bf"], ["sunset", "#fb7185,#fbbf24"], ["graphite", "#475569,#0ea5e9"]];

  const [profiles, setProfiles] = useState<RvProfile[]>([]);
  const [queue, setQueue] = useState<RvQueue[]>([]);
  const [recent, setRecent] = useState<RvRecent[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<RvProfile | null>(null);
  const [reviewOn, setReviewOn] = useState(true);
  const [deadlineDay, setDeadlineDay] = useState(0);

  const [ownRecs, setOwnRecs] = useState<DRec[]>([]);
  const [ownLoading, setOwnLoading] = useState(false);
  const [ownFolders, setOwnFolders] = useState<string[]>([]);
  const [ownPath, setOwnPath] = useState("");
  const loadOwn = async () => { setOwnLoading(true); try { setOwnRecs(await invoke<DRec[]>("sv_dir_list", { login, password: pw })); } catch { /* */ } setOwnLoading(false); };
  const loadOwnFolders = async () => { try { setOwnFolders(await invoke<string[]>("sv_dir_folders", { login, password: pw })); } catch { /* */ } };

  const [net, setNet] = useState<{ server: boolean; ms: number; iface: string } | null>(null);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const netOk = online && (net ? net.server : true);
  const recheck = () => { setOnline(typeof navigator !== "undefined" ? navigator.onLine : true); invoke<{ server: boolean; ms: number; iface: string }>("sv_net_status").then(setNet).catch(() => setNet({ server: false, ms: 0, iface: "" })); };

  const load = async () => {
    setLoading(true);
    try {
      const [p, q, r] = await Promise.all([
        invoke<RvProfile[]>("sv_rv_profiles", { login, password: pw }),
        invoke<RvQueue[]>("sv_rv_queue", { login, password: pw }),
        invoke<RvRecent[]>("sv_rv_recent", { login, password: pw }),
      ]);
      setProfiles(p); setQueue(q); setRecent(r);
    } catch { /* */ }
    setLoading(false);
  };
  const loadCfg = () => invoke<{ review_on: boolean; deadline_day: number }>("sv_my_orgcfg", { login, password: pw }).then((c) => { setReviewOn(c.review_on); setDeadlineDay(c.deadline_day); }).catch(() => { /* */ });
  useEffect(() => {
    load(); if (can("submit")) { loadOwn(); loadOwnFolders(); }
    loadCfg();
    recheck(); const iv = setInterval(recheck, 15000);
    const lv = setInterval(load, 20000); // авто-обновление очереди/профилей
    const on = () => setOnline(navigator.onLine);
    const f = () => { loadCfg(); load(); };
    window.addEventListener("online", on); window.addEventListener("offline", on); window.addEventListener("focus", f);
    return () => { clearInterval(iv); clearInterval(lv); window.removeEventListener("online", on); window.removeEventListener("offline", on); window.removeEventListener("focus", f); };
  }, []);

  // review panel state (очередь)
  const [opening, setOpening] = useState("");
  const [toast, setToast] = useState("");
  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3500); };
  const [sheet, setSheet] = useState<{ id: string; name: string; folder: string; owner: string; bytes: Uint8Array | null } | null>(null);
  const [sheetSaving, setSheetSaving] = useState(false);
  const [doc, setDoc] = useState<{ id: string; name: string; folder: string; owner: string; content: string | null } | null>(null);
  const [docSaving, setDocSaving] = useState(false);
  const [viewer, setViewer] = useState<{ q: RvQueue; bytes: Uint8Array } | null>(null);
  const [view, setView] = useState<RvQueue | null>(null);
  const [viewText, setViewText] = useState("");
  const [viewBusy, setViewBusy] = useState(false);
  const [cmFor, setCmFor] = useState<{ id: string; name: string; owner: string; ownerName: string } | null>(null);

  const totalFiles = useMemo(() => profiles.reduce((a, p) => a + p.count, 0), [profiles]);
  const pendingN = queue.length;
  const fixN = useMemo(() => profiles.reduce((a, p) => a + p.fix, 0), [profiles]);
  const okN = Math.max(0, totalFiles - pendingN - fixN);
  const [ovRange, setOvRange] = useState<"week" | "month">("week");
  const ovBars = useMemo(() => {
    const cnt = (a: number, b: number) => recent.filter((r) => { const t = Date.parse(r.at); return !isNaN(t) && t >= a && t < b; }).length;
    const t0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    if (ovRange === "week") { const wd = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]; const out: { label: string; tip: string; n: number; today: boolean }[] = []; for (let i = 6; i >= 0; i--) { const d0 = t0 - i * 864e5; const n = cnt(d0, d0 + 864e5); const dd = new Date(d0); out.push({ label: wd[dd.getDay()], tip: `${dd.getDate()}.${dd.getMonth() + 1}: ${n} сдано`, n, today: i === 0 }); } return out; }
    const out: { label: string; tip: string; n: number; today: boolean }[] = [];
    for (let i = 4; i >= 0; i--) { const a = t0 - (i * 7 + 6) * 864e5; const b = t0 - (i * 7) * 864e5 + 864e5; const n = cnt(a, b); const da = new Date(a), db = new Date(b - 864e5); out.push({ label: i === 0 ? "тек." : i + " нед", tip: `${da.getDate()}.${da.getMonth() + 1}–${db.getDate()}.${db.getMonth() + 1}: ${n} сдано`, n, today: i === 0 }); }
    return out;
  }, [recent, ovRange]);
  const ovWeekMax = Math.max(1, ...ovBars.map((d) => d.n));
  const attention = useMemo(() => profiles.filter((p) => p.fix > 0 || p.review > 0).sort((a, b) => (b.fix * 10 + b.review) - (a.fix * 10 + a.review)).slice(0, 5), [profiles]);
  const rank = useMemo(() => profiles.slice().sort((a, b) => b.count - a.count).slice(0, 5), [profiles]);
  const rankMax = Math.max(1, ...rank.map((p) => p.count));
  const fixRank = useMemo(() => profiles.filter((p) => p.fix > 0).map((p) => ({ p, ratio: p.count ? p.fix / p.count : 0 })).sort((a, b) => b.ratio - a.ratio).slice(0, 5), [profiles]);
  const oldest = useMemo(() => queue.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, 5), [queue]);
  const disciplineDirs = useMemo<DirLite[]>(() => profiles.filter((p) => !p.revoked).map((p) => ({ login: p.login, name: p.display_name || p.login, last_submit: p.last_at || null })), [profiles]);

  const [rview, setRview] = useState(() => { try { return localStorage.getItem("sv-rv-view") || "cards"; } catch { return "cards"; } });
  const chRview = (v: string) => { setRview(v); try { localStorage.setItem("sv-rv-view", v); } catch { /* */ } };
  const [rq, setRq] = useState("");
  const [qFilter, setQFilter] = useState("");

  const ini = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase() || s.slice(0, 1).toUpperCase();
  const nameOf = (p: RvProfile) => p.display_name || p.login;
  const fmtB = (n: number) => n < 1024 ? n + " Б" : n < 1048576 ? (n / 1024).toFixed(0) + " КБ" : n < 1073741824 ? (n / 1048576).toFixed(1) + " МБ" : (n / 1073741824).toFixed(1) + " ГБ";
  const fcolor = (n: string) => { const x = n.toLowerCase(); if (/\.(xlsx|xls|csv)$/.test(x)) return "linear-gradient(135deg,#12b886,#20c997)"; if (/\.pdf$/.test(x)) return "linear-gradient(135deg,#f03e5e,#ff6b81)"; if (/\.(png|jpe?g|gif|webp|bmp|svg|heic)$/.test(x)) return "linear-gradient(135deg,#8b5cf6,#d946ef)"; if (/\.(docx?|rtf|svdoc|odt)$/.test(x)) return "linear-gradient(135deg,#2563eb,#60a5fa)"; return "linear-gradient(135deg,var(--a1),var(--a2))"; };
  const ficon = (n: string) => /\.(xlsx|xls|csv)$/.test(n.toLowerCase()) ? <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></> : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>;
  const ageOf = (iso: string) => { const t = Date.parse(iso); if (isNaN(t)) return ""; const d = Math.floor((Date.now() - t) / 864e5); return d >= 2 ? d + " дн." : ""; };
  const stOf = (p: RvProfile) => (p.fix > 0 ? "fix" : p.review > 0 ? "wait" : "ok");
  const unitIco = <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M6.5 16a2.6 2.6 0 0 1 5 0M15 9.5h3M15 13h3" /></>;
  const healthBar = (p: RvProfile, cls = "health") => { const t = p.count || 1; const ok = Math.max(0, p.count - p.review - p.fix); const seg = (n: number, c: string) => n ? <i key={c} style={{ width: (n / t * 100) + "%", background: c }} /> : null; return <div className={cls}>{seg(ok, "var(--good)")}{seg(p.review, "var(--warn)")}{seg(p.fix, "var(--danger)")}</div>; };

  const saveToDisk = async (name: string, b64: string) => { try { await invoke<string>("sv_save_file", { filename: name, contentB64: b64 }); notify("Сохранено в «Загрузки»: " + name); } catch (e) { notify("" + String(e)); } };
  const openNative = async (id: string, name: string) => { setOpening("Открываю в программе…"); try { await invoke("sv_rv_open_file", { login, password: pw, id, filename: name }); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const downloadRec = async (id: string, name: string) => { setOpening("Готовлю файл…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id }); await saveToDisk(name, b); } catch (e) { notify("" + String(e)); } setOpening(""); };
  const openQ = async (q: RvQueue) => {
    if (q.kind === "file" && isDoc(q.name)) { setOpening("Открываю документ…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: q.id }); setDoc({ id: q.id, name: q.name, folder: q.folder || "", owner: q.owner_login, content: b64ToTxt(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (q.kind === "file" && isSheet(q.name)) { setOpening("Открываю таблицу…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: q.id }); setSheet({ id: q.id, name: q.name, folder: q.folder || "", owner: q.owner_login, bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    if (q.kind === "file") { setOpening("Открываю файл…"); try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: q.id }); setViewer({ q, bytes: b64ToBytes(b) }); } catch (e) { notify("" + String(e)); } setOpening(""); return; }
    setView(q); setViewText(""); setViewBusy(true); setOpening("Расшифровываю…");
    try { const b = await invoke<string>("sv_rv_open", { login, password: pw, id: q.id }); setViewText(b64ToTxt(b)); } catch (e) { setViewText("Ошибка: " + String(e)); }
    setViewBusy(false); setOpening("");
  };
  const saveSheet = async (bytes: Uint8Array, name: string) => { if (!sheet) return; setSheetSaving(true); try { await invoke("sv_rv_submit", { login, password: pw, owner: sheet.owner, folder: sheet.folder, title: name, kind: "file", contentB64: bytesToB64(bytes) }); await invoke("sv_rv_delete", { login, password: pw, id: sheet.id }); setSheet(null); load(); } catch (e) { notify("" + String(e)); } setSheetSaving(false); };
  const saveDoc = async (bytes: Uint8Array, name: string) => { if (!doc) return; setDocSaving(true); try { await invoke("sv_rv_submit", { login, password: pw, owner: doc.owner, folder: doc.folder, title: name, kind: "file", contentB64: bytesToB64(bytes) }); await invoke("sv_rv_delete", { login, password: pw, id: doc.id }); setDoc(null); load(); } catch (e) { notify("" + String(e)); } setDocSaving(false); };
  const saveEdit = async () => { if (!view) return; setViewBusy(true); try { await invoke("sv_rv_submit", { login, password: pw, owner: view.owner_login, folder: view.folder || "", title: view.name, kind: "report", contentB64: txtToB64(viewText) }); await invoke("sv_rv_delete", { login, password: pw, id: view.id }); setView(null); load(); } catch (e) { notify("" + String(e)); } setViewBusy(false); };
  const [remark, setRemark] = useState<RvQueue | null>(null);
  const acceptQ = async (q: RvQueue) => { setOpening("Принимаю…"); try { await invoke("sv_rv_set_status", { login, password: pw, id: q.id, status: "ok" }); await load(); notify("Принято ✓"); } catch (e) { notify("" + String(e)); } setOpening(""); };
  // замечание: сначала открываем переписку; статус «на доработку» ставим только после отправки комментария (отмена — ничего не меняет)
  const remarkQ = (q: RvQueue) => { setRemark(q); setCmFor({ id: q.id, name: q.name, owner: q.owner_login, ownerName: q.owner_name || q.owner_login }); };

  const Pill = ({ id, label, icon, badge }: { id: string; label: string; icon: React.ReactNode; badge?: number }) => (
    <button className={!open && section === id ? "on" : ""} onClick={() => { setOpen(null); setMenu(false); setSection(id); }}>{icon}<span>{label}</span>{badge ? <span className="c">{badge}</span> : null}</button>
  );

  const QRow = ({ q, big }: { q: RvQueue; big?: boolean }) => (
    <div className="qrow">
      <span className="fi" style={{ background: fcolor(q.name), width: big ? 40 : 36, height: big ? 40 : 36 }}>{nic(ficon(q.name), big ? 19 : 18)}</span>
      <div className="qbody" onClick={() => openQ(q)} style={{ cursor: "pointer" }}>
        <div className="nm" style={big ? { fontSize: 14 } : undefined}>{q.name}</div>
        <div className="sub">{fmtDate(q.at)}{q.submitter && q.submitter !== q.owner_login ? " · добавил " + q.submitter : ""}</div>
        <span className="qtag">{nic(unitIco, 12)} {q.owner_name || q.owner_login}</span>
        {ageOf(q.at) && <span className="qage">{nic(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 11)}ждёт {ageOf(q.at)}</span>}
      </div>
      {can("review") && big && <div className="qacts">
        <button className="qbtn acc tipbtn" data-tip="Принять" onClick={(e) => { e.stopPropagation(); acceptQ(q); }}>{nic(<path d="M20 6 9 17l-5-5" />, 16)}</button>
        <button className="qbtn rem tipbtn" data-tip="Вернуть с замечанием" onClick={(e) => { e.stopPropagation(); remarkQ(q); }}>{nic(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 16)}</button>
      </div>}
      {!big && <span className="qgo">{nic(<path d="m9 18 6-6-6-6" />, 16)}</span>}
    </div>
  );

  const donut = (ok: number, review: number, fix: number) => {
    const tot = ok + review + fix; const R = 52, C = 2 * Math.PI * R; let acc = 0;
    const segs = [{ n: ok, c: "var(--good)" }, { n: review, c: "var(--warn)" }, { n: fix, c: "var(--danger)" }].filter((s) => s.n > 0);
    return <svg viewBox="0 0 130 130" className="donut">
      <circle cx="65" cy="65" r={R} fill="none" stroke="color-mix(in srgb,var(--text) 8%,transparent)" strokeWidth="13" />
      {tot > 0 && segs.map((s, i) => { const len = (s.n / tot) * C, off = acc; acc += len; return <circle key={i} cx="65" cy="65" r={R} fill="none" stroke={s.c} strokeWidth="13" strokeLinecap="round" strokeDasharray={`${Math.max(0, len - 3)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 65 65)" />; })}
      <text x="65" y="60" textAnchor="middle" className="donut-n">{tot}</text>
      <text x="65" y="78" textAnchor="middle" className="donut-l">файлов</text>
    </svg>;
  };

  const profilesFiltered = useMemo(() => { if (!rq.trim()) return profiles; const q = rq.toLowerCase(); return profiles.filter((p) => p.login.toLowerCase().includes(q)); }, [profiles, rq]);
  const queueFiltered = useMemo(() => qFilter ? queue.filter((q) => q.owner_login === qFilter) : queue, [queue, qFilter]);
  const queueOwners = useMemo(() => { const m = new Map<string, { login: string; name: string; count: number }>(); queue.forEach((q) => { const e = m.get(q.owner_login) || { login: q.owner_login, name: q.owner_name || q.owner_login, count: 0 }; e.count++; m.set(q.owner_login, e); }); return [...m.values()].sort((a, b) => b.count - a.count); }, [queue]);

  return (
    <div className="ws" data-theme={theme} data-accent={accent || undefined} style={{ height: "100%", overflow: "auto", position: "relative" }} onClick={() => menu && setMenu(false)}>
      <div className="aura"><b /><b /><b /></div>
      {(!online || (net && !net.server)) && (
        <div className="offbar" role="alert">
          <span className="offbar-ic">{nic(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" /></>, 20)}</span>
          <div className="offbar-tx"><b>{!online ? "Нет подключения к интернету" : "Сервер недоступен"}</b><span>{!online ? "Проверьте Wi-Fi или кабель." : "Не удаётся связаться с сервером."}</span></div>
          <button className="offbar-btn" onClick={recheck}>{nic(<><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></>, 15)}Повторить</button>
        </div>
      )}
      <div className="wrap" style={{ maxWidth: 1240 }}>
        <div className="pbar glass shadow">
          <div className="bn"><i>{nic(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, 13)}</i><span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{info.org}<span style={{ fontWeight: 600, fontSize: 11, color: "var(--muted)", fontFamily: "var(--fbody)" }}>&nbsp;· проверяющий</span></span></div>
          <nav className="pills">
            <Pill id="dash" label="Обзор" icon={nic(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>)} />
            <Pill id="profiles" label="Профили" icon={nic(unitIco)} />
            {reviewOn && <Pill id="queue" label="Проверка" icon={nic(<><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>)} badge={pendingN} />}
            {can("submit") && <Pill id="mine" label="Мои отчёты" icon={nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>)} />}
            {can("view_log") && <Pill id="log" label="Журнал" icon={nic(<><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></>)} />}
          </nav>
          <div className="r">
            <button className="topnet tipbtn tipdown" data-tip={!online ? "Нет интернета" : net ? (net.server ? `Сервер в сети · ${net.ms} мс` : "Сервер недоступен") : "Проверка…"}><span className={"topnet-dot " + (netOk ? "on" : "off")} />{nic(<><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" /></>, 17)}</button>
            <NotifBell login={login} pw={pw} onOpen={() => { setOpen(null); setSection("queue"); }} />
            <div className="avatar" onClick={(e) => e.stopPropagation()}>
              <button className="btnav" onClick={() => setMenu((m) => !m)}><span className="ava on-dot">{ini(login)}</span></button>
              <div className="menu glass shadow" hidden={!menu}>
                <div className="mhd"><span className="ava" style={{ width: 34, height: 34 }}>{ini(login)}</span><div><div style={{ fontWeight: 700, fontSize: 13 }}>{login}</div><div style={{ fontSize: 11, color: "var(--muted)" }}>Проверяющий · видит всё</div></div></div>
                <button className="mi" onClick={() => { setMenu(false); setOpen(null); setSection("me"); }}>{nic(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>)}Мой профиль</button>
                <button className="mi" style={{ color: "var(--danger)" }} onClick={onExit}>{nic(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>)}Выйти</button>
              </div>
            </div>
          </div>
        </div>

        {open ? <RvProfileView info={info} pw={pw} director={open} reviewOn={reviewOn} onBack={() => { setOpen(null); load(); }} />
          : section === "mine" ? <DirReports login={login} pw={pw} info={info} recs={ownRecs} loading={ownLoading} reloadRecs={loadOwn} folders={ownFolders} reloadFolders={loadOwnFolders} path={ownPath} setPath={setOwnPath} heading="Мои отчёты" sub="Ваши файлы и отчёты" reviewOn={reviewOn} />
            : section === "log" ? <ReviewerActivity login={login} pw={pw} />
              : section === "me" ? <>
                <div className="card glass shadow" style={{ marginBottom: 14 }}><h3><span className="rail5" />Оформление</h3>
                  <div className="psetrow"><div className="pt"><div className="nm">Тёмная тема</div><div className="sub">Переключить вид приложения</div></div><div className={"switch2" + (theme === "dark" ? " on" : "")} onClick={onToggleTheme}><i /></div></div>
                  <div className="psetrow" style={{ flexWrap: "wrap" }}><div className="pt"><div className="nm">Акцент</div><div className="sub">Цвет интерфейса — на ваш вкус</div></div>
                    <div className="sws">{accents.map(([v, g]) => <span key={v || "d"} className={"sw" + (accent === v ? " on" : "")} onClick={() => chAccent(v)} style={{ background: "linear-gradient(135deg," + g + ")" }} />)}</div>
                  </div>
                </div>
                <MeSection login={login} pw={pw} info={info} theme={theme} onToggleTheme={onToggleTheme} onExit={onExit} allowPassword={false} showTheme={false} />
              </>
                : loading ? <div className="card glass shadow"><BrandLoading /></div>
                  : section === "dash" ? <>
                    <div className="shead"><div className="headava">{ini(login)}</div><div style={{ flex: 1, minWidth: 200 }}><h1>Обзор</h1><div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>{profiles.length} профилей{reviewOn ? <> · <b style={{ color: "var(--warn)" }}>{pendingN} на проверке</b>{fixN > 0 && <> · <b style={{ color: "var(--danger)" }}>{fixN} замечани{fixN === 1 ? "е" : fixN < 5 ? "я" : "й"}</b></>}</> : <> · {totalFiles} файлов</>}</div></div>
                      {reviewOn && <button className="chip grad" onClick={() => setSection("queue")}>{nic(<><path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>)}К проверке</button>}
                    </div>
                    <ApprovalsCard login={login} pw={pw} notify={notify} />
                    <div className="strip">
                      <div className="kpi glass in" onClick={() => setSection("profiles")} style={{ cursor: "pointer" }}><span className="d" style={{ background: "var(--info)" }} /><div className="n">{profiles.length}</div><div className="k">Профилей</div></div>
                      {reviewOn ? <>
                        <div className="kpi glass in" onClick={() => setSection("queue")} style={{ animationDelay: ".05s", cursor: "pointer" }}><span className="d" style={{ background: "var(--warn)" }} /><div className="n" style={{ color: "var(--warn)" }}>{pendingN}</div><div className="k">На проверке</div></div>
                        <div className="kpi glass in" onClick={() => setSection("profiles")} style={{ animationDelay: ".1s", cursor: "pointer" }}><span className="d" style={{ background: "var(--danger)" }} /><div className="n" style={{ color: "var(--danger)" }}>{fixN}</div><div className="k">С замечаниями</div></div>
                        <div className="kpi glass in" style={{ animationDelay: ".15s" }}><span className="d" style={{ background: "var(--good)" }} /><div className="n" style={{ color: "var(--good)" }}>{okN}</div><div className="k">Принято</div></div>
                      </> : <>
                        <div className="kpi glass in" onClick={() => setSection("profiles")} style={{ animationDelay: ".05s", cursor: "pointer" }}><span className="d" style={{ background: "var(--good)" }} /><div className="n">{totalFiles}</div><div className="k">Файлов сдано</div></div>
                        <div className="kpi glass in" style={{ animationDelay: ".1s" }}><span className="d" style={{ background: "var(--a3)" }} /><div className="n">{disciplineDirs.length}</div><div className="k">Директоров</div></div>
                        <div className="kpi glass in" style={{ animationDelay: ".15s" }}><span className="d" style={{ background: "var(--warn)" }} /><div className="n">{ovBars.reduce((a, d) => a + d.n, 0)}</div><div className="k">За период</div></div>
                      </>}
                    </div>
                    <DisciplineCard dirs={disciplineDirs} deadlineDay={deadlineDay} onPick={(lg) => { const p = profiles.find((x) => x.login === lg); if (p) setOpen(p); }} />
                    <div className="three">
                      {reviewOn ? <div className="card glass shadow"><h3><span className="rail5" />Очередь проверки<span className="n" style={{ marginLeft: 2, fontFamily: "var(--fsora)", fontWeight: 800, fontSize: 14 }}>{pendingN}</span><button className="allbtn" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--a1)", border: "none", background: "none" }} onClick={() => setSection("queue")}>вся</button></h3>
                        {queue.length === 0 ? <div className="celebrate" style={{ padding: "26px 10px" }}><div className="cc" style={{ width: 48, height: 48, borderRadius: 15, marginBottom: 10 }}>{nic(<path d="M20 6 9 17l-5-5" />, 22)}</div><div className="nm" style={{ fontSize: 14 }}>Всё проверено</div></div>
                          : queue.slice(0, 4).map((q) => <QRow key={q.id} q={q} />)}
                      </div> : <div className="card glass shadow"><h3><span className="rail5" />Последние сданные</h3>
                        {recent.length === 0 ? <div className="sub" style={{ padding: "4px 2px" }}>Пока ничего не сдано.</div>
                          : recent.slice(0, 6).map((r) => (<div key={r.id} className="f" onClick={() => { const p = profiles.find((x) => x.login === r.owner_login); if (p) setOpen(p); }}><span className="fi" style={{ background: fcolor(r.name), width: 32, height: 32 }}>{nic(ficon(r.name), 16)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{r.name}</div><div className="sub">{r.owner_login} · {fmtDate(r.at)}</div></div></div>))}
                      </div>}
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        {reviewOn && <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(var(--danger),#ff6b81)" }} />Профили — требуют внимания</h3>
                          {attention.length === 0 ? <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)", padding: "4px 2px" }}><span style={{ color: "var(--good)", display: "flex" }}>{nic(<path d="M20 6 9 17l-5-5" />)}</span>Везде порядок — замечаний и очереди нет.</div>
                            : attention.map((p) => (<div key={p.login} className="f" onClick={() => setOpen(p)}><span className="fi" style={{ background: `linear-gradient(135deg,${avatarGrad(p.login)})` }}>{ini(nameOf(p))}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{nameOf(p)}</div><div className="sub">{p.count} файлов · {fmtB(p.bytes)}</div></div><div style={{ display: "flex", gap: 6 }}>{p.fix > 0 && <span className="st fix">{p.fix} замеч.</span>}{p.review > 0 && <span className="st wait">{p.review} на пров.</span>}</div></div>))}
                        </div>}
                        <div className="card glass shadow"><h3><span className="rail5" />Сдано отчётов<div className="seg" style={{ marginLeft: "auto" }}><button className={ovRange === "week" ? "on" : ""} onClick={() => setOvRange("week")}>Неделя</button><button className={ovRange === "month" ? "on" : ""} onClick={() => setOvRange("month")}>Месяц</button></div></h3>
                          <div className="week" style={{ height: 100, "--wmax": "100%", "--wgap": "8px" } as React.CSSProperties}>{ovBars.map((d, i) => (<div key={i} className={"wd tipbtn" + (d.today ? " today" : "")} data-tip={d.tip}><span className="wn">{d.n || ""}</span><div className="wtrack"><i className="wb" style={{ height: Math.max(4, Math.round((d.n / ovWeekMax) * 100)) + "%" }} /></div><span className="wl">{d.label}</span></div>))}</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        {reviewOn && <div className="card glass shadow"><h3><span className="rail5" />Статусы по профилям</h3>
                          <div className="donut-wrap">{donut(okN, pendingN, fixN)}<div className="donut-leg"><div className="dleg"><span className="d" style={{ background: "var(--good)" }} /><span className="dleg-t">Принято</span><span className="dleg-n">{okN}</span></div><div className="dleg"><span className="d" style={{ background: "var(--warn)" }} /><span className="dleg-t">На проверке</span><span className="dleg-n">{pendingN}</span></div><div className="dleg"><span className="d" style={{ background: "var(--danger)" }} /><span className="dleg-t">Замечания</span><span className="dleg-n">{fixN}</span></div></div></div>
                        </div>}
                        <div className="card glass shadow"><h3><span className="rail5" />Больше всего файлов</h3>
                          {rank.length === 0 ? <div className="sub">Пока нет данных.</div> : rank.map((p) => (<div key={p.login} className="rankrow" onClick={() => setOpen(p)}><span className="rt">{nameOf(p)}</span><span className="rbar"><i style={{ width: (p.count / rankMax * 100) + "%" }} /></span><span className="rv">{p.count}</span></div>))}
                        </div>
                      </div>
                    </div>
                    {reviewOn && <div className="block-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
                      <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(var(--danger),#ff6b81)" }} />Чаще всего замечания</h3>
                        {fixRank.length === 0 ? <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)", padding: "4px 2px" }}><span style={{ color: "var(--good)", display: "flex" }}>{nic(<path d="M20 6 9 17l-5-5" />)}</span>Замечаний нет ни у одного профиля.</div>
                          : fixRank.map(({ p, ratio }) => (<div key={p.login} className="rankrow" onClick={() => setOpen(p)}><span className="rt">{nameOf(p)}</span><span className="rbar"><i style={{ width: Math.max(6, ratio * 100) + "%", background: "linear-gradient(90deg,var(--danger),#ff6b81)" }} /></span><span className="rv">{p.fix}/{p.count}</span></div>))}
                      </div>
                      <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(var(--warn),#ffa94d)" }} />Дольше всего ждут</h3>
                        {oldest.length === 0 ? <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-2)", padding: "4px 2px" }}><span style={{ color: "var(--good)", display: "flex" }}>{nic(<path d="M20 6 9 17l-5-5" />)}</span>Очередь пуста.</div>
                          : oldest.map((q) => (<div key={q.id} className="f" onClick={() => openQ(q)}><span className="fi" style={{ background: fcolor(q.name), width: 32, height: 32 }}>{nic(ficon(q.name), 16)}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{q.name}</div><div className="sub">{q.owner_name || q.owner_login} · {fmtDate(q.at)}</div></div>{ageOf(q.at) && <span className="qage" style={{ marginLeft: 0 }}>ждёт {ageOf(q.at)}</span>}</div>))}
                      </div>
                    </div>}
                  </>
                    : section === "profiles" ? <>
                      <div className="shead"><div style={{ flex: 1, minWidth: 160 }}><h1>Профили</h1><div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>{profiles.length} профилей · вы видите все</div></div>
                        <div className="dsearch"><span style={{ display: "flex", color: "var(--muted)" }}>{nic(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, 15)}</span><input value={rq} onChange={(e) => setRq(e.target.value)} placeholder="Поиск по профилю или человеку…" /></div>
                        <div className="vswitch">
                          <button className={rview === "cards" ? "on" : ""} onClick={() => chRview("cards")}>{nic(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>, 15)}Карточки</button>
                          <button className={rview === "list" ? "on" : ""} onClick={() => chRview("list")}>{nic(<><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>, 15)}Список</button>
                          {reviewOn && <button className={rview === "kanban" ? "on" : ""} onClick={() => chRview("kanban")}>{nic(<><rect x="3" y="3" width="5" height="18" rx="1.5" /><rect x="10" y="3" width="5" height="18" rx="1.5" /><rect x="17" y="3" width="4" height="18" rx="1.5" /></>, 15)}По статусу</button>}
                        </div>
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}><DownloadAllButton login={login} pw={pw} notify={notify} /></div>
                      {profilesFiltered.length === 0 ? <div className="card glass shadow"><div className="empty">{profiles.length === 0 ? "Профилей пока нет." : "Ничего не найдено."}</div></div>
                        : (reviewOn && rview === "kanban") ? <div className="kanban">{([["wait", "На проверке", "var(--warn)"], ["fix", "С замечаниями", "var(--danger)"], ["ok", "В порядке", "var(--good)"]] as [string, string, string][]).map(([k, title, col]) => { const items = profilesFiltered.filter((p) => k === "wait" ? p.review > 0 : k === "fix" ? p.fix > 0 : (p.review === 0 && p.fix === 0)); return (
                              <div key={k} className="kcol card glass shadow"><div className="khead"><span className="kdot" style={{ background: col }} />{title}<span className="kn">{items.length}</span></div>{items.length ? items.map((p) => (<div key={p.login} className="kchip" onClick={() => setOpen(p)}><span className="rini3" style={{ background: `linear-gradient(135deg,${avatarGrad(p.login)})` }}>{ini(nameOf(p))}</span><div style={{ flex: 1, minWidth: 0 }}><div className="nm">{nameOf(p)}</div><div className="sub">{k === "ok" ? p.count + " файл." : k === "wait" ? p.review + " ждут проверки" : p.fix + " с замечанием"}</div></div></div>)) : <div className="sub" style={{ padding: "8px 4px" }}>—</div>}</div>
                            ); })}</div>
                        : rview === "list" ? <div className="card glass shadow rlist" style={{ padding: 0 }}>{profilesFiltered.map((p) => (
                            <div key={p.login} className="rlrow" onClick={() => setOpen(p)}><span className="rini2" style={{ background: `linear-gradient(135deg,${avatarGrad(p.login)})` }}>{ini(nameOf(p))}</span><div style={{ minWidth: 0 }}><div className="nm" style={{ fontSize: 14 }}>{nameOf(p)}</div><div className="sub">{p.display_name ? p.login : "директор"}</div></div><div className="rmini"><div className="rmetric"><div className="mn">{p.count}</div><div className="ml">файлов</div></div><div className="rmetric"><div className="mn" style={{ fontSize: 13 }}>{fmtB(p.bytes)}</div><div className="ml">{p.quota_bytes > 0 ? "из " + fmtB(p.quota_bytes) : "на диске"}</div></div>{reviewOn && <><div className="rmetric"><div className="mn" style={{ color: p.review ? "var(--warn)" : "var(--muted-2)" }}>{p.review}</div><div className="ml">на пров.</div></div><div className="rmetric"><div className="mn" style={{ color: p.fix ? "var(--danger)" : "var(--muted-2)" }}>{p.fix}</div><div className="ml">замеч.</div></div></>}{healthBar(p, "hbar")}<span className="rchev">{nic(<path d="m9 18 6-6-6-6" />, 16)}</span></div></div>
                          ))}</div>
                        : <div className="rgrid">{profilesFiltered.map((p) => { const st = stOf(p); return (
                          <div key={p.login} className="rcard" onClick={() => setOpen(p)}><div className="rcov" style={{ background: `linear-gradient(135deg,${avatarGrad(p.login)})` }}><span className="rini">{ini(p.login)}</span>{reviewOn && <span className="flag">{st === "fix" ? <>{nic(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 11)} {p.fix} замеч.</> : st === "wait" ? <>{nic(<><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></>, 11)} {p.review} на пров.</> : <>{nic(<path d="M20 6 9 17l-5-5" />, 11)} ок</>}</span>}</div><div className="rb"><div className="rn">{nameOf(p)}</div><div className="rd">{p.display_name ? p.login : "директор"}{p.revoked ? " · отозван" : ""}</div><div className="rstats"><span className="rpill">{nic(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, 12)}{p.count} файл.</span><span className="rpill">{fmtB(p.bytes)}{p.quota_bytes > 0 ? " / " + fmtB(p.quota_bytes) : ""}</span>{reviewOn && p.review > 0 && <span className="rpill w">{p.review} на пров.</span>}{reviewOn && p.fix > 0 && <span className="rpill f">{p.fix} замеч.</span>}</div>{healthBar(p)}</div></div>
                        ); })}</div>}
                    </>
                      : <>
                        <div className="shead"><div style={{ flex: 1, minWidth: 160 }}><h1>Проверка</h1><div className="sub" style={{ color: "var(--muted)", marginTop: 2 }}>Файлы, ожидающие вашего решения · по всем профилям</div></div></div>
                        {queueOwners.length > 1 && <div className="filters"><button className={"fchip" + (qFilter === "" ? " on" : "")} onClick={() => setQFilter("")}>Все<span className="fc">{queue.length}</span></button>{queueOwners.map((o) => <button key={o.login} className={"fchip" + (qFilter === o.login ? " on" : "")} onClick={() => setQFilter(o.login)}>{o.name}<span className="fc">{o.count}</span></button>)}</div>}
                        <div className="card glass shadow" style={{ padding: "8px 12px" }}>
                          {queueFiltered.length === 0 ? <div className="celebrate"><div className="cc">{nic(<path d="M20 6 9 17l-5-5" />, 30)}</div><h3>Всё проверено</h3><div className="sub">Нет файлов, ожидающих вашего решения.</div></div>
                            : queueFiltered.map((q) => <QRow key={q.id} q={q} big />)}
                        </div>
                      </>}
      </div>

      {cmFor && <CommentsDrawer login={login} pw={pw} owner={cmFor.owner} toName={cmFor.ownerName} rec={cmFor} hint={remark ? "Опишите, что нужно исправить. Как только отправите комментарий — файл вернётся автору на доработку с пометкой «замечание». Нажмёте «Отмена» — ничего не изменится." : undefined} onClose={() => { setCmFor(null); setRemark(null); load(); }} onPosted={async () => { if (remark) { try { await invoke("sv_rv_set_status", { login, password: pw, id: remark.id, status: "fix" }); } catch (e) { notify("" + String(e)); } setRemark(null); } await load(); }} notify={notify} />}
      {sheet && <SheetEditor initial={sheet.bytes} name={sheet.name} saving={sheetSaving} onSave={saveSheet} onDownload={can("export") ? (b, n) => saveToDisk(n, bytesToB64(b)) : undefined} onOpenNative={can("export") ? () => openNative(sheet.id, sheet.name) : undefined} onClose={() => !sheetSaving && setSheet(null)} />}
      {doc && <DocEditor initial={doc.content} name={doc.name} saving={docSaving} onSave={saveDoc} onClose={() => !docSaving && setDoc(null)} />}
      {viewer && <FileViewer bytes={viewer.bytes} name={viewer.q.name} saving={!!opening} onDownload={can("export") ? () => downloadRec(viewer.q.id, viewer.q.name) : undefined} onOpenNative={can("export") ? () => openNative(viewer.q.id, viewer.q.name) : undefined} onClose={() => setViewer(null)} />}
      {view && <Drawer open onClose={() => !viewBusy && setView(null)} title={view.name}>
        {viewBusy && !viewText ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13 }}><span className="spinner" /> Расшифровываю…</div> : <>
          <textarea style={{ ...input, minHeight: 300, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} value={viewText} onChange={(e) => setViewText(e.target.value)} />
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button style={{ ...btn, flexGrow: 1, opacity: viewBusy ? 0.7 : 1 }} disabled={viewBusy} onClick={saveEdit}>{viewBusy ? <span className="spinner spinner--on-accent" /> : "Сохранить"}</button>
          </div>
        </>}
      </Drawer>}
      <Toast msg={toast} />
      {opening && <LoadingOverlay text={opening} />}
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

function RvProfileView({ info, pw, director, reviewOn = true, onBack }: { info: MasterInfo; pw: string; director: RvProfile; reviewOn?: boolean; onBack: () => void }) {
  const login = info.login;
  const owner = director.login;
  const [recs, setRecs] = useState<DRec[]>([]);
  const [loading, setLoading] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const load = async () => { setLoading(true); try { setRecs(await invoke<DRec[]>("sv_rv_list", { login, password: pw, owner })); } catch { /* */ } setLoading(false); };
  const loadFolders = async () => { try { setFolders(await invoke<string[]>("sv_dir_folders", { login, password: pw })); } catch { /* */ } };
  useEffect(() => { load(); loadFolders(); /* eslint-disable-next-line */ }, [owner]);
  const setStatus = async (id: string, status: string) => { try { await invoke("sv_rv_set_status", { login, password: pw, id, status }); await load(); } catch { /* */ } };
  return (
    <>
      <button className="backb" style={{ marginBottom: 12 }} onClick={onBack}>{nic(<path d="m15 18-6-6 6-6" />, 15)}Все профили</button>
      <DirReports login={login} pw={pw} info={info} recs={recs} loading={loading} reloadRecs={load} folders={folders} reloadFolders={loadFolders} path={path} setPath={setPath} heading={director.display_name || owner} sub={director.display_name ? owner + " · профиль" : "профиль"} owner={owner} rv reviewOn={reviewOn} review={reviewOn && hasPerm(info, "review")} onStatus={setStatus} />
    </>
  );
}

function CommentsDrawer({ login, pw, owner, rec, onClose, onPosted, notify, toName, hint }: { login: string; pw: string; owner: string; rec: { id: string; name: string }; onClose: () => void; onPosted?: () => void; notify: (m: string) => void; toName?: string; hint?: string }) {
  const [list, setList] = useState<CommentT[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastRead, setLastRead] = useState("");
  const lastReadRef = useRef<string | null>(null);
  const load = async () => { setLoading(true); try { const r = await invoke<{ comments: CommentT[]; last_read: string }>("sv_cm_list", { login, password: pw, recordId: rec.id }); setList(r.comments); if (lastReadRef.current === null) { lastReadRef.current = r.last_read; setLastRead(r.last_read); } } catch (e) { notify("" + String(e)); } setLoading(false); };
  const isUnread = (c: CommentT) => c.author !== login && (!lastRead || Date.parse(c.at) > Date.parse(lastRead));
  useEffect(() => { load(); }, [rec.id]);
  const send = async () => { if (!text.trim()) return; setBusy(true); try { await invoke("sv_cm_add", { login, password: pw, recordId: rec.id, owner, text: text.trim() }); setText(""); await load(); onPosted?.(); } catch (e) { notify("" + String(e)); } setBusy(false); };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } };
  return (
    <Drawer open onClose={() => !busy && onClose()} title={hint ? "Замечание" : "Комментарии"}>
      {hint && list.length === 0 && !loading && <div style={{ display: "flex", gap: 10, padding: "11px 13px", borderRadius: 11, background: "color-mix(in srgb,var(--warn) 12%,transparent)", border: "1px solid var(--warn)", marginBottom: 12 }}>
        <span style={{ color: "var(--warn)", flexShrink: 0, display: "flex" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg></span>
        <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.45 }}>{hint}</div>
      </div>}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 11, background: "var(--surface-2)", border: "1px solid var(--border-2)", marginBottom: 14 }}>
        {hint && list.length > 0 && <span className="tipbtn" data-tip={hint} style={{ display: "flex", color: "var(--warn)", cursor: "help", flexShrink: 0 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg></span>}
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
              const unread = isUnread(c);
              return (
                <div key={i} style={{ display: "flex", flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-end", gap: 8 }}>
                  <span style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${avatarGrad(c.author)})`, color: "#fff", fontSize: 11.5, fontWeight: 700 }}>{(c.author_name || c.author).slice(0, 1).toUpperCase()}</span>
                  <div style={{ maxWidth: "78%", background: mine ? "var(--accent)" : "var(--surface-2)", color: mine ? "#fff" : "var(--text-2)", border: unread ? "1.5px solid var(--warn)" : mine ? "none" : "1px solid var(--border-2)", borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, padding: "9px 12px", boxShadow: unread ? "0 0 0 3px color-mix(in srgb,var(--warn) 16%,transparent)" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}><div style={{ fontSize: 11, fontWeight: 650, opacity: mine ? 0.85 : 1, color: mine ? "#fff" : "var(--text)" }}>{mine ? "Вы" : (c.author_name || c.author)}</div>{unread && <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".03em", color: "var(--warn)", background: "color-mix(in srgb,var(--warn) 18%,transparent)", borderRadius: 999, padding: "1px 6px" }}>НОВОЕ</span>}</div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{c.text}</div>
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4, textAlign: "right" }}>{fmtDate(c.at)}</div>
                  </div>
                </div>
              );
            })}
      </div>
      <textarea style={{ ...input, minHeight: 84, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={(toName ? "Комментарий для " + toName : "Написать комментарий") + "…  (⌘/Ctrl + Enter — отправить)"} />
      <button style={{ ...btn, width: "100%", marginTop: 10, opacity: busy || !text.trim() ? 0.6 : 1 }} disabled={busy || !text.trim()} onClick={send}>{busy ? <><span className="spinner spinner--on-accent" /> Отправляю…</> : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>Отправить</>}</button>
    </Drawer>
  );
}

// Карточка «подтверждение опасной операции» — для проверяющего и мастера (одобряют чужие запросы)
function ApprovalsCard({ login, pw, notify }: { login: string; pw: string; notify: (m: string) => void }) {
  const [inc, setInc] = useState<ApRow[]>([]);
  const [busy, setBusy] = useState("");
  const load = () => invoke<{ incoming: ApRow[] }>("sv_approval_list", { login, password: pw }).then((r) => setInc(r.incoming || [])).catch(() => { /* */ });
  useEffect(() => { load(); const iv = setInterval(load, 15000); const f = () => load(); window.addEventListener("focus", f); return () => { clearInterval(iv); window.removeEventListener("focus", f); }; }, []);
  const decide = async (id: string, approve: boolean) => { setBusy(id); try { await invoke("sv_approval_decide", { login, password: pw, id, approve }); notify(approve ? "Одобрено ✓" : "Отклонено"); load(); } catch (e) { notify("" + String(e)); } setBusy(""); };
  if (inc.length === 0) return null;
  return <div className="card glass shadow" style={{ marginBottom: 14, borderLeft: "3px solid var(--danger)" }}>
    <h3><span className="rail5" style={{ background: "linear-gradient(var(--danger),#ff6b81)" }} />Подтверждение опасной операции<span className="n" style={{ marginLeft: 2 }}>{inc.length}</span></h3>
    {inc.map((a) => <div key={a.id} className="f" style={{ margin: 0 }}>
      <span className="fi" style={{ background: "linear-gradient(135deg,#f03e5e,#ff6b81)" }}>{nic(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 18)}</span>
      <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{a.requester_name || a.requester} — «{apKind(a.kind)}»</div><div className="sub">запрошено {fmtDate(a.created_at)} · нужно ваше решение</div></div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button className="chip grad sm" disabled={!!busy} onClick={() => decide(a.id, true)}>Одобрить</button>
        <button className="chip sm" disabled={!!busy} onClick={() => decide(a.id, false)}>Отклонить</button>
      </div>
    </div>)}
  </div>;
}

// Кнопка «Скачать всё» (проверяющий) — через запрос-подтверждение второго. Скромная, с алертом-подтверждением.
function DownloadAllButton({ login, pw, notify }: { login: string; pw: string; notify: (m: string) => void }) {
  const [mine, setMine] = useState<ApRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const load = () => invoke<{ mine: ApRow[] }>("sv_approval_list", { login, password: pw }).then((r) => setMine(r.mine || [])).catch(() => { /* */ });
  useEffect(() => { load(); const iv = setInterval(load, 15000); const f = () => load(); window.addEventListener("focus", f); return () => { clearInterval(iv); window.removeEventListener("focus", f); }; }, []);
  const approved = mine.find((a) => a.kind === "download_all" && a.status === "approved" && !a.used);
  const pending = mine.find((a) => a.kind === "download_all" && a.status === "pending");
  const run = async () => { setBusy(true); try { const r = await invoke<{ count: number; failed: number; dir: string }>("sv_rv_download_all", { login, password: pw }); if (approved) await invoke("sv_approval_consume", { login, password: pw, id: approved.id }); notify(`Скачано ${r.count} файлов${r.failed ? `, ошибок ${r.failed}` : ""} → ${r.dir}`); load(); } catch (e) { notify("" + String(e)); } setBusy(false); };
  const request = async () => { setBusy(true); setConfirming(false); try { await invoke("sv_approval_request", { login, password: pw, kind: "download_all" }); load(); } catch (e) { notify("" + String(e)); } setBusy(false); };
  const linkBtn: React.CSSProperties = { background: "transparent", border: "none", color: "var(--muted)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 8 };
  if (approved) return <button className="chip grad sm" disabled={busy} onClick={run}>{busy ? <span className="spinner spinner--on-accent" /> : nic(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></>, 14)}Скачать всё (одобрено)</button>;
  if (pending) return <span className="dstat wait" style={{ fontSize: 11.5 }}>{nic(<><circle cx="12" cy="12" r="9" /><path d="M12 12V8M12 12h3.5" /></>, 12)}Экспорт: ждёт подтверждения второго</span>;
  if (confirming) return <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <span style={{ fontSize: 12, color: "var(--muted)" }}>Запросить экспорт? Нужно подтверждение второго.</span>
    <button className="chip grad sm" disabled={busy} onClick={request}>{busy ? <span className="spinner spinner--on-accent" /> : "Запросить"}</button>
    <button className="chip sm" disabled={busy} onClick={() => setConfirming(false)}>Отмена</button>
  </div>;
  return <button style={linkBtn} onClick={() => setConfirming(true)} title="Выгрузка всех данных — потребует подтверждения второго человека">{nic(<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></>, 14)}Экспорт всех данных…</button>;
}

// Массовое удаление (мастер) — опасная операция с подтверждением второго
function MassDeleteCard({ login, pw, notify }: { login: string; pw: string; notify: (m: string) => void }) {
  const [mine, setMine] = useState<ApRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [execConfirm, setExecConfirm] = useState(false);
  const load = () => invoke<{ mine: ApRow[] }>("sv_approval_list", { login, password: pw }).then((r) => setMine(r.mine || [])).catch(() => { /* */ });
  useEffect(() => { load(); const iv = setInterval(load, 15000); const f = () => load(); window.addEventListener("focus", f); return () => { clearInterval(iv); window.removeEventListener("focus", f); }; }, []);
  const approved = mine.find((a) => a.kind === "bulk_delete" && a.status === "approved" && !a.used);
  const pending = mine.find((a) => a.kind === "bulk_delete" && a.status === "pending");
  const request = async () => { setBusy(true); setConfirming(false); try { await invoke("sv_approval_request", { login, password: pw, kind: "bulk_delete" }); load(); } catch (e) { notify("" + String(e)); } setBusy(false); };
  const exec = async () => { setBusy(true); try { const n = await invoke<number>("sv_mass_delete", { login, password: pw }); notify("Удалено безвозвратно: " + n + " файлов"); load(); } catch (e) { notify("" + String(e)); } setBusy(false); setExecConfirm(false); };
  const warnBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "10px 16px", borderRadius: 9, fontWeight: 600, fontSize: 13.5, cursor: "pointer", border: "1px solid var(--danger)", color: "var(--danger)", background: "transparent", width: "100%" };
  return <div className="card glass shadow"><h3><span className="rail5" style={{ background: "linear-gradient(var(--danger),#ff6b81)" }} />Массовое удаление данных</h3>
    <div className="sub" style={{ marginBottom: 12, lineHeight: 1.5 }}>Удаляет все файлы организации <b style={{ color: "var(--danger)" }}>безвозвратно</b> (без корзины, восстановить нельзя). Опасная операция — требует подтверждения второго человека (проверяющего).</div>
    {approved ? (execConfirm
      ? <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 11, background: "color-mix(in srgb,var(--danger) 10%,transparent)", border: "1px solid var(--danger)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--danger)" }}>Точно удалить все данные организации?</div>
        <div className="sub" style={{ fontSize: 12 }}>Все файлы будут стёрты <b style={{ color: "var(--danger)" }}>безвозвратно</b> — восстановить нельзя. Одобрение уже получено.</div>
        <div style={{ display: "flex", gap: 8 }}><button className="chip" style={{ flex: 1, justifyContent: "center", background: "var(--danger)", color: "#fff", border: "none" }} disabled={busy} onClick={exec}>{busy ? <span className="spinner spinner--on-accent" /> : "Да, удалить всё"}</button><button className="chip" style={{ flex: 1, justifyContent: "center" }} disabled={busy} onClick={() => setExecConfirm(false)}>Отмена</button></div>
      </div>
      : <button style={{ ...warnBtn, background: "var(--danger)", color: "#fff", border: "none" }} onClick={() => setExecConfirm(true)}>Удалить всё (одобрено) ✓</button>)
      : pending ? <span className="dstat wait">{nic(<><circle cx="12" cy="12" r="9" /><path d="M12 12V8M12 12h3.5" /></>, 12)}Ждёт подтверждения второго</span>
        : confirming ? <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="sub" style={{ fontSize: 12.5 }}>Отправить запрос на массовое удаление? Выполнить сможете только после одобрения второго человека.</div>
          <div style={{ display: "flex", gap: 8 }}><button className="chip grad" style={{ flex: 1, justifyContent: "center" }} disabled={busy} onClick={request}>{busy ? <span className="spinner spinner--on-accent" /> : "Запросить"}</button><button className="chip" style={{ flex: 1, justifyContent: "center" }} disabled={busy} onClick={() => setConfirming(false)}>Отмена</button></div>
        </div>
          : <button style={warnBtn} onClick={() => setConfirming(true)}>{nic(<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>, 15)}Запросить массовое удаление</button>}
  </div>;
}

// ===================== Журнал собственных действий =====================
type LogEnt = { action: string; target: string; at: string; rid: string };
const logMeta = (a: string): { label: string; color: string; cat: string; icon: React.ReactNode } => {
  switch (a) {
    case "submit": return { label: "Добавлен файл", color: "#10b981", cat: "submit", icon: <><path d="M12 5v14M5 12h14" /></> };
    case "sent_review": return { label: "Отправлен на проверку", color: "#f08c00", cat: "submit", icon: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></> };
    case "add": return { label: "Добавлен файл", color: "#0ea5e9", cat: "edit", icon: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></> };
    case "trash": return { label: "В корзину", color: "#f43f5e", cat: "edit", icon: <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></> };
    case "delete": case "purge": return { label: "Удалено", color: "#f43f5e", cat: "edit", icon: <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></> };
    case "restore": case "restore_version": return { label: a === "restore" ? "Восстановлено" : "Возврат версии", color: "#12b886", cat: "edit", icon: <><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /></> };
    case "rename": return { label: "Переименовано", color: "#8b5cf6", cat: "edit", icon: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></> };
    case "move": return { label: "Перемещено", color: "#0ea5e9", cat: "edit", icon: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></> };
    case "folder_move": return { label: "Папка перемещена", color: "#f08c00", cat: "edit", icon: <><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" /></> };
    case "copy": return { label: "Скопировано", color: "#6366f1", cat: "edit", icon: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></> };
    case "status": return { label: "Статус изменён", color: "#f08c00", cat: "edit", icon: <><path d="M20 6 9 17l-5-5" /></> };
    case "accepted": return { label: "Принято", color: "#12b886", cat: "edit", icon: <><path d="M20 6 9 17l-5-5" /></> };
    case "remarked": return { label: "Вернул с замечанием", color: "#f03e5e", cat: "edit", icon: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></> };
    case "unmarked": return { label: "Снял статус", color: "#f08c00", cat: "edit", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 12V7.5M12 12l3 1.6" /></> };
    case "approval_req": return { label: "Запросил опасную операцию", color: "#f08c00", cat: "edit", icon: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></> };
    case "approval_approved": return { label: "Одобрил опасную операцию", color: "#12b886", cat: "edit", icon: <path d="M20 6 9 17l-5-5" /> };
    case "approval_denied": return { label: "Отклонил опасную операцию", color: "#f03e5e", cat: "edit", icon: <><path d="M18 6 6 18M6 6l12 12" /></> };
    case "comment": return { label: "Комментарий", color: "#8b5cf6", cat: "comment", icon: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></> };
    default: return { label: a, color: "var(--muted)", cat: "edit", icon: <><circle cx="12" cy="12" r="9" /></> };
  }
};

function JournalMine({ login, pw, onOpenFile }: { login: string; pw: string; onOpenFile?: (rid: string) => void }) {
  const [items, setItems] = useState<LogEnt[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [jq, setJq] = useState("");
  const [range, setRange] = useState<"week" | "month">("week");
  const [limit, setLimit] = useState(30);
  const [flash, setFlash] = useState("");
  useEffect(() => { (async () => { try { setItems(await invoke<LogEnt[]>("sv_mylog", { login, password: pw })); } catch { /* */ } setLoading(false); })(); }, []);

  const parse = (s: string) => { const t = Date.parse(s); return isNaN(t) ? 0 : t; };
  const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today0 = dayStart(Date.now());
  const wdName = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

  const chart = useMemo(() => { const n = range === "month" ? 30 : 7; const days: { d0: number; label: string; n: number; today: boolean; showLabel: boolean }[] = []; for (let i = n - 1; i >= 0; i--) { const d0 = today0 - i * 864e5; const c = items.filter((e) => { const t = parse(e.at); return t >= d0 && t < d0 + 864e5; }).length; const idx = n - 1 - i; days.push({ d0, label: range === "month" ? String(new Date(d0).getDate()) : wdName[new Date(d0).getDay()], n: c, today: i === 0, showLabel: range === "week" || i === 0 || idx % 5 === 0 }); } return days; }, [items, today0, range]);
  const chartMax = Math.max(1, ...chart.map((d) => d.n));
  const todayCount = useMemo(() => items.filter((e) => parse(e.at) >= today0).length, [items, today0]);
  const weekCount = useMemo(() => items.filter((e) => parse(e.at) >= today0 - 6 * 864e5).length, [items, today0]);
  const lastSubmit = useMemo(() => { const s = items.find((e) => e.action === "submit"); return s ? new Date(parse(s.at)).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—"; }, [items]);
  const catCounts = useMemo(() => ({ submit: items.filter((e) => logMeta(e.action).cat === "submit").length, edit: items.filter((e) => logMeta(e.action).cat === "edit").length, comment: items.filter((e) => logMeta(e.action).cat === "comment").length }), [items]);
  const shown = useMemo(() => { const q = jq.trim().toLowerCase(); return items.filter((e) => { const m = logMeta(e.action); if (filter !== "all" && m.cat !== filter) return false; if (q && !(m.label.toLowerCase().includes(q) || (e.target || "").toLowerCase().includes(q))) return false; return true; }); }, [items, filter, jq]);
  useEffect(() => { setLimit(30); }, [filter, jq]);
  const visible = shown.slice(0, limit);
  const groups = useMemo(() => { const g: { key: string; label: string; items: LogEnt[] }[] = []; const labelFor = (t: number) => { const d0 = dayStart(t); if (d0 === today0) return "Сегодня"; if (d0 === today0 - 864e5) return "Вчера"; return new Date(d0).toLocaleDateString("ru-RU", { day: "2-digit", month: "long" }); }; for (const e of visible) { const key = String(dayStart(parse(e.at))); let grp = g.find((x) => x.key === key); if (!grp) { grp = { key, label: labelFor(parse(e.at)), items: [] }; g.push(grp); } grp.items.push(e); } return g; }, [visible, today0]);
  const relTime = (s: string) => { const t = parse(s); const diff = Date.now() - t; if (diff < 60e3) return "только что"; if (diff < 36e5) return Math.floor(diff / 60e3) + " мин назад"; return new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
  const doExport = async () => { const text = "Журнал действий — " + login + "\n\n" + items.map((e) => { const m = logMeta(e.action); return new Date(parse(e.at)).toLocaleString("ru-RU") + "  —  " + m.label + (e.target ? "  ·  " + e.target : ""); }).join("\n"); try { await invoke("sv_save_file", { filename: "Журнал.txt", contentB64: txtToB64(text) }); setFlash("Сохранено в «Загрузки»"); } catch (e) { setFlash("" + String(e)); } setTimeout(() => setFlash(""), 2800); };

  return (
    <>
      <div className="shead"><div style={{ flex: 1, minWidth: 160 }}><h1>Журнал действий</h1></div>
        {items.length > 0 && <div className="dsearch">{nic(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>)}<input value={jq} onChange={(e) => setJq(e.target.value)} placeholder="Поиск по журналу…" autoCapitalize="off" spellCheck={false} /></div>}
        {items.length > 0 && <button className="chip sm" onClick={doExport}>{nic(<><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></>)}Экспорт</button>}
      </div>
      {loading ? <BrandLoading />
        : items.length === 0 ? <div className="empty" style={{ padding: "40px 20px" }}>Пока нет записей. Действия появятся здесь автоматически.</div>
          : <>
            <div className="two-blocks" style={{ marginBottom: 14 }}>
              <div className="card glass shadow">
                <h3 style={{ display: "flex", alignItems: "center" }}><span className="rail5" />Активность за {range === "month" ? "месяц" : "неделю"}
                  <div className="seg" style={{ marginLeft: "auto" }}>
                    <button className={range === "week" ? "on" : ""} onClick={() => setRange("week")} style={{ fontSize: 11.5, padding: "5px 10px", fontWeight: 700 }}>Неделя</button>
                    <button className={range === "month" ? "on" : ""} onClick={() => setRange("month")} style={{ fontSize: 11.5, padding: "5px 10px", fontWeight: 700 }}>Месяц</button>
                  </div>
                </h3>
                <div className="week" style={{ "--wmax": range === "month" ? "100%" : "460px", "--wgap": range === "month" ? "5px" : "12px" } as React.CSSProperties}>{chart.map((d, i) => (<div key={i} className={"wd tipbtn" + (d.today ? " today" : "")} data-tip={new Date(d.d0).toLocaleDateString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit" }) + " · " + d.n} ><span className="wn">{d.n || ""}</span><div className="wtrack"><i className="wb" style={{ height: Math.max(4, Math.round((d.n / chartMax) * 100)) + "%" }} /></div><span className="wl">{d.showLabel ? d.label : ""}</span></div>))}</div>
              </div>
              <div className="card glass shadow">
                <h3><span className="rail5" />Сводка</h3>
                <div className="jsum">
                  <div className="s"><div className="n">{todayCount}</div><div className="k">сегодня</div></div>
                  <div className="s"><div className="n">{weekCount}</div><div className="k">за неделю</div></div>
                  <div className="s"><div className="n" style={{ color: "var(--good)", fontSize: 16 }}>{lastSubmit}</div><div className="k">посл. сдача</div></div>
                </div>
                <div className="jbrk">
                  {([["submit", "Сдано", "#10b981"], ["edit", "Изменения", "#6366f1"], ["comment", "Комментарии", "#8b5cf6"]] as const).map(([k, l, c]) => { const n = catCounts[k]; const pct = items.length ? Math.round((n / items.length) * 100) : 0; return (
                    <div className="row" key={k}>
                      <span className="lab"><span className="dot" style={{ background: c }} />{l}</span>
                      <span className="bar"><i style={{ width: pct + "%", background: c }} /></span>
                      <span className="cnt">{n}</span>
                    </div>
                  ); })}
                </div>
              </div>
            </div>
            <div className="filters">
              {([["all", "Все"], ["submit", "Сдано"], ["edit", "Изменения"], ["comment", "Комментарии"]] as const).map(([k, l]) => <button key={k} className={"fchip" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}
            </div>
            <div className="card glass shadow" style={{ padding: "2px 14px 12px" }}>
              {shown.length === 0 ? <div className="empty">{jq ? "Ничего не найдено" : "Нет записей в этой категории"}</div>
                : <>
                  <div className="tl">
                    {groups.map((grp) => (<Fragment key={grp.key}>
                      <div className="tlday">{grp.label}</div>
                      {grp.items.map((e, i) => { const m = logMeta(e.action); const clickable = !!(onOpenFile && e.rid); return (
                        <div className="tlitem" key={grp.key + i} onClick={clickable ? () => onOpenFile!(e.rid) : undefined} style={{ cursor: clickable ? "pointer" : "default" }}>
                          <span className="tldot" style={{ background: m.color }} />
                          <span className="tlic" style={{ background: `color-mix(in srgb, ${m.color} 16%, transparent)`, color: m.color }}>{nic(m.icon)}</span>
                          <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{m.label}</div><div className="sub">{relTime(e.at)}</div>{e.target && <span className="ctxchip">{e.target}</span>}</div>
                          {clickable && <span style={{ color: "var(--muted-2)", flexShrink: 0, alignSelf: "center" }}>{nic(<path d="m9 18 6-6-6-6" />)}</span>}
                        </div>
                      ); })}
                    </Fragment>))}
                  </div>
                  {shown.length > limit && <div style={{ textAlign: "center", marginTop: 12 }}><button className="chip sm" onClick={() => setLimit(limit + 40)}>Показать ещё ({shown.length - limit})</button></div>}
                </>}
            </div>
          </>}
      {flash && <div style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 1300, background: "var(--text)", color: "var(--surface)", padding: "10px 16px", borderRadius: 12, fontSize: 13, fontWeight: 600, boxShadow: "0 12px 34px rgba(10,12,28,.3)" }}>{flash}</div>}
    </>
  );
}
