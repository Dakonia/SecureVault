package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const maxBlob = 100 << 20
const vendorPubHex = "4fde975e6ad2c8328f7b8411d50e30c7a32a2641d97fc3953f044bcd71fef73c"
const laPubHex = "49a98a8a89ebd519d4a7d087a28bf67e417e9081cdb4895504c196765128bc9b"
const serverVersion = "0.1.0"

var (
	db      *sql.DB
	dataDir string
)

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

func revoked(serial *big.Int) bool {
	path := os.Getenv("TLS_REVOKED")
	if path == "" {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for _, line := range strings.Fields(string(data)) {
		line = strings.TrimPrefix(strings.TrimPrefix(line, "0x"), "0X")
		if v, ok := new(big.Int).SetString(line, 16); ok && v.Cmp(serial) == 0 {
			return true
		}
	}
	return false
}

func hasCert(r *http.Request) bool {
	return r.TLS != nil && len(r.TLS.PeerCertificates) > 0
}

// --- Лицензии: сервер проверяет подпись вендора и гасит код при регистрации ---

func verifyLicense(code string) (org string, id string, ok bool) {
	parts := strings.SplitN(strings.TrimSpace(code), ".", 2)
	if len(parts) != 2 {
		return
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return
	}
	pub, err := hex.DecodeString(vendorPubHex)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
		return
	}
	var p struct {
		Org  string `json:"org"`
		Kind string `json:"kind"`
		Exp  int64  `json:"exp"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return
	}
	if p.Exp != 0 && time.Now().Unix() > p.Exp {
		return
	}
	return p.Org, p.ID, true
}

// проверка токена активации, выданного сервером лицензий (LA): подпись LA + совпадение id лицензии
func verifyActivation(token, licID string) bool {
	parts := strings.SplitN(strings.TrimSpace(token), ".", 2)
	if len(parts) != 2 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	pub, err := hex.DecodeString(laPubHex)
	if err != nil || !ed25519.Verify(ed25519.PublicKey(pub), payload, sig) {
		return false
	}
	var p struct {
		LID string `json:"lid"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return false
	}
	return p.LID == licID
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	http.Error(w, msg, code)
}
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func main() {
	dataDir = os.Getenv("SECUREVAULT_DATA")
	if dataDir == "" {
		dataDir = "/data"
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("SECUREVAULT_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8088"
	}

	var err error
	db, err = sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(5)
	if err = db.Ping(); err != nil {
		log.Fatal(err)
	}
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS records(
			id text PRIMARY KEY, space text NOT NULL, doc_type text, submitter text,
			filename text, size bigint, created_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS accounts(
			login text PRIMARY KEY, org text NOT NULL,
			salt bytea NOT NULL, auth_hash bytea NOT NULL, enc_vault bytea NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'master'`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS revoked boolean NOT NULL DEFAULT false`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner_login text`,
		`CREATE TABLE IF NOT EXISTS audit(
			seq bigserial PRIMARY KEY, owner_login text NOT NULL, action text NOT NULL,
			target text, org text, at timestamptz NOT NULL DEFAULT now(),
			prev_hash bytea, hash bytea NOT NULL)`,
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS owner_login text`,
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS org text`,
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS folder text NOT NULL DEFAULT ''`,
		`CREATE TABLE IF NOT EXISTS folders(org text NOT NULL, path text NOT NULL, PRIMARY KEY(org, path))`,
		`CREATE TABLE IF NOT EXISTS used_licenses(
			id text PRIMARY KEY, org text, used_at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pub_key text`,
		`CREATE TABLE IF NOT EXISTS comments(
			id text PRIMARY KEY, record_id text NOT NULL, author text NOT NULL,
			org text, blob bytea NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS perms text`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS see_all boolean NOT NULL DEFAULT false`,
		`UPDATE accounts SET see_all=true WHERE role='reviewer' AND see_all=false`,
		`CREATE TABLE IF NOT EXISTS user_log(seq bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text, at timestamptz NOT NULL DEFAULT now())`,
	} {
		if _, err = db.Exec(q); err != nil {
			log.Fatal(err)
		}
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"service": "securevault", "version": serverVersion, "ok": true})
	})

	// --- Плоскость авторизации (без клиентского сертификата) ---

	mux.HandleFunc("/auth/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			License  string `json:"license"`
			ActToken string `json:"activation_token"`
			Org      string `json:"org"`
			Login    string `json:"login"`
			Salt     string `json:"salt"`
			AuthTok  string `json:"auth_token"`
			EncVault string `json:"enc_vault"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Login == "" {
			writeErr(w, 400, "bad request")
			return
		}
		_, licID, ok := verifyLicense(req.License)
		if !ok {
			writeErr(w, 400, "Лицензия недействительна")
			return
		}
		if !verifyActivation(req.ActToken, licID) {
			writeErr(w, 400, "Нет действительного подтверждения активации")
			return
		}
		org := strings.TrimSpace(req.Org)
		if org == "" {
			writeErr(w, 400, "Не указана организация")
			return
		}
		salt, e1 := base64.StdEncoding.DecodeString(req.Salt)
		tok, e2 := base64.StdEncoding.DecodeString(req.AuthTok)
		vault, e3 := base64.StdEncoding.DecodeString(req.EncVault)
		if e1 != nil || e2 != nil || e3 != nil {
			writeErr(w, 400, "bad encoding")
			return
		}
		h := sha256.Sum256(tok)

		tx, err := db.Begin()
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer tx.Rollback()
		var dummy string
		if tx.QueryRow(`SELECT id FROM used_licenses WHERE id=$1`, licID).Scan(&dummy) == nil {
			writeErr(w, 409, "Лицензия уже использована")
			return
		}
		if tx.QueryRow(`SELECT login FROM accounts WHERE login=$1`, req.Login).Scan(&dummy) == nil {
			writeErr(w, 409, "Логин уже занят")
			return
		}
		if _, err = tx.Exec(`INSERT INTO accounts(login,org,salt,auth_hash,enc_vault) VALUES($1,$2,$3,$4,$5)`,
			req.Login, org, salt, h[:], vault); err != nil {
			writeErr(w, 500, "db")
			return
		}
		if _, err = tx.Exec(`INSERT INTO used_licenses(id,org) VALUES($1,$2)`, licID, org); err != nil {
			writeErr(w, 500, "db")
			return
		}
		if tx.Commit() != nil {
			writeErr(w, 500, "db")
			return
		}
		writeJSON(w, map[string]string{"org": org})
	})

	mux.HandleFunc("/auth/license", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			License string `json:"license"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, licID, ok := verifyLicense(req.License)
		if !ok {
			writeJSON(w, map[string]any{"valid": false, "used": false})
			return
		}
		var dummy string
		used := db.QueryRow(`SELECT id FROM used_licenses WHERE id=$1`, licID).Scan(&dummy) == nil
		writeJSON(w, map[string]any{"valid": true, "used": used, "org": org})
	})

	mux.HandleFunc("/auth/salt", func(w http.ResponseWriter, r *http.Request) {
		login := r.URL.Query().Get("login")
		var salt []byte
		var org string
		if db.QueryRow(`SELECT salt,org FROM accounts WHERE login=$1 AND NOT revoked`, login).Scan(&salt, &org) != nil {
			writeErr(w, 404, "Аккаунт не найден")
			return
		}
		writeJSON(w, map[string]string{"salt": base64.StdEncoding.EncodeToString(salt), "org": org})
	})

	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		tok, err := base64.StdEncoding.DecodeString(req.AuthTok)
		if err != nil {
			writeErr(w, 400, "bad encoding")
			return
		}
		var authHash, vault []byte
		var org string
		if db.QueryRow(`SELECT auth_hash,enc_vault,org FROM accounts WHERE login=$1 AND NOT revoked`, req.Login).Scan(&authHash, &vault, &org) != nil {
			writeErr(w, 401, "Неверный логин или пароль")
			return
		}
		h := sha256.Sum256(tok)
		if subtle.ConstantTimeCompare(h[:], authHash) != 1 {
			writeErr(w, 401, "Неверный логин или пароль")
			return
		}
		writeJSON(w, map[string]string{"org": org, "enc_vault": base64.StdEncoding.EncodeToString(vault)})
	})

	// аутентификация мастера по его auth_token; возвращает его организацию
	authMaster := func(login, authTokB64 string) (string, bool) {
		tok, err := base64.StdEncoding.DecodeString(authTokB64)
		if err != nil {
			return "", false
		}
		var authHash []byte
		var role, org string
		if db.QueryRow(`SELECT auth_hash, role, org FROM accounts WHERE login=$1 AND NOT revoked`, login).Scan(&authHash, &role, &org) != nil {
			return "", false
		}
		h := sha256.Sum256(tok)
		if subtle.ConstantTimeCompare(h[:], authHash) != 1 || role != "master" {
			return "", false
		}
		return org, true
	}

	// append-only журнал с хеш-цепочкой (на владельца)
	addAudit := func(owner, action, target, org string) {
		var prev []byte
		db.QueryRow(`SELECT hash FROM audit WHERE owner_login=$1 ORDER BY seq DESC LIMIT 1`, owner).Scan(&prev)
		at := time.Now().UTC().Truncate(time.Microsecond)
		hh := sha256.New()
		hh.Write(prev)
		hh.Write([]byte(action + "\x00" + target + "\x00" + org + "\x00" + at.Format(time.RFC3339Nano)))
		sum := hh.Sum(nil)
		db.Exec(`INSERT INTO audit(owner_login,action,target,org,at,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7)`, owner, action, target, org, at, prev, sum)
	}

	addUserLog := func(actor, action, target string) {
		db.Exec(`INSERT INTO user_log(actor,action,target) VALUES($1,$2,$3)`, actor, action, target)
	}

	// мастер создаёт профиль сотрудника (без новой лицензии, под своей организацией)
	mux.HandleFunc("/auth/create_account", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string   `json:"master_login"`
			MasterTok   string   `json:"master_auth_token"`
			Org         string   `json:"org"`
			Login       string   `json:"login"`
			Role        string   `json:"role"`
			Salt        string   `json:"salt"`
			AuthTok     string   `json:"auth_token"`
			EncVault    string   `json:"enc_vault"`
			PubKey      string   `json:"pub_key"`
			Perms       []string `json:"perms"`
			SeeAll      bool     `json:"see_all"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Login == "" {
			writeErr(w, 400, "bad request")
			return
		}
		masterOrg, ok := authMaster(req.MasterLogin, req.MasterTok)
		if !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		if req.Role == "" || req.Role == "master" {
			writeErr(w, 400, "Недопустимая роль")
			return
		}
		org := strings.TrimSpace(req.Org)
		if org == "" {
			org = masterOrg
		}
		salt, e1 := base64.StdEncoding.DecodeString(req.Salt)
		tok, e2 := base64.StdEncoding.DecodeString(req.AuthTok)
		vault, e3 := base64.StdEncoding.DecodeString(req.EncVault)
		if e1 != nil || e2 != nil || e3 != nil {
			writeErr(w, 400, "bad encoding")
			return
		}
		h := sha256.Sum256(tok)
		var dummy string
		if db.QueryRow(`SELECT login FROM accounts WHERE login=$1`, req.Login).Scan(&dummy) == nil {
			writeErr(w, 409, "Логин уже занят")
			return
		}
		permsJSON, _ := json.Marshal(req.Perms)
		if _, err := db.Exec(`INSERT INTO accounts(login,org,salt,auth_hash,enc_vault,role,owner_login,pub_key,perms,see_all) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			req.Login, org, salt, h[:], vault, req.Role, req.MasterLogin, req.PubKey, string(permsJSON), req.SeeAll); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addAudit(req.MasterLogin, "profile_created", req.Login, org)
		writeJSON(w, map[string]string{"login": req.Login, "role": req.Role})
	})

	// список профилей организации (кроме мастера)
	mux.HandleFunc("/auth/accounts", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		_, ok := authMaster(req.MasterLogin, req.MasterTok)
		if !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		rows, err := db.Query(`SELECT login, role, org, created_at, revoked FROM accounts WHERE owner_login=$1 ORDER BY created_at`, req.MasterLogin)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type acc struct {
			Login   string    `json:"login"`
			Role    string    `json:"role"`
			Org     string    `json:"org"`
			Created time.Time `json:"created_at"`
			Revoked bool      `json:"revoked"`
		}
		out := []acc{}
		for rows.Next() {
			var a acc
			if rows.Scan(&a.Login, &a.Role, &a.Org, &a.Created, &a.Revoked) == nil {
				out = append(out, a)
			}
		}
		writeJSON(w, out)
	})

	// мастер сбрасывает пароль профиля (перевыдаёт ячейку с новым паролем)
	mux.HandleFunc("/auth/reset_account", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string   `json:"master_login"`
			MasterTok   string   `json:"master_auth_token"`
			Login       string   `json:"login"`
			Salt        string   `json:"salt"`
			AuthTok     string   `json:"auth_token"`
			EncVault    string   `json:"enc_vault"`
			PubKey      string   `json:"pub_key"`
			Perms       []string `json:"perms"`
			SeeAll      bool     `json:"see_all"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		var owner string
		if db.QueryRow(`SELECT owner_login FROM accounts WHERE login=$1`, req.Login).Scan(&owner) != nil || owner != req.MasterLogin {
			writeErr(w, 403, "Профиль не принадлежит вам")
			return
		}
		salt, e1 := base64.StdEncoding.DecodeString(req.Salt)
		tok, e2 := base64.StdEncoding.DecodeString(req.AuthTok)
		vault, e3 := base64.StdEncoding.DecodeString(req.EncVault)
		if e1 != nil || e2 != nil || e3 != nil {
			writeErr(w, 400, "bad encoding")
			return
		}
		h := sha256.Sum256(tok)
		permsJSON, _ := json.Marshal(req.Perms)
		if _, err := db.Exec(`UPDATE accounts SET salt=$1, auth_hash=$2, enc_vault=$3, pub_key=$4, perms=$5, see_all=$6, updated_at=now() WHERE login=$7`, salt, h[:], vault, req.PubKey, string(permsJSON), req.SeeAll, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addAudit(req.MasterLogin, "password_reset", req.Login, "")
		io.WriteString(w, "ok")
	})

	// мастер отзывает/восстанавливает профиль
	mux.HandleFunc("/auth/revoke", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Login       string `json:"login"`
			Revoked     bool   `json:"revoked"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		var owner string
		if db.QueryRow(`SELECT owner_login FROM accounts WHERE login=$1`, req.Login).Scan(&owner) != nil || owner != req.MasterLogin {
			writeErr(w, 403, "Профиль не принадлежит вам")
			return
		}
		if _, err := db.Exec(`UPDATE accounts SET revoked=$1 WHERE login=$2`, req.Revoked, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		act := "restored"
		if req.Revoked {
			act = "revoked"
		}
		addAudit(req.MasterLogin, act, req.Login, "")
		io.WriteString(w, "ok")
	})

	// журнал действий мастера (append-only, с проверкой хеш-цепочки)
	mux.HandleFunc("/auth/log", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		rows, err := db.Query(`SELECT action,target,org,at,prev_hash,hash FROM audit WHERE owner_login=$1 ORDER BY seq`, req.MasterLogin)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type ent struct {
			Action string    `json:"action"`
			Target string    `json:"target"`
			Org    string    `json:"org"`
			At     time.Time `json:"at"`
		}
		out := []ent{}
		var prevExpected []byte
		chainOK := true
		for rows.Next() {
			var e ent
			var prev, hsh []byte
			if rows.Scan(&e.Action, &e.Target, &e.Org, &e.At, &prev, &hsh) != nil {
				continue
			}
			hh := sha256.New()
			hh.Write(prev)
			hh.Write([]byte(e.Action + "\x00" + e.Target + "\x00" + e.Org + "\x00" + e.At.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)))
			if subtle.ConstantTimeCompare(hh.Sum(nil), hsh) != 1 || (prevExpected != nil && subtle.ConstantTimeCompare(prev, prevExpected) != 1) {
				chainOK = false
			}
			prevExpected = hsh
			out = append(out, e)
		}
		// новые сверху
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
		writeJSON(w, map[string]any{"entries": out, "chain_ok": chainOK})
	})

	// переименование организации (во всех профилях мастера)
	mux.HandleFunc("/auth/rename_org", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Old         string `json:"old"`
			New         string `json:"new"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		oldv := strings.TrimSpace(req.Old)
		newv := strings.TrimSpace(req.New)
		if newv == "" {
			writeErr(w, 400, "Пустое название")
			return
		}
		if _, err := db.Exec(`UPDATE accounts SET org=$1 WHERE org=$2 AND (owner_login=$3 OR login=$3)`, newv, oldv, req.MasterLogin); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addAudit(req.MasterLogin, "org_renamed", oldv+" -> "+newv, newv)
		io.WriteString(w, "ok")
	})

	// аутентификация любого аккаунта (не только мастера) по auth_token
	authAccount := func(login, authTokB64 string) (string, string, bool) {
		tok, err := base64.StdEncoding.DecodeString(authTokB64)
		if err != nil {
			return "", "", false
		}
		var authHash []byte
		var role, org string
		if db.QueryRow(`SELECT auth_hash, role, org FROM accounts WHERE login=$1 AND NOT revoked`, login).Scan(&authHash, &role, &org) != nil {
			return "", "", false
		}
		h := sha256.Sum256(tok)
		if subtle.ConstantTimeCompare(h[:], authHash) != 1 {
			return "", "", false
		}
		return org, role, true
	}

	// сдать отчёт/файл (зашифрованный blob), вход по аккаунту
	mux.HandleFunc("/data/submit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBlob)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			writeErr(w, 400, "form")
			return
		}
		login := r.FormValue("login")
		org, _, ok := authAccount(login, r.FormValue("auth_token"))
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		title := r.FormValue("title")
		kind := r.FormValue("kind")
		folder := r.FormValue("folder")
		file, _, err := r.FormFile("file")
		if err != nil {
			writeErr(w, 400, "file required")
			return
		}
		defer file.Close()
		id := newID()
		f, err := os.OpenFile(filepath.Join(dataDir, id), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			writeErr(w, 500, "store")
			return
		}
		n, err := io.Copy(f, file)
		f.Close()
		if err != nil {
			writeErr(w, 500, "write")
			return
		}
		if _, err = db.Exec(`INSERT INTO records(id,space,doc_type,submitter,filename,size,owner_login,org,folder) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			id, org, kind, login, title, n, login, org, folder); err != nil {
			writeErr(w, 500, "db")
			return
		}
		var owner sql.NullString
		db.QueryRow(`SELECT owner_login FROM accounts WHERE login=$1`, login).Scan(&owner)
		if owner.Valid && owner.String != "" {
			addAudit(owner.String, "report_submitted", title, org)
		}
		addUserLog(login, "submit", title)
		writeJSON(w, map[string]string{"id": id})
	})

	// список своих отчётов
	mux.HandleFunc("/data/list", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.Query(`SELECT r.id, r.doc_type, r.filename, r.size, r.folder, r.created_at, COALESCE(cc.n,0) FROM records r LEFT JOIN (SELECT record_id, count(*) n FROM comments GROUP BY record_id) cc ON cc.record_id=r.id WHERE r.owner_login=$1 ORDER BY r.created_at DESC`, req.Login)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type rec struct {
			ID       string    `json:"id"`
			Kind     string    `json:"kind"`
			Name     string    `json:"name"`
			Size     int64     `json:"size"`
			Folder   string    `json:"folder"`
			Comments int       `json:"comments"`
			At       time.Time `json:"at"`
		}
		out := []rec{}
		for rows.Next() {
			var x rec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.At, &x.Comments) == nil {
				out = append(out, x)
			}
		}
		writeJSON(w, out)
	})

	// скачать свой зашифрованный blob
	mux.HandleFunc("/data/blob", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		var owner string
		if db.QueryRow(`SELECT owner_login FROM records WHERE id=$1`, req.ID).Scan(&owner) != nil || owner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		if req.ID == "" || strings.ContainsAny(req.ID, "/.") {
			writeErr(w, 400, "bad id")
			return
		}
		f, err := os.Open(filepath.Join(dataDir, req.ID))
		if err != nil {
			writeErr(w, 404, "not found")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		io.Copy(w, f)
	})

	// удалить свой отчёт
	mux.HandleFunc("/data/delete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		var owner string
		if db.QueryRow(`SELECT owner_login FROM records WHERE id=$1`, req.ID).Scan(&owner) != nil || owner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		if strings.ContainsAny(req.ID, "/.") {
			writeErr(w, 400, "bad id")
			return
		}
		var delName string
		db.QueryRow(`SELECT filename FROM records WHERE id=$1`, req.ID).Scan(&delName)
		db.Exec(`DELETE FROM records WHERE id=$1`, req.ID)
		os.Remove(filepath.Join(dataDir, req.ID))
		addUserLog(req.Login, "delete", delName)
		io.WriteString(w, "ok")
	})

	// список папок организации
	mux.HandleFunc("/data/folders", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Org     string `json:"org"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, role, ok := authAccount(req.Login, req.AuthTok)
		if req.Org != "" && role == "master" {
			org = req.Org
		}
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.Query(`SELECT path FROM folders WHERE org=$1 ORDER BY path`, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		out := []string{}
		for rows.Next() {
			var p string
			if rows.Scan(&p) == nil {
				out = append(out, p)
			}
		}
		writeJSON(w, out)
	})

	// создать папку (в рамках организации)
	mux.HandleFunc("/data/mkfolder", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Org     string `json:"org"`
			Path    string `json:"path"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, role, ok := authAccount(req.Login, req.AuthTok)
		if req.Org != "" && role == "master" {
			org = req.Org
		}
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		path := strings.Trim(strings.TrimSpace(req.Path), "/")
		if path == "" {
			writeErr(w, 400, "Пустой путь")
			return
		}
		if _, err := db.Exec(`INSERT INTO folders(org,path) VALUES($1,$2) ON CONFLICT DO NOTHING`, org, path); err != nil {
			writeErr(w, 500, "db")
			return
		}
		io.WriteString(w, "ok")
	})

	// публичные ключи получателей шифрования: владелец записи + все проверяющие организации
	mux.HandleFunc("/data/recipients", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Owner   string `json:"owner_login"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, _, ok := authAccount(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		owner := strings.TrimSpace(req.Owner)
		if owner == "" {
			owner = req.Login
		}
		seen := map[string]bool{}
		out := []string{}
		add := func(p string) {
			p = strings.TrimSpace(p)
			if p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
		var ownerPub sql.NullString
		db.QueryRow(`SELECT pub_key FROM accounts WHERE login=$1 AND org=$2`, owner, org).Scan(&ownerPub)
		if ownerPub.Valid {
			add(ownerPub.String)
		}
		rows, err := db.Query(`SELECT pub_key FROM accounts WHERE org=$1 AND see_all AND NOT revoked`, org)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var p sql.NullString
				if rows.Scan(&p) == nil && p.Valid {
					add(p.String)
				}
			}
		}
		writeJSON(w, out)
	})

	// доступ проверяющего: только роль reviewer; возвращает его организацию
	authReviewer := func(login, tok string) (string, bool) {
		org, _, ok := authAccount(login, tok)
		if !ok {
			return "", false
		}
		var seeAll bool
		if db.QueryRow(`SELECT COALESCE(see_all,false) FROM accounts WHERE login=$1`, login).Scan(&seeAll) != nil || !seeAll {
			return "", false
		}
		return org, true
	}

	// проверяющий: список директоров организации со сводкой (кол-во и последняя сдача)
	mux.HandleFunc("/data/reviewer/profiles", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, ok := authReviewer(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.Query(`SELECT a.login, a.created_at, a.revoked, COALESCE(c.cnt,0), c.last_at
			FROM accounts a
			LEFT JOIN (SELECT owner_login, count(*) cnt, max(created_at) last_at FROM records GROUP BY owner_login) c ON c.owner_login=a.login
			WHERE a.org=$1 AND a.role='director' ORDER BY a.created_at`, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type prof struct {
			Login   string     `json:"login"`
			Created time.Time  `json:"created_at"`
			Revoked bool       `json:"revoked"`
			Count   int        `json:"count"`
			LastAt  *time.Time `json:"last_at"`
		}
		out := []prof{}
		for rows.Next() {
			var p prof
			var last sql.NullTime
			if rows.Scan(&p.Login, &p.Created, &p.Revoked, &p.Count, &last) == nil {
				if last.Valid {
					t := last.Time
					p.LastAt = &t
				}
				out = append(out, p)
			}
		}
		writeJSON(w, out)
	})

	// проверяющий: записи конкретного директора своей организации
	mux.HandleFunc("/data/reviewer/list", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Owner   string `json:"owner_login"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, ok := authReviewer(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		var downer string
		if db.QueryRow(`SELECT org FROM accounts WHERE login=$1`, req.Owner).Scan(&downer) != nil || downer != org {
			writeErr(w, 403, "другая организация")
			return
		}
		rows, err := db.Query(`SELECT r.id, r.doc_type, r.filename, r.size, r.folder, r.submitter, r.created_at, COALESCE(cc.n,0) FROM records r LEFT JOIN (SELECT record_id, count(*) n FROM comments GROUP BY record_id) cc ON cc.record_id=r.id WHERE r.owner_login=$1 AND r.org=$2 ORDER BY r.created_at DESC`, req.Owner, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type rec struct {
			ID        string    `json:"id"`
			Kind      string    `json:"kind"`
			Name      string    `json:"name"`
			Size      int64     `json:"size"`
			Folder    string    `json:"folder"`
			Submitter string    `json:"submitter"`
			Comments  int       `json:"comments"`
			At        time.Time `json:"at"`
		}
		out := []rec{}
		for rows.Next() {
			var x rec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.Submitter, &x.At, &x.Comments) == nil {
				out = append(out, x)
			}
		}
		writeJSON(w, out)
	})

	// проверяющий: лента последних записей по всей организации
	mux.HandleFunc("/data/reviewer/recent", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, ok := authReviewer(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.Query(`SELECT id, doc_type, filename, size, folder, owner_login, submitter, created_at FROM records WHERE org=$1 ORDER BY created_at DESC LIMIT 40`, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type rec struct {
			ID        string    `json:"id"`
			Kind      string    `json:"kind"`
			Name      string    `json:"name"`
			Size      int64     `json:"size"`
			Folder    string    `json:"folder"`
			Owner     string    `json:"owner_login"`
			Submitter string    `json:"submitter"`
			At        time.Time `json:"at"`
		}
		out := []rec{}
		for rows.Next() {
			var x rec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.Owner, &x.Submitter, &x.At) == nil {
				out = append(out, x)
			}
		}
		writeJSON(w, out)
	})

	// проверяющий: скачать blob любой записи своей организации
	mux.HandleFunc("/data/reviewer/blob", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, ok := authReviewer(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		if req.ID == "" || strings.ContainsAny(req.ID, "/.") {
			writeErr(w, 400, "bad id")
			return
		}
		var rorg string
		if db.QueryRow(`SELECT org FROM records WHERE id=$1`, req.ID).Scan(&rorg) != nil || rorg != org {
			writeErr(w, 404, "not found")
			return
		}
		f, err := os.Open(filepath.Join(dataDir, req.ID))
		if err != nil {
			writeErr(w, 404, "not found")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		io.Copy(w, f)
	})

	// проверяющий: добавить файл в пространство директора
	mux.HandleFunc("/data/reviewer/submit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBlob)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			writeErr(w, 400, "form")
			return
		}
		login := r.FormValue("login")
		org, ok := authReviewer(login, r.FormValue("auth_token"))
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		owner := r.FormValue("owner_login")
		var downer string
		if db.QueryRow(`SELECT org FROM accounts WHERE login=$1`, owner).Scan(&downer) != nil || downer != org {
			writeErr(w, 403, "другая организация")
			return
		}
		title := r.FormValue("title")
		kind := r.FormValue("kind")
		folder := r.FormValue("folder")
		file, _, err := r.FormFile("file")
		if err != nil {
			writeErr(w, 400, "file required")
			return
		}
		defer file.Close()
		id := newID()
		f, err := os.OpenFile(filepath.Join(dataDir, id), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			writeErr(w, 500, "store")
			return
		}
		n, err := io.Copy(f, file)
		f.Close()
		if err != nil {
			writeErr(w, 500, "write")
			return
		}
		if _, err = db.Exec(`INSERT INTO records(id,space,doc_type,submitter,filename,size,owner_login,org,folder) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			id, org, kind, login, title, n, owner, org, folder); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addUserLog(login, "add", title+" -> "+owner)
		writeJSON(w, map[string]string{"id": id})
	})

	// проверяющий: удалить запись своей организации
	mux.HandleFunc("/data/reviewer/delete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, ok := authReviewer(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		if strings.ContainsAny(req.ID, "/.") {
			writeErr(w, 400, "bad id")
			return
		}
		var rorg string
		if db.QueryRow(`SELECT org FROM records WHERE id=$1`, req.ID).Scan(&rorg) != nil || rorg != org {
			writeErr(w, 404, "not found")
			return
		}
		var rvDelName string
		db.QueryRow(`SELECT filename FROM records WHERE id=$1`, req.ID).Scan(&rvDelName)
		db.Exec(`DELETE FROM records WHERE id=$1`, req.ID)
		db.Exec(`DELETE FROM comments WHERE record_id=$1`, req.ID)
		os.Remove(filepath.Join(dataDir, req.ID))
		addUserLog(req.Login, "delete", rvDelName)
		io.WriteString(w, "ok")
	})

	mux.HandleFunc("/data/mylog", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.Query(`SELECT action, target, at FROM user_log WHERE actor=$1 ORDER BY seq DESC LIMIT 200`, req.Login)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type ent struct {
			Action string    `json:"action"`
			Target string    `json:"target"`
			At     time.Time `json:"at"`
		}
		out := []ent{}
		for rows.Next() {
			var e ent
			if rows.Scan(&e.Action, &e.Target, &e.At) == nil {
				out = append(out, e)
			}
		}
		writeJSON(w, out)
	})

	// доступ к комментариям записи: любой аккаунт той же организации
	commentAllowed := func(login, tok, recordID string) (string, string, bool) {
		org, _, ok := authAccount(login, tok)
		if !ok {
			return "", "", false
		}
		var rorg, rowner string
		if db.QueryRow(`SELECT org, owner_login FROM records WHERE id=$1`, recordID).Scan(&rorg, &rowner) != nil {
			return "", "", false
		}
		if rorg != org {
			return "", "", false
		}
		return org, rowner, true
	}

	// список комментариев записи (blob зашифрован клиентом)
	mux.HandleFunc("/data/comments", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login    string `json:"login"`
			AuthTok  string `json:"auth_token"`
			RecordID string `json:"record_id"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := commentAllowed(req.Login, req.AuthTok, req.RecordID); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		rows, err := db.Query(`SELECT id, author, blob, at FROM comments WHERE record_id=$1 ORDER BY at`, req.RecordID)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type cm struct {
			ID     string    `json:"id"`
			Author string    `json:"author"`
			Blob   string    `json:"blob"`
			At     time.Time `json:"at"`
		}
		out := []cm{}
		for rows.Next() {
			var c cm
			var blob []byte
			if rows.Scan(&c.ID, &c.Author, &blob, &c.At) == nil {
				c.Blob = base64.StdEncoding.EncodeToString(blob)
				out = append(out, c)
			}
		}
		writeJSON(w, out)
	})

	// добавить комментарий (blob — зашифрованный на получателей текст)
	mux.HandleFunc("/data/comment_add", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login    string `json:"login"`
			AuthTok  string `json:"auth_token"`
			RecordID string `json:"record_id"`
			Blob     string `json:"blob"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, _, ok := commentAllowed(req.Login, req.AuthTok, req.RecordID)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		blob, err := base64.StdEncoding.DecodeString(req.Blob)
		if err != nil || len(blob) == 0 {
			writeErr(w, 400, "bad blob")
			return
		}
		if _, err := db.Exec(`INSERT INTO comments(id,record_id,author,org,blob) VALUES($1,$2,$3,$4,$5)`,
			newID(), req.RecordID, req.Login, org, blob); err != nil {
			writeErr(w, 500, "db")
			return
		}
		var cmName string
		db.QueryRow(`SELECT filename FROM records WHERE id=$1`, req.RecordID).Scan(&cmName)
		addUserLog(req.Login, "comment", cmName)
		io.WriteString(w, "ok")
	})

	// смена пароля (мастера или сотрудника): меняется соль, auth_hash и ячейка
	mux.HandleFunc("/auth/change_password", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login      string `json:"login"`
			OldAuthTok string `json:"old_auth_token"`
			NewSalt    string `json:"new_salt"`
			NewAuthTok string `json:"new_auth_token"`
			EncVault   string `json:"enc_vault"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		oldTok, e0 := base64.StdEncoding.DecodeString(req.OldAuthTok)
		salt, e1 := base64.StdEncoding.DecodeString(req.NewSalt)
		newTok, e2 := base64.StdEncoding.DecodeString(req.NewAuthTok)
		vault, e3 := base64.StdEncoding.DecodeString(req.EncVault)
		if e0 != nil || e1 != nil || e2 != nil || e3 != nil {
			writeErr(w, 400, "bad encoding")
			return
		}
		var authHash []byte
		if db.QueryRow(`SELECT auth_hash FROM accounts WHERE login=$1 AND NOT revoked`, req.Login).Scan(&authHash) != nil {
			writeErr(w, 401, "Неверный логин или пароль")
			return
		}
		ho := sha256.Sum256(oldTok)
		if subtle.ConstantTimeCompare(ho[:], authHash) != 1 {
			writeErr(w, 401, "Неверный текущий пароль")
			return
		}
		hn := sha256.Sum256(newTok)
		if _, err := db.Exec(`UPDATE accounts SET salt=$1, auth_hash=$2, enc_vault=$3, updated_at=now() WHERE login=$4`,
			salt, hn[:], vault, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		io.WriteString(w, "ok")
	})

	mux.HandleFunc("/auth/vault", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login    string `json:"login"`
			AuthTok  string `json:"auth_token"`
			EncVault string `json:"enc_vault"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		tok, e1 := base64.StdEncoding.DecodeString(req.AuthTok)
		vault, e2 := base64.StdEncoding.DecodeString(req.EncVault)
		if e1 != nil || e2 != nil {
			writeErr(w, 400, "bad encoding")
			return
		}
		var authHash []byte
		if db.QueryRow(`SELECT auth_hash FROM accounts WHERE login=$1`, req.Login).Scan(&authHash) != nil {
			writeErr(w, 401, "unauthorized")
			return
		}
		h := sha256.Sum256(tok)
		if subtle.ConstantTimeCompare(h[:], authHash) != 1 {
			writeErr(w, 401, "unauthorized")
			return
		}
		if _, err := db.Exec(`UPDATE accounts SET enc_vault=$1, updated_at=now() WHERE login=$2`, vault, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		io.WriteString(w, "ok")
	})

	// --- Плоскость данных (требует клиентский сертификат компании) ---

	mux.HandleFunc("/records", func(w http.ResponseWriter, r *http.Request) {
		if !hasCert(r) {
			writeErr(w, 401, "unauthorized")
			return
		}
		switch r.Method {
		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, maxBlob)
			if err := r.ParseMultipartForm(8 << 20); err != nil {
				writeErr(w, 400, "form")
				return
			}
			space := r.FormValue("space")
			if space == "" {
				writeErr(w, 400, "space required")
				return
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				writeErr(w, 400, "file required")
				return
			}
			defer file.Close()
			id := newID()
			f, err := os.OpenFile(filepath.Join(dataDir, id), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
			if err != nil {
				writeErr(w, 500, "store")
				return
			}
			n, err := io.Copy(f, file)
			f.Close()
			if err != nil {
				writeErr(w, 500, "write")
				return
			}
			if _, err = db.Exec(`INSERT INTO records(id,space,doc_type,submitter,filename,size) VALUES($1,$2,$3,$4,$5,$6)`,
				id, space, r.FormValue("type"), r.FormValue("by"), r.FormValue("name"), n); err != nil {
				writeErr(w, 500, "db")
				return
			}
			writeJSON(w, map[string]string{"id": id})
		case http.MethodGet:
			space := r.URL.Query().Get("space")
			if space == "" {
				writeErr(w, 400, "space required")
				return
			}
			rows, err := db.Query(`SELECT id,doc_type,submitter,filename,size,created_at FROM records WHERE space=$1 ORDER BY created_at DESC`, space)
			if err != nil {
				writeErr(w, 500, "db")
				return
			}
			defer rows.Close()
			type rec struct {
				ID   string    `json:"id"`
				Type string    `json:"type"`
				By   string    `json:"by"`
				Name string    `json:"name"`
				Size int64     `json:"size"`
				At   time.Time `json:"at"`
			}
			out := []rec{}
			for rows.Next() {
				var x rec
				if rows.Scan(&x.ID, &x.Type, &x.By, &x.Name, &x.Size, &x.At) == nil {
					out = append(out, x)
				}
			}
			writeJSON(w, out)
		default:
			writeErr(w, 405, "method")
		}
	})

	mux.HandleFunc("/blobs/", func(w http.ResponseWriter, r *http.Request) {
		if !hasCert(r) {
			writeErr(w, 401, "unauthorized")
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/blobs/")
		if id == "" || strings.ContainsAny(id, "/.") {
			writeErr(w, 400, "bad id")
			return
		}
		f, err := os.Open(filepath.Join(dataDir, id))
		if err != nil {
			writeErr(w, 404, "not found")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		io.Copy(w, f)
	})

	certFile := os.Getenv("TLS_CERT")
	if certFile != "" {
		caPEM, err := os.ReadFile(os.Getenv("TLS_CLIENT_CA"))
		if err != nil {
			log.Fatal(err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			log.Fatal("bad client CA")
		}
		srv := &http.Server{
			Addr:    addr,
			Handler: mux,
			TLSConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
				ClientCAs:  pool,
				ClientAuth: tls.VerifyClientCertIfGiven,
				VerifyPeerCertificate: func(_ [][]byte, chains [][]*x509.Certificate) error {
					if len(chains) > 0 && len(chains[0]) > 0 && revoked(chains[0][0].SerialNumber) {
						return fmt.Errorf("client certificate revoked")
					}
					return nil
				},
			},
		}
		log.Printf("securevault (mTLS data + auth plane) on %s", addr)
		log.Fatal(srv.ListenAndServeTLS(certFile, os.Getenv("TLS_KEY")))
	}

	log.Printf("securevault (plain) on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
