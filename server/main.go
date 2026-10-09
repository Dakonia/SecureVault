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
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
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

func isImageFile(name string) bool {
	l := strings.ToLower(name)
	for _, e := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif", ".tif", ".tiff"} {
		if strings.HasSuffix(l, e) {
			return true
		}
	}
	return false
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	return hex.EncodeToString(b)
}

var backupMu sync.Mutex
var backupRunning bool

func tailStr(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 500 {
		s = "…" + s[len(s)-500:]
	}
	return s
}

// резервная копия: restic в S3-хранилище (данные + дамп БД). Шифрование restic паролем репозитория.
func runBackup() {
	backupMu.Lock()
	if backupRunning {
		backupMu.Unlock()
		return
	}
	backupRunning = true
	backupMu.Unlock()
	defer func() { backupMu.Lock(); backupRunning = false; backupMu.Unlock() }()

	setStatus := func(s, out string) { db.Exec(`UPDATE backup_cfg SET last_run=now(), last_status=$1, last_output=$2 WHERE id=1`, s, tailStr(out)) }
	var endpoint, bucket, region, ak, sk, pass string
	db.QueryRow(`SELECT endpoint,bucket,region,access_key,secret_key,repo_pass FROM backup_cfg WHERE id=1`).Scan(&endpoint, &bucket, &region, &ak, &sk, &pass)
	if endpoint == "" || bucket == "" || pass == "" {
		setStatus("error", "Не заполнены настройки: endpoint, бакет и ключ архива обязательны")
		return
	}
	if _, err := exec.LookPath("restic"); err != nil {
		setStatus("error", "restic не установлен на сервере. Установите: apt install restic")
		return
	}
	repo := "s3:" + endpoint + "/" + bucket
	env := append(os.Environ(), "RESTIC_REPOSITORY="+repo, "RESTIC_PASSWORD="+pass, "AWS_ACCESS_KEY_ID="+ak, "AWS_SECRET_ACCESS_KEY="+sk)
	if region != "" {
		env = append(env, "AWS_DEFAULT_REGION="+region)
	}
	run := func(args ...string) (string, error) {
		c := exec.Command("restic", args...)
		c.Env = env
		b, e := c.CombinedOutput()
		return string(b), e
	}
	if _, err := run("snapshots", "--no-lock"); err != nil {
		if out, e := run("init"); e != nil {
			setStatus("error", "Инициализация хранилища не удалась: "+out)
			return
		}
	}
	dbf := filepath.Join(os.TempDir(), "securevault-db.sql")
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		pc := exec.Command("pg_dump", dsn, "-f", dbf)
		pc.CombinedOutput()
	}
	args := []string{"backup", "--no-lock", "--tag", "securevault", dataDir}
	if _, err := os.Stat(dbf); err == nil {
		args = append(args, dbf)
	}
	out, err := run(args...)
	os.Remove(dbf)
	if err != nil {
		setStatus("error", out)
		return
	}
	setStatus("ok", out)
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
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT ''`,
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS root_id text`,
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS superseded boolean NOT NULL DEFAULT false`,
		`ALTER TABLE records ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
		`UPDATE records SET root_id=id WHERE root_id IS NULL`,
		`CREATE TABLE IF NOT EXISTS user_prefs(login text PRIMARY KEY, blob bytea NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE IF NOT EXISTS folders(org text NOT NULL, path text NOT NULL, PRIMARY KEY(org, path))`,
		`CREATE TABLE IF NOT EXISTS used_licenses(
			id text PRIMARY KEY, org text, used_at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pub_key text`,
		`CREATE TABLE IF NOT EXISTS comments(
			id text PRIMARY KEY, record_id text NOT NULL, author text NOT NULL,
			org text, blob bytea NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS perms text`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quota_bytes bigint NOT NULL DEFAULT 0`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT ''`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS see_all boolean NOT NULL DEFAULT false`,
		`UPDATE accounts SET see_all=true WHERE role='reviewer' AND see_all=false`,
		`CREATE TABLE IF NOT EXISTS user_log(seq bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text, at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE user_log ADD COLUMN IF NOT EXISTS rid text`,
		`CREATE TABLE IF NOT EXISTS notifications(id text PRIMARY KEY, recipient text NOT NULL, kind text NOT NULL, rid text, actor text, text text, at timestamptz NOT NULL DEFAULT now(), read_at timestamptz)`,
		`CREATE INDEX IF NOT EXISTS notif_recipient_idx ON notifications(recipient, at DESC)`,
		`CREATE TABLE IF NOT EXISTS org_settings(org text PRIMARY KEY, deadline_day int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`,
		`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS review_on boolean NOT NULL DEFAULT true`,
		`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS default_folders text NOT NULL DEFAULT ''`,
		// бэкофилл: у проверяющих (see_all), заведённых до появления права "review", включаем его
		`UPDATE accounts SET perms = left(perms, length(perms)-1) || ',"review"]' WHERE COALESCE(see_all,false)=true AND perms LIKE '[%]' AND perms <> '[]' AND perms NOT LIKE '%"review"%'`,
		`UPDATE accounts SET perms = '["view_all","review"]' WHERE COALESCE(see_all,false)=true AND (perms IS NULL OR perms='' OR perms='[]')`,
		// комментарии привязываем к логическому файлу (root_id), чтобы не терялись при замене версии
		`UPDATE comments SET record_id = (SELECT COALESCE(r.root_id, r.id) FROM records r WHERE r.id = comments.record_id) WHERE EXISTS (SELECT 1 FROM records r WHERE r.id = comments.record_id)`,
		`CREATE TABLE IF NOT EXISTS comment_reads(login text NOT NULL, root_id text NOT NULL, last_read timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(login, root_id))`,
		`ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS login_policy text NOT NULL DEFAULT ''`,
		`CREATE TABLE IF NOT EXISTS approvals(id text PRIMARY KEY, org text NOT NULL, kind text NOT NULL, requester text NOT NULL, requester_name text, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), decided_by text, decided_at timestamptz, used_at timestamptz)`,
		`CREATE TABLE IF NOT EXISTS backup_cfg(id int PRIMARY KEY DEFAULT 1, kind text NOT NULL DEFAULT 's3', endpoint text NOT NULL DEFAULT '', bucket text NOT NULL DEFAULT '', region text NOT NULL DEFAULT '', access_key text NOT NULL DEFAULT '', secret_key text NOT NULL DEFAULT '', repo_pass text NOT NULL DEFAULT '', schedule text NOT NULL DEFAULT 'manual', last_run timestamptz, last_status text NOT NULL DEFAULT '', last_output text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now())`,
		`INSERT INTO backup_cfg(id) VALUES(1) ON CONFLICT DO NOTHING`,
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
		var org, role, permsJSON string
		var seeAll bool
		if db.QueryRow(`SELECT auth_hash,enc_vault,org,role,COALESCE(perms,''),COALESCE(see_all,false) FROM accounts WHERE login=$1 AND NOT revoked`, req.Login).Scan(&authHash, &vault, &org, &role, &permsJSON, &seeAll) != nil {
			writeErr(w, 401, "Неверный логин или пароль")
			return
		}
		h := sha256.Sum256(tok)
		if subtle.ConstantTimeCompare(h[:], authHash) != 1 {
			writeErr(w, 401, "Неверный логин или пароль")
			return
		}
		var perms []string
		if permsJSON != "" {
			json.Unmarshal([]byte(permsJSON), &perms)
		}
		writeJSON(w, map[string]any{"org": org, "enc_vault": base64.StdEncoding.EncodeToString(vault), "role": role, "perms": perms, "see_all": seeAll})
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

	addUserLogR := func(actor, action, target, rid string) {
		db.Exec(`INSERT INTO user_log(actor,action,target,rid) VALUES($1,$2,$3,$4)`, actor, action, target, rid)
	}
	addUserLog := func(actor, action, target string) {
		addUserLogR(actor, action, target, "")
	}
	// уведомление одному получателю (не себе)
	addNotif := func(recipient, actor, kind, rid, text string) {
		if recipient == "" || recipient == actor {
			return
		}
		db.Exec(`INSERT INTO notifications(id,recipient,kind,rid,actor,text) VALUES($1,$2,$3,$4,$5,$6)`, newID(), recipient, kind, rid, actor, text)
	}
	// уведомить всех проверяющих организации (кроме actor)
	notifyReviewers := func(org, actor, kind, rid, text string) {
		rows, err := db.Query(`SELECT login FROM accounts WHERE org=$1 AND COALESCE(see_all,false)=true AND NOT revoked`, org)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var l string
			if rows.Scan(&l) == nil {
				addNotif(l, actor, kind, rid, text)
			}
		}
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
			QuotaBytes  int64    `json:"quota_bytes"`
			DisplayName string   `json:"display_name"`
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
		if _, err := db.Exec(`INSERT INTO accounts(login,org,salt,auth_hash,enc_vault,role,owner_login,pub_key,perms,see_all,quota_bytes,display_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			req.Login, org, salt, h[:], vault, req.Role, req.MasterLogin, req.PubKey, string(permsJSON), req.SeeAll, req.QuotaBytes, strings.TrimSpace(req.DisplayName)); err != nil {
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
		rows, err := db.Query(`SELECT login, role, org, created_at, revoked, quota_bytes, COALESCE(display_name,''), COALESCE(perms,''),
			COALESCE((SELECT sum(size) FROM records WHERE owner_login=accounts.login AND deleted_at IS NULL AND NOT superseded),0),
			(SELECT max(created_at) FROM records WHERE owner_login=accounts.login AND deleted_at IS NULL AND NOT superseded)
			FROM accounts WHERE owner_login=$1 ORDER BY created_at`, req.MasterLogin)
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
			Quota   int64     `json:"quota_bytes"`
			Name    string    `json:"display_name"`
			Perms   []string  `json:"perms"`
			Used    int64     `json:"used_bytes"`
			Last    *time.Time `json:"last_submit"`
		}
		out := []acc{}
		for rows.Next() {
			var a acc
			var permsJSON string
			var last sql.NullTime
			if rows.Scan(&a.Login, &a.Role, &a.Org, &a.Created, &a.Revoked, &a.Quota, &a.Name, &permsJSON, &a.Used, &last) == nil {
				if permsJSON != "" {
					json.Unmarshal([]byte(permsJSON), &a.Perms)
				}
				if a.Perms == nil {
					a.Perms = []string{}
				}
				if last.Valid {
					a.Last = &last.Time
				}
				out = append(out, a)
			}
		}
		writeJSON(w, out)
	})

	// настройки организации: срок сдачи (день 1..28; 0 = нет), режим проверки, папки по умолчанию
	readOrgCfg := func(org string) map[string]any {
		var day int
		var reviewOn bool = true
		var foldersJSON string
		db.QueryRow(`SELECT deadline_day, review_on, COALESCE(default_folders,'') FROM org_settings WHERE org=$1`, org).Scan(&day, &reviewOn, &foldersJSON)
		folders := []string{}
		if foldersJSON != "" {
			json.Unmarshal([]byte(foldersJSON), &folders)
		}
		if folders == nil {
			folders = []string{}
		}
		return map[string]any{"deadline_day": day, "review_on": reviewOn, "default_folders": folders}
	}

	mux.HandleFunc("/auth/orgcfg/get", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Org         string `json:"org"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		writeJSON(w, readOrgCfg(req.Org))
	})

	mux.HandleFunc("/auth/orgcfg/set", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin    string   `json:"master_login"`
			MasterTok      string   `json:"master_auth_token"`
			Org            string   `json:"org"`
			Day            int      `json:"deadline_day"`
			ReviewOn       bool     `json:"review_on"`
			DefaultFolders []string `json:"default_folders"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		if req.Day < 0 || req.Day > 28 {
			writeErr(w, 400, "День 1..28")
			return
		}
		folders := req.DefaultFolders
		if folders == nil {
			folders = []string{}
		}
		fj, _ := json.Marshal(folders)
		if _, err := db.Exec(`INSERT INTO org_settings(org, deadline_day, review_on, default_folders, updated_at) VALUES($1,$2,$3,$4,now())
			ON CONFLICT(org) DO UPDATE SET deadline_day=$2, review_on=$3, default_folders=$4, updated_at=now()`, req.Org, req.Day, req.ReviewOn, string(fj)); err != nil {
			writeErr(w, 500, "db")
			return
		}
		// заводим папки по умолчанию в организации сразу (появятся у профилей)
		for _, f := range folders {
			p := strings.TrimSpace(f)
			if p != "" {
				db.Exec(`INSERT INTO folders(org,path) VALUES($1,$2) ON CONFLICT DO NOTHING`, req.Org, p)
			}
		}
		addAudit(req.MasterLogin, "orgcfg_set", fmt.Sprintf("срок %d, проверка %v", req.Day, req.ReviewOn), req.Org)
		writeJSON(w, map[string]any{"ok": true})
	})

	// политика входа по ролям (какие способы разрешены) — JSON {roleKey:[methods]}
	mux.HandleFunc("/auth/loginpolicy/get", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Org         string `json:"org"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		var p string
		db.QueryRow(`SELECT COALESCE(login_policy,'') FROM org_settings WHERE org=$1`, req.Org).Scan(&p)
		writeJSON(w, map[string]any{"policy": p})
	})

	mux.HandleFunc("/auth/loginpolicy/set", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Org         string `json:"org"`
			Policy      string `json:"policy"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		if _, err := db.Exec(`INSERT INTO org_settings(org, login_policy, updated_at) VALUES($1,$2,now())
			ON CONFLICT(org) DO UPDATE SET login_policy=$2, updated_at=now()`, req.Org, req.Policy); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addAudit(req.MasterLogin, "loginpolicy_set", "способы входа", req.Org)
		writeJSON(w, map[string]any{"ok": true})
	})

	// ===== Резервные копии (S3 через restic) — мастер =====
	mux.HandleFunc("/auth/backup/get", func(w http.ResponseWriter, r *http.Request) {
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
		var endpoint, bucket, region, ak, sk, pass, sched, lstatus, lout string
		var lrun sql.NullTime
		db.QueryRow(`SELECT endpoint,bucket,region,access_key,secret_key,repo_pass,schedule,COALESCE(last_status,''),COALESCE(last_output,''),last_run FROM backup_cfg WHERE id=1`).Scan(&endpoint, &bucket, &region, &ak, &sk, &pass, &sched, &lstatus, &lout, &lrun)
		backupMu.Lock()
		running := backupRunning
		backupMu.Unlock()
		lr := ""
		if lrun.Valid {
			lr = lrun.Time.Format(time.RFC3339)
		}
		writeJSON(w, map[string]any{
			"endpoint": endpoint, "bucket": bucket, "region": region, "access_key": ak, "schedule": sched,
			"has_secret": sk != "", "has_pass": pass != "",
			"last_run": lr, "last_status": lstatus, "last_output": lout, "running": running,
		})
	})

	mux.HandleFunc("/auth/backup/set", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Endpoint    string `json:"endpoint"`
			Bucket      string `json:"bucket"`
			Region      string `json:"region"`
			AccessKey   string `json:"access_key"`
			SecretKey   string `json:"secret_key"`
			RepoPass    string `json:"repo_pass"`
			Schedule    string `json:"schedule"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, ok := authMaster(req.MasterLogin, req.MasterTok); !ok {
			writeErr(w, 401, "Нет прав мастера")
			return
		}
		// пустые secret/pass — не затираем существующие
		db.Exec(`UPDATE backup_cfg SET endpoint=$1, bucket=$2, region=$3, access_key=$4, schedule=$5, updated_at=now() WHERE id=1`, req.Endpoint, req.Bucket, req.Region, req.AccessKey, req.Schedule)
		if strings.TrimSpace(req.SecretKey) != "" {
			db.Exec(`UPDATE backup_cfg SET secret_key=$1 WHERE id=1`, req.SecretKey)
		}
		if strings.TrimSpace(req.RepoPass) != "" {
			db.Exec(`UPDATE backup_cfg SET repo_pass=$1 WHERE id=1`, req.RepoPass)
		}
		addAudit(req.MasterLogin, "backup_cfg", "настройки резервных копий", "")
		writeJSON(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/auth/backup/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
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
		db.Exec(`UPDATE backup_cfg SET last_status='running' WHERE id=1`)
		go runBackup()
		addAudit(req.MasterLogin, "backup_run", "запуск копии", "")
		writeJSON(w, map[string]any{"ok": true})
	})

	// мастер задаёт квоту места профилю (байты; 0 = без лимита)
	mux.HandleFunc("/auth/set_quota", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Login       string `json:"login"`
			QuotaBytes  int64  `json:"quota_bytes"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Login == "" {
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
		if req.QuotaBytes < 0 {
			req.QuotaBytes = 0
		}
		if _, err := db.Exec(`UPDATE accounts SET quota_bytes=$1 WHERE login=$2`, req.QuotaBytes, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addAudit(req.MasterLogin, "quota_set", req.Login, "")
		io.WriteString(w, "ok")
	})

	// мастер задаёт отображаемое имя профиля (несекретное — видят проверяющий и все)
	mux.HandleFunc("/auth/set_name", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string `json:"master_login"`
			MasterTok   string `json:"master_auth_token"`
			Login       string `json:"login"`
			DisplayName string `json:"display_name"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Login == "" {
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
		if _, err := db.Exec(`UPDATE accounts SET display_name=$1 WHERE login=$2`, strings.TrimSpace(req.DisplayName), req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		io.WriteString(w, "ok")
	})

	// мастер меняет роль и права профиля (без сброса пароля) — права действуют со следующего входа
	mux.HandleFunc("/auth/set_perms", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			MasterLogin string   `json:"master_login"`
			MasterTok   string   `json:"master_auth_token"`
			Login       string   `json:"login"`
			Role        string   `json:"role"`
			Perms       []string `json:"perms"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Login == "" {
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
		seeAll := false
		for _, p := range req.Perms {
			if p == "view_all" {
				seeAll = true
			}
		}
		permsJSON, _ := json.Marshal(req.Perms)
		role := strings.TrimSpace(req.Role)
		if role == "" || role == "master" {
			role = "director"
		}
		if _, err := db.Exec(`UPDATE accounts SET perms=$1, see_all=$2, role=$3 WHERE login=$4`, string(permsJSON), seeAll, role, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addAudit(req.MasterLogin, "perms_changed", req.Login, "")
		io.WriteString(w, "ok")
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
	// есть ли у аккаунта право (master — всё); права берутся из accounts.perms
	acctHasPerm := func(login, perm string) bool {
		var role, permsJSON string
		if db.QueryRow(`SELECT role, COALESCE(perms,'') FROM accounts WHERE login=$1`, login).Scan(&role, &permsJSON) != nil {
			return false
		}
		if role == "master" {
			return true
		}
		if permsJSON == "" {
			return false
		}
		var ps []string
		if json.Unmarshal([]byte(permsJSON), &ps) != nil {
			return false
		}
		for _, p := range ps {
			if p == perm {
				return true
			}
		}
		return false
	}
	_ = acctHasPerm

	// чтение настроек организации любым её аккаунтом (директор/проверяющий)
	mux.HandleFunc("/data/orgcfg", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
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
		writeJSON(w, readOrgCfg(org))
	})

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
		replaces := r.FormValue("replaces")
		rootID := id
		if replaces != "" {
			var oldRoot, oldOwner string
			if db.QueryRow(`SELECT COALESCE(root_id,id), owner_login FROM records WHERE id=$1`, replaces).Scan(&oldRoot, &oldOwner) == nil && oldOwner == login {
				rootID = oldRoot
			} else {
				replaces = ""
			}
		}
		var quota int64
		db.QueryRow(`SELECT quota_bytes FROM accounts WHERE login=$1`, login).Scan(&quota)
		if quota > 0 {
			var used int64
			db.QueryRow(`SELECT COALESCE(sum(size),0) FROM records WHERE owner_login=$1 AND deleted_at IS NULL AND NOT superseded AND COALESCE(root_id,id)<>$2`, login, rootID).Scan(&used)
			if used+n > quota {
				os.Remove(filepath.Join(dataDir, id))
				writeErr(w, 413, "Недостаточно места: превышена выделенная квота. Удалите ненужные файлы или обратитесь к администратору.")
				return
			}
		}
		status := ""
		{
			var ron bool = true
			db.QueryRow(`SELECT review_on FROM org_settings WHERE org=$1`, org).Scan(&ron)
			if ron && !isImageFile(title) {
				status = "draft"
			}
		}
		if _, err = db.Exec(`INSERT INTO records(id,space,doc_type,submitter,filename,size,owner_login,org,folder,root_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
			id, org, kind, login, title, n, login, org, folder, rootID, status); err != nil {
			writeErr(w, 500, "db")
			return
		}
		if replaces != "" {
			db.Exec(`UPDATE records SET superseded=true WHERE id=$1`, replaces)
			// хранить только 5 последних версий файла
			if vr, e := db.Query(`SELECT id FROM records WHERE owner_login=$1 AND COALESCE(root_id,id)=$2 ORDER BY created_at DESC OFFSET 5`, login, rootID); e == nil {
				var oldv []string
				for vr.Next() {
					var oid string
					if vr.Scan(&oid) == nil {
						oldv = append(oldv, oid)
					}
				}
				vr.Close()
				for _, oid := range oldv {
					if strings.ContainsAny(oid, "/.") {
						continue
					}
					db.Exec(`DELETE FROM records WHERE id=$1`, oid)
					os.Remove(filepath.Join(dataDir, oid))
				}
			}
		}
		var owner sql.NullString
		db.QueryRow(`SELECT owner_login FROM accounts WHERE login=$1`, login).Scan(&owner)
		if owner.Valid && owner.String != "" {
			addAudit(owner.String, "report_submitted", title, org)
		}
		addUserLogR(login, "submit", title, id)
		// при выключенной проверке (status="") и для картинок проверяющих уведомляем сразу как раньше;
		// в режиме проверки файл-черновик уедет на проверку только по кнопке «Сдать на проверку»
		if status == "" && replaces == "" && !isImageFile(title) {
			var seeAll bool
			db.QueryRow(`SELECT COALESCE(see_all,false) FROM accounts WHERE login=$1`, login).Scan(&seeAll)
			if !seeAll {
				notifyReviewers(org, login, "new_file", id, title)
			}
		}
		writeJSON(w, map[string]string{"id": id})
	})

	// директор отправляет свой файл-черновик на проверку (status draft/fix -> "")
	mux.HandleFunc("/data/submit_review", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
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
		var title, status, owner string
		if db.QueryRow(`SELECT filename, COALESCE(status,''), owner_login FROM records WHERE id=$1 AND deleted_at IS NULL AND NOT superseded`, req.ID).Scan(&title, &status, &owner) != nil || owner != req.Login {
			writeErr(w, 404, "нет файла")
			return
		}
		if status == "ok" {
			writeJSON(w, map[string]any{"ok": true})
			return
		}
		if _, err := db.Exec(`UPDATE records SET status='sent' WHERE id=$1 AND owner_login=$2`, req.ID, req.Login); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addUserLogR(req.Login, "sent_review", title, req.ID)
		notifyReviewers(org, req.Login, "new_file", req.ID, title)
		writeJSON(w, map[string]any{"ok": true})
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
		rows, err := db.Query(`SELECT r.id, r.doc_type, r.filename, r.size, r.folder, r.created_at, COALESCE(cc.n,0), COALESCE(r.status,'') FROM records r LEFT JOIN (SELECT record_id, count(*) n FROM comments GROUP BY record_id) cc ON cc.record_id=COALESCE(r.root_id,r.id) WHERE r.owner_login=$1 AND COALESCE(r.superseded,false)=false AND r.deleted_at IS NULL ORDER BY r.created_at DESC`, req.Login)
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
			Status   string    `json:"status"`
		}
		out := []rec{}
		for rows.Next() {
			var x rec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.At, &x.Comments, &x.Status) == nil {
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
		var delName, rootID string
		db.QueryRow(`SELECT filename, COALESCE(root_id,id) FROM records WHERE id=$1`, req.ID).Scan(&delName, &rootID)
		// мягкое удаление: весь файл со всеми версиями уходит в Корзину (blob остаётся зашифрованным)
		db.Exec(`UPDATE records SET deleted_at=now() WHERE owner_login=$1 AND COALESCE(root_id,id)=$2`, req.Login, rootID)
		addUserLogR(req.Login, "trash", delName, req.ID)
		io.WriteString(w, "ok")
	})

	// версии файла (вся цепочка по root_id)
	mux.HandleFunc("/data/versions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
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
		var rowner, rorg, rootID string
		if db.QueryRow(`SELECT owner_login, org, COALESCE(root_id,id) FROM records WHERE id=$1`, req.ID).Scan(&rowner, &rorg, &rootID) != nil {
			writeErr(w, 404, "not found")
			return
		}
		// доступ: владелец, либо проверяющий (see_all) той же организации
		if rowner != req.Login {
			var seeAll bool
			db.QueryRow(`SELECT COALESCE(see_all,false) FROM accounts WHERE login=$1`, req.Login).Scan(&seeAll)
			if !seeAll || rorg != org {
				writeErr(w, 403, "forbidden")
				return
			}
		}
		rows, err := db.Query(`SELECT id, filename, size, submitter, created_at, COALESCE(superseded,false), COALESCE(status,'') FROM records WHERE COALESCE(root_id,id)=$1 AND owner_login=$2 ORDER BY created_at DESC`, rootID, rowner)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type ver struct {
			ID        string    `json:"id"`
			Name      string    `json:"name"`
			Size      int64     `json:"size"`
			Submitter string    `json:"submitter"`
			At        time.Time `json:"at"`
			Current   bool      `json:"current"`
			Status    string    `json:"status"`
		}
		out := []ver{}
		for rows.Next() {
			var x ver
			var sup bool
			if rows.Scan(&x.ID, &x.Name, &x.Size, &x.Submitter, &x.At, &sup, &x.Status) == nil {
				x.Current = !sup
				out = append(out, x)
			}
		}
		writeJSON(w, out)
	})

	// вернуть прежнюю версию (сделать текущей)
	mux.HandleFunc("/data/restore_version", func(w http.ResponseWriter, r *http.Request) {
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
		var rowner, rootID, rname string
		if db.QueryRow(`SELECT owner_login, COALESCE(root_id,id), filename FROM records WHERE id=$1`, req.ID).Scan(&rowner, &rootID, &rname) != nil || rowner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		db.Exec(`UPDATE records SET superseded=true WHERE COALESCE(root_id,id)=$1 AND owner_login=$2`, rootID, req.Login)
		db.Exec(`UPDATE records SET superseded=false, status='' WHERE id=$1`, req.ID)
		addUserLogR(req.Login, "restore_version", rname, req.ID)
		io.WriteString(w, "ok")
	})

	// Корзина: список удалённых файлов владельца
	mux.HandleFunc("/data/trash", func(w http.ResponseWriter, r *http.Request) {
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
		rows, err := db.Query(`SELECT id, doc_type, filename, size, folder, created_at, deleted_at FROM records WHERE owner_login=$1 AND deleted_at IS NOT NULL AND COALESCE(superseded,false)=false ORDER BY deleted_at DESC`, req.Login)
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
			At        time.Time `json:"at"`
			DeletedAt time.Time `json:"deleted_at"`
		}
		out := []rec{}
		for rows.Next() {
			var x rec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.At, &x.DeletedAt) == nil {
				out = append(out, x)
			}
		}
		writeJSON(w, out)
	})

	// Корзина: восстановить файл (всю цепочку версий)
	mux.HandleFunc("/data/restore", func(w http.ResponseWriter, r *http.Request) {
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
		var rowner, rootID, rname string
		if db.QueryRow(`SELECT owner_login, COALESCE(root_id,id), filename FROM records WHERE id=$1`, req.ID).Scan(&rowner, &rootID, &rname) != nil || rowner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		db.Exec(`UPDATE records SET deleted_at=NULL WHERE owner_login=$1 AND COALESCE(root_id,id)=$2`, req.Login, rootID)
		addUserLogR(req.Login, "restore", rname, req.ID)
		io.WriteString(w, "ok")
	})

	// Корзина: стереть навсегда (один файл или вся корзина при all=true)
	mux.HandleFunc("/data/purge", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			All     bool   `json:"all"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		var ids []string
		if req.All {
			if rows, e := db.Query(`SELECT id FROM records WHERE owner_login=$1 AND deleted_at IS NOT NULL`, req.Login); e == nil {
				for rows.Next() {
					var x string
					if rows.Scan(&x) == nil {
						ids = append(ids, x)
					}
				}
				rows.Close()
			}
		} else {
			var rowner, rootID string
			if db.QueryRow(`SELECT owner_login, COALESCE(root_id,id) FROM records WHERE id=$1`, req.ID).Scan(&rowner, &rootID) != nil || rowner != req.Login {
				writeErr(w, 404, "not found")
				return
			}
			if rows, e := db.Query(`SELECT id FROM records WHERE owner_login=$1 AND COALESCE(root_id,id)=$2 AND deleted_at IS NOT NULL`, req.Login, rootID); e == nil {
				for rows.Next() {
					var x string
					if rows.Scan(&x) == nil {
						ids = append(ids, x)
					}
				}
				rows.Close()
			}
		}
		for _, id := range ids {
			if strings.ContainsAny(id, "/.") {
				continue
			}
			db.Exec(`DELETE FROM records WHERE id=$1`, id)
			db.Exec(`DELETE FROM comments WHERE record_id=$1`, id)
			os.Remove(filepath.Join(dataDir, id))
		}
		addUserLog(req.Login, "purge", "")
		io.WriteString(w, "ok")
	})

	// настройки пользователя (зашифрованный blob: тема, акцент, вид, избранное)
	mux.HandleFunc("/data/prefs/get", func(w http.ResponseWriter, r *http.Request) {
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
		var blob []byte
		db.QueryRow(`SELECT blob FROM user_prefs WHERE login=$1`, req.Login).Scan(&blob)
		writeJSON(w, map[string]string{"blob": base64.StdEncoding.EncodeToString(blob)})
	})
	mux.HandleFunc("/data/prefs/set", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Blob    string `json:"blob"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		raw, err := base64.StdEncoding.DecodeString(req.Blob)
		if err != nil || len(raw) > 1<<20 {
			writeErr(w, 400, "bad blob")
			return
		}
		if _, err := db.Exec(`INSERT INTO user_prefs(login,blob,at) VALUES($1,$2,now()) ON CONFLICT(login) DO UPDATE SET blob=$2, at=now()`, req.Login, raw); err != nil {
			writeErr(w, 500, "db")
			return
		}
		io.WriteString(w, "ok")
	})

	// место на сервере (раздел с данными): всего / занято / свободно
	mux.HandleFunc("/data/diskinfo", func(w http.ResponseWriter, r *http.Request) {
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
		var st syscall.Statfs_t
		if err := syscall.Statfs(dataDir, &st); err != nil {
			writeErr(w, 500, "statfs")
			return
		}
		bs := uint64(st.Bsize)
		total := st.Blocks * bs
		free := st.Bavail * bs
		writeJSON(w, map[string]uint64{"total": total, "free": free, "used": total - free})
	})

	// профиль узнаёт свою квоту и занятое место
	mux.HandleFunc("/data/myquota", func(w http.ResponseWriter, r *http.Request) {
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
		var quota int64
		if db.QueryRow(`SELECT quota_bytes FROM accounts WHERE login=$1`, req.Login).Scan(&quota) != nil {
			writeErr(w, 404, "not found")
			return
		}
		var used int64
		db.QueryRow(`SELECT COALESCE(sum(size),0) FROM records WHERE owner_login=$1 AND deleted_at IS NULL AND NOT superseded`, req.Login).Scan(&used)
		writeJSON(w, map[string]int64{"quota_bytes": quota, "used_bytes": used})
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

	// переименовать файл (текущую запись)
	mux.HandleFunc("/data/rename", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Name    string `json:"name"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		name := strings.TrimSpace(req.Name)
		if name == "" || strings.ContainsAny(name, "/\\\n\r\t") {
			writeErr(w, 400, "Недопустимое имя")
			return
		}
		var owner string
		if db.QueryRow(`SELECT owner_login FROM records WHERE id=$1`, req.ID).Scan(&owner) != nil || owner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		if _, err := db.Exec(`UPDATE records SET filename=$1 WHERE id=$2`, name, req.ID); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addUserLogR(req.Login, "rename", name, req.ID)
		io.WriteString(w, "ok")
	})

	// переместить файл (всю цепочку версий) в другую папку
	mux.HandleFunc("/data/move", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Folder  string `json:"folder"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		folder := strings.Trim(strings.TrimSpace(req.Folder), "/")
		var owner, rootID, fname string
		if db.QueryRow(`SELECT owner_login, COALESCE(root_id,id), filename FROM records WHERE id=$1`, req.ID).Scan(&owner, &rootID, &fname) != nil || owner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		if _, err := db.Exec(`UPDATE records SET folder=$1 WHERE owner_login=$2 AND COALESCE(root_id,id)=$3`, folder, req.Login, rootID); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addUserLogR(req.Login, "move", fname, req.ID)
		io.WriteString(w, "ok")
	})

	// переименовать / переместить папку (структура общая по организации)
	mux.HandleFunc("/data/folder_move", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Old     string `json:"old"`
			New     string `json:"new"`
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
		oldp := strings.Trim(strings.TrimSpace(req.Old), "/")
		newp := strings.Trim(strings.TrimSpace(req.New), "/")
		if oldp == "" || newp == "" || strings.ContainsAny(newp, "\\\n\r\t") {
			writeErr(w, 400, "Недопустимый путь")
			return
		}
		if newp == oldp || strings.HasPrefix(newp+"/", oldp+"/") {
			writeErr(w, 400, "Нельзя переместить папку в саму себя")
			return
		}
		// перенести записи дерева папок (новые пути вставляем до удаления старых)
		var paths []string
		if rows, e := db.Query(`SELECT path FROM folders WHERE org=$1 AND (path=$2 OR path LIKE $2 || '/%')`, org, oldp); e == nil {
			for rows.Next() {
				var p string
				if rows.Scan(&p) == nil {
					paths = append(paths, p)
				}
			}
			rows.Close()
		}
		for _, p := range paths {
			np := newp + p[len(oldp):]
			db.Exec(`INSERT INTO folders(org,path) VALUES($1,$2) ON CONFLICT DO NOTHING`, org, np)
		}
		db.Exec(`DELETE FROM folders WHERE org=$1 AND (path=$2 OR path LIKE $2 || '/%')`, org, oldp)
		db.Exec(`UPDATE records SET folder=$1 WHERE org=$2 AND folder=$3`, newp, org, oldp)
		db.Exec(`UPDATE records SET folder=$1 || substring(folder from char_length($2)+1) WHERE org=$3 AND folder LIKE $2 || '/%'`, newp, oldp, org)
		addUserLog(req.Login, "folder_move", oldp+" → "+newp)
		io.WriteString(w, "ok")
	})

	// копировать файл (дубликат): blob остаётся тем же шифротекстом, новая запись
	mux.HandleFunc("/data/copy", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Folder  string `json:"folder"`
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
		if strings.ContainsAny(req.ID, "/.") {
			writeErr(w, 400, "bad id")
			return
		}
		target := strings.Trim(strings.TrimSpace(req.Folder), "/")
		var owner, kind, fname string
		var size int64
		if db.QueryRow(`SELECT owner_login, doc_type, filename, size FROM records WHERE id=$1`, req.ID).Scan(&owner, &kind, &fname, &size) != nil || owner != req.Login {
			writeErr(w, 404, "not found")
			return
		}
		// уникальное имя в целевой папке
		newname := fname
		var cnt int
		db.QueryRow(`SELECT count(*) FROM records WHERE owner_login=$1 AND org=$2 AND folder=$3 AND filename=$4 AND deleted_at IS NULL AND COALESCE(superseded,false)=false`, req.Login, org, target, newname).Scan(&cnt)
		if cnt > 0 {
			dot := strings.LastIndex(fname, ".")
			if dot > 0 {
				newname = fname[:dot] + " (копия)" + fname[dot:]
			} else {
				newname = fname + " (копия)"
			}
		}
		newID := newID()
		src, err := os.Open(filepath.Join(dataDir, req.ID))
		if err != nil {
			writeErr(w, 500, "src")
			return
		}
		defer src.Close()
		dst, err := os.OpenFile(filepath.Join(dataDir, newID), os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			writeErr(w, 500, "store")
			return
		}
		_, err = io.Copy(dst, src)
		dst.Close()
		if err != nil {
			os.Remove(filepath.Join(dataDir, newID))
			writeErr(w, 500, "write")
			return
		}
		if _, err = db.Exec(`INSERT INTO records(id,space,doc_type,submitter,filename,size,owner_login,org,folder,root_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$1)`,
			newID, org, kind, req.Login, newname, size, req.Login, org, target); err != nil {
			os.Remove(filepath.Join(dataDir, newID))
			writeErr(w, 500, "db")
			return
		}
		addUserLogR(req.Login, "copy", newname, newID)
		writeJSON(w, map[string]string{"id": newID})
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
		rows, err := db.Query(`SELECT a.login, COALESCE(a.display_name,''), a.created_at, a.revoked, a.quota_bytes, COALESCE(c.cnt,0), COALESCE(c.bytes,0), c.last_at, COALESCE(c.review,0), COALESCE(c.fix,0)
			FROM accounts a
			LEFT JOIN (
				SELECT owner_login, count(*) cnt, sum(size) bytes, max(created_at) last_at,
					count(*) FILTER (WHERE status='sent') review,
					count(*) FILTER (WHERE status='fix') fix
				FROM records WHERE COALESCE(superseded,false)=false AND deleted_at IS NULL GROUP BY owner_login
			) c ON c.owner_login=a.login
			WHERE a.org=$1 AND a.role='director' ORDER BY a.created_at`, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type prof struct {
			Login   string     `json:"login"`
			Name    string     `json:"display_name"`
			Created time.Time  `json:"created_at"`
			Revoked bool       `json:"revoked"`
			Quota   int64      `json:"quota_bytes"`
			Count   int        `json:"count"`
			Bytes   int64      `json:"bytes"`
			LastAt  *time.Time `json:"last_at"`
			Review  int        `json:"review"`
			Fix     int        `json:"fix"`
		}
		out := []prof{}
		for rows.Next() {
			var p prof
			var last sql.NullTime
			if rows.Scan(&p.Login, &p.Name, &p.Created, &p.Revoked, &p.Quota, &p.Count, &p.Bytes, &last, &p.Review, &p.Fix) == nil {
				if last.Valid {
					t := last.Time
					p.LastAt = &t
				}
				out = append(out, p)
			}
		}
		writeJSON(w, out)
	})

	// проверяющий: очередь проверки — все файлы со статусом «на проверке» по организации (старые сверху)
	mux.HandleFunc("/data/reviewer/queue", func(w http.ResponseWriter, r *http.Request) {
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
		rows, err := db.Query(`SELECT r.id, r.doc_type, r.filename, r.size, r.folder, r.owner_login, COALESCE(a.display_name,''), r.submitter, r.created_at, COALESCE(cc.n,0)
			FROM records r
			LEFT JOIN (SELECT record_id, count(*) n FROM comments GROUP BY record_id) cc ON cc.record_id=COALESCE(r.root_id,r.id)
			LEFT JOIN accounts a ON a.login=r.owner_login
			WHERE r.org=$1 AND r.status='sent' AND COALESCE(r.superseded,false)=false AND r.deleted_at IS NULL
			ORDER BY r.created_at ASC LIMIT 300`, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type qrec struct {
			ID        string    `json:"id"`
			Kind      string    `json:"kind"`
			Name      string    `json:"name"`
			Size      int64     `json:"size"`
			Folder    string    `json:"folder"`
			Owner     string    `json:"owner_login"`
			OwnerName string    `json:"owner_name"`
			Submitter string    `json:"submitter"`
			At        time.Time `json:"at"`
			Comments  int       `json:"comments"`
		}
		out := []qrec{}
		for rows.Next() {
			var x qrec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.Owner, &x.OwnerName, &x.Submitter, &x.At, &x.Comments) == nil {
				out = append(out, x)
			}
		}
		writeJSON(w, out)
	})

	// проверяющий: активность всех профилей организации (журнал по профилям)
	mux.HandleFunc("/data/reviewer/activity", func(w http.ResponseWriter, r *http.Request) {
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
		rows, err := db.Query(`SELECT u.actor, COALESCE(a.display_name,''), u.action, COALESCE(u.target,''), u.at, COALESCE(u.rid,'')
			FROM user_log u JOIN accounts a ON a.login=u.actor
			WHERE a.org=$1 ORDER BY u.seq DESC LIMIT 400`, org)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type ent struct {
			Actor     string    `json:"actor"`
			ActorName string    `json:"actor_name"`
			Action    string    `json:"action"`
			Target    string    `json:"target"`
			At        time.Time `json:"at"`
			Rid       string    `json:"rid"`
		}
		out := []ent{}
		for rows.Next() {
			var e ent
			if rows.Scan(&e.Actor, &e.ActorName, &e.Action, &e.Target, &e.At, &e.Rid) == nil {
				out = append(out, e)
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
		rows, err := db.Query(`SELECT r.id, r.doc_type, r.filename, r.size, r.folder, r.submitter, r.created_at, COALESCE(cc.n,0), COALESCE(r.status,'') FROM records r LEFT JOIN (SELECT record_id, count(*) n FROM comments GROUP BY record_id) cc ON cc.record_id=COALESCE(r.root_id,r.id) WHERE r.owner_login=$1 AND r.org=$2 AND COALESCE(r.superseded,false)=false AND r.deleted_at IS NULL ORDER BY r.created_at DESC`, req.Owner, org)
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
			Status    string    `json:"status"`
		}
		out := []rec{}
		for rows.Next() {
			var x rec
			if rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Size, &x.Folder, &x.Submitter, &x.At, &x.Comments, &x.Status) == nil {
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
		rows, err := db.Query(`SELECT id, doc_type, filename, size, folder, owner_login, submitter, created_at FROM records WHERE org=$1 AND COALESCE(superseded,false)=false AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 40`, org)
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
		if _, err = db.Exec(`INSERT INTO records(id,space,doc_type,submitter,filename,size,owner_login,org,folder,root_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			id, org, kind, login, title, n, owner, org, folder, id); err != nil {
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
		var rvDelName, rvOwner, rvRoot string
		db.QueryRow(`SELECT filename, owner_login, COALESCE(root_id,id) FROM records WHERE id=$1`, req.ID).Scan(&rvDelName, &rvOwner, &rvRoot)
		// мягкое удаление: уходит в Корзину директора-владельца
		db.Exec(`UPDATE records SET deleted_at=now() WHERE owner_login=$1 AND COALESCE(root_id,id)=$2`, rvOwner, rvRoot)
		addUserLog(req.Login, "trash", rvDelName)
		io.WriteString(w, "ok")
	})

	// проверяющий: поставить статус записи (принято/замечание/на проверке)
	mux.HandleFunc("/data/reviewer/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Status  string `json:"status"`
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
		if req.Status != "" && req.Status != "ok" && req.Status != "fix" && req.Status != "sent" {
			writeErr(w, 400, "bad status")
			return
		}
		var rorg, rname, rowner string
		if db.QueryRow(`SELECT org, filename, owner_login FROM records WHERE id=$1`, req.ID).Scan(&rorg, &rname, &rowner) != nil || rorg != org {
			writeErr(w, 404, "not found")
			return
		}
		if _, err := db.Exec(`UPDATE records SET status=$1 WHERE id=$2`, req.Status, req.ID); err != nil {
			writeErr(w, 500, "db")
			return
		}
		act := map[string]string{"ok": "accepted", "fix": "remarked"}[req.Status]
		if act == "" {
			act = "unmarked"
		}
		addUserLogR(req.Login, act, rname, req.ID)
		if req.Status == "ok" || req.Status == "fix" {
			addNotif(rowner, req.Login, "status_"+req.Status, req.ID, rname)
		}
		io.WriteString(w, "ok")
	})

	// проверяющий: переименовать файл профиля
	mux.HandleFunc("/data/reviewer/rename", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Name    string `json:"name"`
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
		name := strings.TrimSpace(req.Name)
		if name == "" || strings.ContainsAny(name, "/\\\n\r\t") {
			writeErr(w, 400, "Недопустимое имя")
			return
		}
		var rorg string
		if db.QueryRow(`SELECT org FROM records WHERE id=$1`, req.ID).Scan(&rorg) != nil || rorg != org {
			writeErr(w, 404, "not found")
			return
		}
		if _, err := db.Exec(`UPDATE records SET filename=$1 WHERE id=$2`, name, req.ID); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addUserLogR(req.Login, "rename", name, req.ID)
		io.WriteString(w, "ok")
	})

	// проверяющий: переместить файл профиля (всю цепочку версий)
	mux.HandleFunc("/data/reviewer/move", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Folder  string `json:"folder"`
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
		folder := strings.Trim(strings.TrimSpace(req.Folder), "/")
		var rorg, owner, rootID, fname string
		if db.QueryRow(`SELECT org, owner_login, COALESCE(root_id,id), filename FROM records WHERE id=$1`, req.ID).Scan(&rorg, &owner, &rootID, &fname) != nil || rorg != org {
			writeErr(w, 404, "not found")
			return
		}
		if _, err := db.Exec(`UPDATE records SET folder=$1 WHERE owner_login=$2 AND COALESCE(root_id,id)=$3`, folder, owner, rootID); err != nil {
			writeErr(w, 500, "db")
			return
		}
		addUserLogR(req.Login, "move", fname, req.ID)
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
		if !acctHasPerm(req.Login, "view_log") {
			writeErr(w, 403, "Нет доступа к журналу")
			return
		}
		rows, err := db.Query(`SELECT action, target, at, COALESCE(rid,'') FROM user_log WHERE actor=$1 ORDER BY seq DESC LIMIT 500`, req.Login)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type ent struct {
			Action string    `json:"action"`
			Target string    `json:"target"`
			At     time.Time `json:"at"`
			Rid    string    `json:"rid"`
		}
		out := []ent{}
		for rows.Next() {
			var e ent
			if rows.Scan(&e.Action, &e.Target, &e.At, &e.Rid) == nil {
				out = append(out, e)
			}
		}
		writeJSON(w, out)
	})

	// доступ к комментариям записи: любой аккаунт той же организации
	// возвращает (org, владелец, root_id файла, ok) — комментарии привязаны к логическому файлу (root), живут сквозь версии
	commentAllowed := func(login, tok, recordID string) (string, string, string, bool) {
		org, _, ok := authAccount(login, tok)
		if !ok {
			return "", "", "", false
		}
		var rorg, rowner, root string
		if db.QueryRow(`SELECT org, owner_login, COALESCE(root_id,id) FROM records WHERE id=$1`, recordID).Scan(&rorg, &rowner, &root) != nil {
			return "", "", "", false
		}
		if rorg != org {
			return "", "", "", false
		}
		return org, rowner, root, true
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
		_, _, root, ok := commentAllowed(req.Login, req.AuthTok, req.RecordID)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		// прежняя отметка «прочитано» этим пользователем (для подсветки непрочитанных)
		var prior sql.NullTime
		db.QueryRow(`SELECT last_read FROM comment_reads WHERE login=$1 AND root_id=$2`, req.Login, root).Scan(&prior)
		priorStr := ""
		if prior.Valid {
			priorStr = prior.Time.Format(time.RFC3339Nano)
		}
		rows, err := db.Query(`SELECT c.id, c.author, COALESCE(a.display_name,''), c.blob, c.at FROM comments c LEFT JOIN accounts a ON a.login=c.author WHERE c.record_id=$1 ORDER BY c.at`, root)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type cm struct {
			ID         string    `json:"id"`
			Author     string    `json:"author"`
			AuthorName string    `json:"author_name"`
			Blob       string    `json:"blob"`
			At         time.Time `json:"at"`
		}
		out := []cm{}
		for rows.Next() {
			var c cm
			var blob []byte
			if rows.Scan(&c.ID, &c.Author, &c.AuthorName, &blob, &c.At) == nil {
				c.Blob = base64.StdEncoding.EncodeToString(blob)
				out = append(out, c)
			}
		}
		// отмечаем прочитанным сейчас
		db.Exec(`INSERT INTO comment_reads(login,root_id,last_read) VALUES($1,$2,now()) ON CONFLICT(login,root_id) DO UPDATE SET last_read=now()`, req.Login, root)
		writeJSON(w, map[string]any{"items": out, "last_read": priorStr})
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
		org, rowner, root, ok := commentAllowed(req.Login, req.AuthTok, req.RecordID)
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
			newID(), root, req.Login, org, blob); err != nil {
			writeErr(w, 500, "db")
			return
		}
		var cmName string
		db.QueryRow(`SELECT filename FROM records WHERE id=$1`, req.RecordID).Scan(&cmName)
		addUserLog(req.Login, "comment", cmName)
		if req.Login == rowner {
			notifyReviewers(org, req.Login, "comment", req.RecordID, cmName)
		} else {
			addNotif(rowner, req.Login, "comment", req.RecordID, cmName)
		}
		io.WriteString(w, "ok")
	})

	// ===== Опасные операции с подтверждением второго человека =====
	kindLabel := func(k string) string {
		switch k {
		case "download_all":
			return "скачать все данные"
		case "bulk_delete":
			return "массовое удаление"
		}
		return k
	}
	isSeeAll := func(login string) bool {
		var v bool
		db.QueryRow(`SELECT COALESCE(see_all,false) FROM accounts WHERE login=$1`, login).Scan(&v)
		return v
	}
	mux.HandleFunc("/data/approval/request", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			Kind    string `json:"kind"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, role, ok := authAccount(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		if !(isSeeAll(req.Login) || role == "master") {
			writeErr(w, 403, "Недостаточно прав")
			return
		}
		if req.Kind != "download_all" && req.Kind != "bulk_delete" {
			writeErr(w, 400, "bad kind")
			return
		}
		var name string
		db.QueryRow(`SELECT COALESCE(display_name,'') FROM accounts WHERE login=$1`, req.Login).Scan(&name)
		if name == "" {
			name = req.Login
		}
		id := newID()
		if _, err := db.Exec(`INSERT INTO approvals(id,org,kind,requester,requester_name,status) VALUES($1,$2,$3,$4,$5,'pending')`, id, org, req.Kind, req.Login, name); err != nil {
			writeErr(w, 500, "db")
			return
		}
		// уведомляем других проверяющих организации (мастер увидит в своём кабинете)
		if rows, e := db.Query(`SELECT login FROM accounts WHERE org=$1 AND COALESCE(see_all,false)=true AND NOT revoked AND login<>$2`, org, req.Login); e == nil {
			var who []string
			for rows.Next() {
				var l string
				if rows.Scan(&l) == nil {
					who = append(who, l)
				}
			}
			rows.Close()
			for _, l := range who {
				addNotif(l, req.Login, "approval_req", id, kindLabel(req.Kind))
			}
		}
		addUserLogR(req.Login, "approval_req", kindLabel(req.Kind), id)
		writeJSON(w, map[string]any{"id": id})
	})

	mux.HandleFunc("/data/approval/list", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, role, ok := authAccount(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		approver := role == "master" || isSeeAll(req.Login)
		type ap struct {
			ID        string     `json:"id"`
			Kind      string     `json:"kind"`
			Requester string     `json:"requester"`
			Name      string     `json:"requester_name"`
			Status    string     `json:"status"`
			CreatedAt time.Time  `json:"created_at"`
			DecidedBy string     `json:"decided_by"`
			UsedAt    *time.Time `json:"used_at"`
		}
		scan := func(rows *sql.Rows) []ap {
			out := []ap{}
			for rows.Next() {
				var a ap
				var db2, name sql.NullString
				var used sql.NullTime
				if rows.Scan(&a.ID, &a.Kind, &a.Requester, &name, &a.Status, &a.CreatedAt, &db2, &used) == nil {
					a.Name = name.String
					a.DecidedBy = db2.String
					if used.Valid {
						a.UsedAt = &used.Time
					}
					out = append(out, a)
				}
			}
			return out
		}
		incoming := []ap{}
		if approver {
			if rows, e := db.Query(`SELECT id,kind,requester,requester_name,status,created_at,decided_by,used_at FROM approvals WHERE org=$1 AND status='pending' AND requester<>$2 ORDER BY created_at DESC LIMIT 40`, org, req.Login); e == nil {
				incoming = scan(rows)
				rows.Close()
			}
		}
		mine := []ap{}
		if rows, e := db.Query(`SELECT id,kind,requester,requester_name,status,created_at,decided_by,used_at FROM approvals WHERE requester=$1 ORDER BY created_at DESC LIMIT 20`, req.Login); e == nil {
			mine = scan(rows)
			rows.Close()
		}
		writeJSON(w, map[string]any{"incoming": incoming, "mine": mine, "approver": approver})
	})

	mux.HandleFunc("/data/approval/decide", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, 405, "method")
			return
		}
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			Approve bool   `json:"approve"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		org, role, ok := authAccount(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		if !(role == "master" || isSeeAll(req.Login)) {
			writeErr(w, 403, "Недостаточно прав")
			return
		}
		var aorg, areq, akind, astatus string
		if db.QueryRow(`SELECT org,requester,kind,status FROM approvals WHERE id=$1`, req.ID).Scan(&aorg, &areq, &akind, &astatus) != nil || aorg != org {
			writeErr(w, 404, "not found")
			return
		}
		if areq == req.Login {
			writeErr(w, 400, "Нельзя одобрить свой запрос")
			return
		}
		if astatus != "pending" {
			writeErr(w, 400, "Запрос уже обработан")
			return
		}
		st := "denied"
		if req.Approve {
			st = "approved"
		}
		db.Exec(`UPDATE approvals SET status=$1, decided_by=$2, decided_at=now() WHERE id=$3`, st, req.Login, req.ID)
		addNotif(areq, req.Login, "approval_"+st, req.ID, kindLabel(akind))
		addUserLogR(req.Login, "approval_"+st, kindLabel(akind), req.ID)
		writeJSON(w, map[string]any{"ok": true})
	})

	mux.HandleFunc("/data/approval/consume", func(w http.ResponseWriter, r *http.Request) {
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
		db.Exec(`UPDATE approvals SET used_at=now() WHERE id=$1 AND requester=$2 AND status='approved' AND used_at IS NULL`, req.ID, req.Login)
		writeJSON(w, map[string]any{"ok": true})
	})

	// массовое удаление всех данных организации — только по одобренному запросу bulk_delete
	mux.HandleFunc("/data/mass_delete", func(w http.ResponseWriter, r *http.Request) {
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
		org, _, ok := authAccount(req.Login, req.AuthTok)
		if !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		var apID string
		if db.QueryRow(`SELECT id FROM approvals WHERE org=$1 AND requester=$2 AND kind='bulk_delete' AND status='approved' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, org, req.Login).Scan(&apID) != nil {
			writeErr(w, 403, "Нужно одобрение второго человека")
			return
		}
		// безвозвратное удаление всех данных организации: файлы с диска + записи + комментарии
		var ids []string
		if rows, e := db.Query(`SELECT id FROM records WHERE org=$1`, org); e == nil {
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
		}
		for _, id := range ids {
			if !strings.ContainsAny(id, "/.") {
				os.Remove(filepath.Join(dataDir, id))
			}
		}
		db.Exec(`DELETE FROM comments WHERE org=$1`, org)
		db.Exec(`DELETE FROM records WHERE org=$1`, org)
		n := int64(len(ids))
		db.Exec(`UPDATE approvals SET used_at=now() WHERE id=$1`, apID)
		addAudit(req.Login, "mass_delete", fmt.Sprintf("удалено безвозвратно: %d файлов", n), org)
		writeJSON(w, map[string]any{"ok": true, "count": n})
	})

	// список своих уведомлений + число непрочитанных
	mux.HandleFunc("/data/notifs", func(w http.ResponseWriter, r *http.Request) {
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
		rows, err := db.Query(`SELECT id, kind, COALESCE(rid,''), COALESCE(actor,''), COALESCE(text,''), at, read_at FROM notifications WHERE recipient=$1 ORDER BY at DESC LIMIT 60`, req.Login)
		if err != nil {
			writeErr(w, 500, "db")
			return
		}
		defer rows.Close()
		type nt struct {
			ID    string    `json:"id"`
			Kind  string    `json:"kind"`
			Rid   string    `json:"rid"`
			Actor string    `json:"actor"`
			Text  string    `json:"text"`
			At    time.Time `json:"at"`
			Read  bool      `json:"read"`
		}
		items := []nt{}
		var unread int64
		for rows.Next() {
			var x nt
			var ra sql.NullTime
			if rows.Scan(&x.ID, &x.Kind, &x.Rid, &x.Actor, &x.Text, &x.At, &ra) == nil {
				x.Read = ra.Valid
				if !x.Read {
					unread++
				}
				items = append(items, x)
			}
		}
		writeJSON(w, map[string]any{"items": items, "unread": unread})
	})

	// отметить уведомления прочитанными (одно по id или все)
	mux.HandleFunc("/data/notifs/read", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Login   string `json:"login"`
			AuthTok string `json:"auth_token"`
			ID      string `json:"id"`
			All     bool   `json:"all"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeErr(w, 400, "bad request")
			return
		}
		if _, _, ok := authAccount(req.Login, req.AuthTok); !ok {
			writeErr(w, 401, "unauthorized")
			return
		}
		if req.All {
			db.Exec(`UPDATE notifications SET read_at=now() WHERE recipient=$1 AND read_at IS NULL`, req.Login)
		} else if req.ID != "" {
			db.Exec(`UPDATE notifications SET read_at=now() WHERE recipient=$1 AND id=$2`, req.Login, req.ID)
		}
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

	// авто-очистка Корзины: файлы старше 30 дней стираются навсегда
	purgeOldTrash := func() {
		rows, err := db.Query(`SELECT id FROM records WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`)
		if err != nil {
			return
		}
		var ids []string
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		for _, id := range ids {
			if strings.ContainsAny(id, "/.") {
				continue
			}
			db.Exec(`DELETE FROM records WHERE id=$1`, id)
			db.Exec(`DELETE FROM comments WHERE record_id=$1`, id)
			os.Remove(filepath.Join(dataDir, id))
		}
		// журнал действий: хранить 180 дней
		db.Exec(`DELETE FROM user_log WHERE at < now() - interval '180 days'`)
		db.Exec(`DELETE FROM notifications WHERE at < now() - interval '180 days'`)
		if len(ids) > 0 {
			log.Printf("корзина: стёрто %d устаревших записей", len(ids))
		}
	}
	purgeOldTrash()
	go func() {
		t := time.NewTicker(6 * time.Hour)
		defer t.Stop()
		for range t.C {
			purgeOldTrash()
		}
	}()

	// планировщик резервных копий (ежедневно/еженедельно) — проверка раз в час
	go func() {
		t := time.NewTicker(1 * time.Hour)
		defer t.Stop()
		for range t.C {
			var sched string
			var last sql.NullTime
			if db.QueryRow(`SELECT schedule, last_run FROM backup_cfg WHERE id=1`).Scan(&sched, &last) != nil {
				continue
			}
			due := false
			if sched == "daily" && (!last.Valid || time.Since(last.Time) >= 24*time.Hour) {
				due = true
			}
			if sched == "weekly" && (!last.Valid || time.Since(last.Time) >= 7*24*time.Hour) {
				due = true
			}
			if due {
				runBackup()
			}
		}
	}()

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
