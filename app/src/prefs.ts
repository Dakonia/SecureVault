import { invoke } from "@tauri-apps/api/core";

// Настройки пользователя: тема, акцент, вид Диска, избранное.
// Хранятся на сервере ЗАШИФРОВАННЫМИ ключом пользователя (переживают переустановку,
// синхронизируются между устройствами; сервер видит только непрозрачный blob).
// localStorage используется как мгновенный кэш до ответа сервера.
export type Prefs = { theme?: "light" | "dark"; accent?: string; view?: "cards" | "list"; fav?: string[]; order?: Record<string, string[]> };

const mem: Record<string, Prefs> = {};
const lkey = (login: string) => "sv-prefs-" + login;

export function prefsCached(login: string): Prefs {
  if (mem[login]) return mem[login];
  try { const j = localStorage.getItem(lkey(login)); if (j) { mem[login] = JSON.parse(j); return mem[login]; } } catch { /* */ }
  mem[login] = {};
  return mem[login];
}

export async function prefsLoad(login: string, pw: string): Promise<Prefs> {
  try {
    const s = await invoke<string>("sv_prefs_get", { login, password: pw });
    const obj: Prefs = s ? JSON.parse(s) : {};
    mem[login] = obj;
    try { localStorage.setItem(lkey(login), JSON.stringify(obj)); } catch { /* */ }
    return obj;
  } catch { return prefsCached(login); }
}

const timers: Record<string, ReturnType<typeof setTimeout>> = {};
export function prefsSet(login: string, pw: string, patch: Prefs) {
  const cur: Prefs = { ...prefsCached(login), ...patch };
  mem[login] = cur;
  try { localStorage.setItem(lkey(login), JSON.stringify(cur)); } catch { /* */ }
  if (timers[login]) clearTimeout(timers[login]);
  timers[login] = setTimeout(() => { invoke("sv_prefs_set", { login, password: pw, json: JSON.stringify(cur) }).catch(() => { /* */ }); }, 600);
}

export function isFav(login: string, id: string): boolean {
  return (prefsCached(login).fav || []).includes(id);
}

export function toggleFav(login: string, pw: string, id: string) {
  const cur = prefsCached(login).fav || [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  prefsSet(login, pw, { fav: next });
}
