// Сервер лицензий (License Authority) — vendor-сторона.
// Единственное место, где код лицензии гасится ГЛОБАЛЬНО: активируется ровно один раз.
// Отдельно от сервера клиента (у клиента свой сервер данных, у нас — свой LA).
package main

import (
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

const vendorPubHex = "4fde975e6ad2c8328f7b8411d50e30c7a32a2641d97fc3953f044bcd71fef73c"
const laVersion = "0.1.0"

var (
	db    *sql.DB
	laKey ed25519.PrivateKey
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// проверка подписи вендора на коде лицензии
func verifyLicense(code string) (org, id string, ok bool) {
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
		Org string `json:"org"`
		Exp int64  `json:"exp"`
		ID  string `json:"id"`
	}
	if json.Unmarshal(payload, &p) != nil {
		return
	}
	if p.Exp != 0 && time.Now().Unix() > p.Exp {
		return
	}
	return p.Org, p.ID, true
}

// подписанный LA токен активации: base64url(payload).base64url(sig), payload={lid,at}
func signToken(licID string) string {
	payload, _ := json.Marshal(map[string]any{"lid": licID, "at": time.Now().Unix()})
	sig := ed25519.Sign(laKey, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func main() {
	keyHex := os.Getenv("LA_KEY")
	if keyHex == "" {
		log.Fatal("LA_KEY не задан")
	}
	seed, err := hex.DecodeString(strings.TrimSpace(keyHex))
	if err != nil || len(seed) != 32 {
		log.Fatal("LA_KEY должен быть 32 байта hex")
	}
	laKey = ed25519.NewKeyFromSeed(seed)

	addr := os.Getenv("SECUREVAULT_LA_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8099"
	}

	db, err = sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(5)
	if err = db.Ping(); err != nil {
		log.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE IF NOT EXISTS la_activations(
		id text PRIMARY KEY, org text, activated_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"service": "securevault-la", "version": laVersion, "ok": true})
	})

	// статус кода: валиден ли и активирован ли уже (глобально)
	mux.HandleFunc("/license", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			License string `json:"license"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeJSON(w, 400, map[string]any{"valid": false})
			return
		}
		org, licID, ok := verifyLicense(req.License)
		if !ok {
			writeJSON(w, 200, map[string]any{"valid": false, "used": false})
			return
		}
		var dummy string
		used := db.QueryRow(`SELECT id FROM la_activations WHERE id=$1`, licID).Scan(&dummy) == nil
		writeJSON(w, 200, map[string]any{"valid": true, "used": used, "org": org})
	})

	// активация: гасит код глобально и выдаёт подписанный токен. Второй раз — 409.
	mux.HandleFunc("/activate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "method"})
			return
		}
		var req struct {
			License string `json:"license"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			writeJSON(w, 400, map[string]string{"error": "bad request"})
			return
		}
		org, licID, ok := verifyLicense(req.License)
		if !ok {
			writeJSON(w, 400, map[string]string{"error": "Лицензия недействительна"})
			return
		}
		// атомарно: вставить id; если уже есть — активирован ранее
		res, err := db.Exec(`INSERT INTO la_activations(id,org) VALUES($1,$2) ON CONFLICT (id) DO NOTHING`, licID, org)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": "db"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeJSON(w, 409, map[string]string{"error": "Этот код уже активирован"})
			return
		}
		writeJSON(w, 200, map[string]any{"token": signToken(licID), "org": org})
	})

	cert := os.Getenv("TLS_CERT")
	if cert != "" {
		log.Printf("securevault-la (TLS) on %s", addr)
		log.Fatal(http.ListenAndServeTLS(addr, cert, os.Getenv("TLS_KEY"), mux))
	}
	log.Printf("securevault-la (plain) on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
