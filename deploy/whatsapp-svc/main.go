// WhatsApp sidecar for the DeepSeek Harness.
//
// A standalone whatsmeow service that owns the WhatsApp multidevice connections
// and their durable sessions (SQLite via a pure-Go driver, so the binary is
// static and needs no CGO). It exposes a tiny token-authenticated HTTP API on
// loopback that the harness's Node plugin, settings card and MCP tools drive:
//
//	GET  /status               connection + login state, and the pairing QR
//	POST /login                (re)start QR pairing when not logged in
//	POST /logout               unlink this device
//	POST /send   {to,text}     send a text message (to = JID | phone | name)
//	GET  /messages?chat=&limit recent stored messages for a chat
//	GET  /chats?limit          recent chats, newest first
//	GET  /contacts?query=      address-book matches
//	GET  /resolve?query=       best JID for a name or number
//	GET  /sessions             every session this service holds
//
// # Sessions
//
// The service holds MANY WhatsApp accounts, one per session key, so a
// multi-tenant caller can give each of its own tenants a separate linked phone.
// A session is selected per request with `?session=<key>` or the `X-WA-Session`
// header, and requests that name none use WA_DEFAULT_SESSION. That default is
// what the harness settings card drives, so a single-operator deployment
// behaves exactly as it did when this service held one account.
//
// Everything is keyed on that session: the QR and pairing state, the whatsmeow
// client, the contact store, and the stored message log. One SQLite file holds
// them all — whatsmeow's sqlstore is itself multi-device — with a `wa_sessions`
// table mapping each key to the JID it paired.
//
// A key is an opaque string chosen by the caller (a workspace id, say). It is
// never shown to WhatsApp; it only names which device this service should use.
//
// The service persists incoming/outgoing text into its own `messages` table so
// "check my messages" works; whatsmeow itself is event-based and keeps no log.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	waProto "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	_ "modernc.org/sqlite"
)

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// sessionKeyPattern bounds what a caller may use as a key. Keys reach SQL as
// parameters and never as identifiers, so this is about keeping them readable
// and loggable rather than about injection.
var sessionKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// service holds one WhatsApp account: its client, its pairing state, and the
// key it is filed under.
type service struct {
	key    string
	hub    *hub
	client *whatsmeow.Client
	db     *sql.DB
	log    waLog.Logger

	mu        sync.RWMutex
	qrCode    string
	qrExpiry  time.Time
	loggedIn  bool
	pairError string // last pairing failure reason, surfaced to the card via /status
}

// hub owns the shared store and the set of live sessions.
type hub struct {
	db        *sql.DB
	container *sqlstore.Container
	log       waLog.Logger
	logLevel  string

	mu       sync.Mutex
	sessions map[string]*service
}

var digits = regexp.MustCompile(`\D`)

func main() {
	addr := env("WA_SVC_ADDR", "127.0.0.1:8003")
	token := strings.TrimSpace(os.Getenv("WA_SVC_TOKEN"))
	dbPath := env("WA_DB_PATH", "whatsapp.db")
	defaultKey := env("WA_DEFAULT_SESSION", "default")
	if token == "" {
		fmt.Fprintln(os.Stderr, "wa-svc: WA_SVC_TOKEN is required")
		os.Exit(2)
	}
	if !sessionKeyPattern.MatchString(defaultKey) {
		fmt.Fprintln(os.Stderr, "wa-svc: WA_DEFAULT_SESSION must match", sessionKeyPattern)
		os.Exit(2)
	}

	ctx := context.Background()
	logLevel := env("WA_LOG", "WARN")
	dbLog := waLog.Stdout("wa-db", logLevel, true)

	// Several whatsmeow clients share this file once more than one session is
	// live, and each keeps up a chatty stream of small writes (app-state
	// patches, signal sessions, contacts). Three settings make that safe:
	//
	//   WAL          readers no longer block the writer, which is most of the
	//                contention between sessions.
	//   NORMAL       WAL's usual durability pairing: far fewer fsyncs, so the
	//                write lock is held for a fraction of the time.
	//   busy_timeout a real ceiling for the waits that remain.
	//
	// None of those is sufficient on its own. A connection that holds a read
	// transaction and then needs to write gets SQLITE_BUSY *immediately* rather
	// than waiting, because backing off could only deadlock — busy_timeout does
	// not apply to it. Capping the pool at one connection removes that case
	// entirely: with a single connection there is no cross-connection
	// contention to resolve. Writes serialize either way in SQLite, so the cost
	// is latency on concurrent reads, not throughput on writes.
	db, err := sql.Open("sqlite", "file:"+dbPath+
		"?_pragma=foreign_keys(1)"+
		"&_pragma=busy_timeout(15000)"+
		"&_pragma=journal_mode(WAL)"+
		"&_pragma=synchronous(NORMAL)")
	if err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: open db:", err)
		os.Exit(1)
	}
	db.SetMaxOpenConns(1)
	container := sqlstore.NewWithDB(db, "sqlite3", dbLog)
	if err = container.Upgrade(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: store upgrade:", err)
		os.Exit(1)
	}

	// Present as an ordinary WhatsApp Web (Chrome) client and give the linked
	// device a readable label in the phone's linked-devices list. WhatsApp is
	// less tolerant of clients that advertise an unknown platform, so identify
	// as a mainstream desktop browser rather than the library default
	// ("whatsmeow"/UNKNOWN). This is process-wide; every session shares it.
	store.DeviceProps.Os = proto.String("DeepSeek Harness")
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()

	h := &hub{
		db:        db,
		container: container,
		log:       waLog.Stdout("wa-svc", logLevel, true),
		logLevel:  logLevel,
		sessions:  map[string]*service{},
	}
	if err = h.initTables(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: init tables:", err)
		os.Exit(1)
	}
	if err = h.adoptLegacyDevice(ctx, defaultKey); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: adopt existing device:", err)
		os.Exit(1)
	}
	if err = h.resumeAll(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: resume sessions:", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	route := func(path string, fn func(*service, http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(path, h.auth(token, h.withSession(defaultKey, fn)))
	}
	route("/status", (*service).handleStatus)
	route("/login", (*service).handleLogin)
	route("/logout", (*service).handleLogout)
	route("/send", (*service).handleSend)
	route("/messages", (*service).handleMessages)
	route("/chats", (*service).handleChats)
	route("/contacts", (*service).handleContacts)
	route("/resolve", (*service).handleResolve)
	mux.HandleFunc("/sessions", h.auth(token, h.handleSessions))

	h.log.Infof("wa-svc listening on %s (default session %q)", addr, defaultKey)
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err = server.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: serve:", err)
		os.Exit(1)
	}
}

// ---- hub: schema, session lifecycle ----

func (h *hub) initTables(ctx context.Context) error {
	if _, err := h.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS wa_sessions (
			key TEXT PRIMARY KEY,
			jid TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chat_jid TEXT NOT NULL,
			sender_jid TEXT NOT NULL,
			sender_name TEXT,
			from_me INTEGER NOT NULL,
			ts INTEGER NOT NULL,
			body TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, ts);
	`); err != nil {
		return err
	}
	// Sessions arrived after the first release, so an existing messages table
	// has no session column. Add it with a default rather than rebuilding: the
	// rows that predate sessions all belong to the one account there was.
	var hasSessionKey int
	if err := h.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'session_key'`,
	).Scan(&hasSessionKey); err != nil {
		return err
	}
	if hasSessionKey == 0 {
		if _, err := h.db.ExecContext(ctx,
			`ALTER TABLE messages ADD COLUMN session_key TEXT NOT NULL DEFAULT 'default'`,
		); err != nil {
			return err
		}
		h.log.Infof("messages: added session_key; existing rows kept as 'default'")
	}
	_, err := h.db.ExecContext(ctx,
		`CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_key, ts)`)
	return err
}

// adoptLegacyDevice files a device paired before sessions existed under the
// default key, so an operator who has already linked their phone stays linked
// across this upgrade instead of being asked to rescan.
func (h *hub) adoptLegacyDevice(ctx context.Context, defaultKey string) error {
	var mapped int
	if err := h.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM wa_sessions`).Scan(&mapped); err != nil {
		return err
	}
	if mapped > 0 {
		return nil
	}
	devices, err := h.container.GetAllDevices(ctx)
	if err != nil {
		return err
	}
	for _, d := range devices {
		if d.ID == nil {
			continue
		}
		if _, err = h.db.ExecContext(ctx,
			`INSERT OR IGNORE INTO wa_sessions(key, jid, created_at) VALUES(?,?,?)`,
			defaultKey, d.ID.String(), time.Now().Unix(),
		); err != nil {
			return err
		}
		h.log.Infof("adopted existing device %s as session %q", d.ID.String(), defaultKey)
		return nil
	}
	return nil
}

// resumeAll reconnects every session that already has a paired device.
func (h *hub) resumeAll(ctx context.Context) error {
	rows, err := h.db.QueryContext(ctx, `SELECT key FROM wa_sessions WHERE jid IS NOT NULL AND jid != ''`)
	if err != nil {
		return err
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err == nil {
			keys = append(keys, key)
		}
	}
	for _, key := range keys {
		svc, err := h.session(ctx, key)
		if err != nil {
			h.log.Errorf("resume %q: %v", key, err)
			continue
		}
		h.log.Infof("resumed session %q", svc.key)
	}
	return nil
}

// session returns the live service for a key, loading or creating its device on
// first use. A session whose device is already paired is connected here; one
// that is not waits for /login rather than opening a socket nobody asked for.
func (h *hub) session(ctx context.Context, key string) (*service, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if svc, ok := h.sessions[key]; ok {
		return svc, nil
	}

	var jidStr sql.NullString
	err := h.db.QueryRowContext(ctx, `SELECT jid FROM wa_sessions WHERE key = ?`, key).Scan(&jidStr)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if err == sql.ErrNoRows {
		if _, err = h.db.ExecContext(ctx,
			`INSERT OR IGNORE INTO wa_sessions(key, jid, created_at) VALUES(?,NULL,?)`,
			key, time.Now().Unix(),
		); err != nil {
			return nil, err
		}
	}

	var device *store.Device
	if jidStr.Valid && jidStr.String != "" {
		jid, parseErr := types.ParseJID(jidStr.String)
		if parseErr != nil {
			return nil, fmt.Errorf("session %q has an unparseable jid %q: %w", key, jidStr.String, parseErr)
		}
		if device, err = h.container.GetDevice(ctx, jid); err != nil {
			return nil, fmt.Errorf("session %q device %s: %w", key, jid, err)
		}
	}
	if device == nil {
		// Either brand new, or its device row was deleted; start a fresh one.
		device = h.container.NewDevice()
	}

	svc := &service{
		key:    key,
		hub:    h,
		client: whatsmeow.NewClient(device, waLog.Stdout("wa-client:"+key, h.logLevel, true)),
		db:     h.db,
		log:    waLog.Stdout("wa-svc:"+key, h.logLevel, true),
	}
	svc.client.AddEventHandler(svc.onEvent)
	h.sessions[key] = svc

	if svc.client.Store.ID != nil {
		if err = svc.client.Connect(); err != nil {
			svc.log.Errorf("connect: %v", err)
		}
		svc.setLoggedIn(true)
	}
	return svc, nil
}

// bindJID records which account a session paired, so the next start reloads the
// same device instead of handing the caller an unlinked one.
func (h *hub) bindJID(key string, jid types.JID) {
	if _, err := h.db.Exec(
		`INSERT INTO wa_sessions(key, jid, created_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET jid = excluded.jid`,
		key, jid.String(), time.Now().Unix(),
	); err != nil {
		h.log.Errorf("bind %q -> %s: %v", key, jid, err)
	}
}

// forget drops a session's device mapping and its live client, so the next
// /login starts a clean pairing rather than reusing a logged-out device.
func (h *hub) forget(key string) {
	h.mu.Lock()
	delete(h.sessions, key)
	h.mu.Unlock()
	if _, err := h.db.Exec(`UPDATE wa_sessions SET jid = NULL WHERE key = ?`, key); err != nil {
		h.log.Errorf("forget %q: %v", key, err)
	}
}

// ---- HTTP middleware ----

func (h *hub) auth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				h.log.Errorf("handler panic on %s: %v", r.URL.Path, rec)
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "internal error"})
			}
		}()
		got := r.Header.Get("X-WA-Token")
		if got == "" {
			got = r.URL.Query().Get("token")
		}
		if got != token {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "bad token"})
			return
		}
		next(w, r)
	}
}

// withSession resolves the session a request names and hands it to the handler.
// A request that names none gets the default, which is what keeps the harness
// settings card working unchanged.
func (h *hub) withSession(defaultKey string, next func(*service, http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimSpace(r.Header.Get("X-WA-Session"))
		if key == "" {
			key = strings.TrimSpace(r.URL.Query().Get("session"))
		}
		if key == "" {
			key = defaultKey
		}
		if !sessionKeyPattern.MatchString(key) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid session key"})
			return
		}
		svc, err := h.session(r.Context(), key)
		if err != nil {
			h.log.Errorf("session %q: %v", key, err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		next(svc, w, r)
	}
}

func (h *hub) handleSessions(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT key, COALESCE(jid, '') FROM wa_sessions ORDER BY created_at`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var key, jid string
		if err = rows.Scan(&key, &jid); err != nil {
			continue
		}
		entry := map[string]any{"key": key, "linked": jid != ""}
		if jid != "" {
			entry["jid"] = jid
		}
		h.mu.Lock()
		svc, live := h.sessions[key]
		h.mu.Unlock()
		entry["live"] = live
		if live {
			entry["connected"] = svc.client.IsConnected()
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ---- pairing / connection ----

func (s *service) startPairing(ctx context.Context) {
	qrChan, err := s.client.GetQRChannel(ctx)
	if err != nil {
		s.log.Errorf("qr channel: %v", err)
		return
	}
	if err = s.client.Connect(); err != nil {
		s.log.Errorf("connect: %v", err)
		return
	}
	for evt := range qrChan {
		switch evt.Event {
		case whatsmeow.QRChannelEventCode:
			s.mu.Lock()
			s.qrCode = evt.Code
			s.qrExpiry = time.Now().Add(evt.Timeout)
			s.pairError = "" // a fresh code clears any earlier failure
			s.mu.Unlock()
		case "success":
			s.mu.Lock()
			s.qrCode = ""
			s.pairError = ""
			s.mu.Unlock()
			s.setLoggedIn(true)
			if id := s.client.Store.ID; id != nil {
				s.hub.bindJID(s.key, *id)
			}
			return
		case whatsmeow.QRChannelEventPasskeyResponse:
			// WhatsApp's passkey-handoff linking: the server asked us to confirm
			// the pairing code. Without this call the socket is torn down and the
			// phone reports "couldn't link device". The channel stays open.
			if err := s.client.SendPasskeyConfirmation(ctx); err != nil {
				s.setPairError(fmt.Sprintf("passkey confirmation failed: %v", err))
				s.log.Errorf("passkey confirmation: %v", err)
			}
		case whatsmeow.QRChannelEventPasskeyRequest:
			// The account is being linked through WhatsApp's WebAuthn passkey
			// flow, which requires an authenticator response whatsmeow does not
			// generate for us. Tell the operator to use the QR path instead.
			s.setPairError(`this account is using WhatsApp's passkey linking, which this integration cannot complete; on the phone choose "Link with QR code instead"`)
			s.log.Warnf("pairing requested a WebAuthn passkey; cannot complete")
		case whatsmeow.QRChannelEventError:
			s.failPairing(fmt.Sprintf("pairing error: %v", evt.Error))
			s.log.Errorf("pairing error: %v", evt.Error)
			return
		case "err-client-outdated":
			s.failPairing("WhatsApp rejected this client as outdated; the whatsmeow build needs updating")
			s.log.Errorf("pairing rejected: client outdated")
			return
		case "err-scanned-without-multidevice":
			// The same QR can still be scanned after this, so keep looping.
			s.setPairError("scanned without multi-device enabled; enable multi-device on the phone, then rescan")
			s.log.Warnf("scanned without multidevice enabled")
		case "err-unexpected-state":
			s.failPairing("unexpected pairing state (the device may already be paired); reopen the card")
			s.log.Warnf("unexpected pairing state")
			return
		case "timeout":
			s.failPairing("the QR code expired before pairing completed; press Link to get a fresh code")
			s.log.Warnf("pairing timed out")
			return
		default:
			s.log.Warnf("unhandled qr event: %s", evt.Event)
		}
	}
}

func (s *service) setPairError(msg string) {
	s.mu.Lock()
	s.pairError = msg
	s.mu.Unlock()
}

// failPairing records a terminal failure AND clears the now-dead QR, so the
// card stops rendering an expired code and re-shows the Link button. Leaving a
// stale QR up invites the user to keep scanning a dead code, which feeds
// WhatsApp's "try again later" rate limit.
func (s *service) failPairing(msg string) {
	s.mu.Lock()
	s.qrCode = ""
	s.qrExpiry = time.Time{}
	s.pairError = msg
	s.mu.Unlock()
}

func (s *service) setLoggedIn(v bool) {
	s.mu.Lock()
	s.loggedIn = v
	s.mu.Unlock()
}

func (s *service) onEvent(evt any) {
	switch v := evt.(type) {
	case *events.Message:
		s.storeMessage(v)
	case *events.Connected:
		s.setLoggedIn(true)
	case *events.LoggedOut:
		s.setLoggedIn(false)
		s.hub.forget(s.key)
	case *events.PairSuccess:
		s.setLoggedIn(true)
		s.hub.bindJID(s.key, v.ID)
	}
}

// ---- message store ----

func (s *service) storeMessage(m *events.Message) {
	body := m.Message.GetConversation()
	if body == "" && m.Message.GetExtendedTextMessage() != nil {
		body = m.Message.GetExtendedTextMessage().GetText()
	}
	if body == "" {
		return // skip non-text (media/reactions) in v1
	}
	fromMe := 0
	if m.Info.IsFromMe {
		fromMe = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO messages(session_key, chat_jid, sender_jid, sender_name, from_me, ts, body) VALUES(?,?,?,?,?,?,?)`,
		s.key, m.Info.Chat.String(), m.Info.Sender.String(), m.Info.PushName, fromMe, m.Info.Timestamp.Unix(), body,
	)
	if err != nil {
		s.log.Warnf("store message: %v", err)
		return
	}
	// Cap each session's log so one busy account cannot grow the table without
	// bound, and cannot evict another session's history either.
	_, _ = s.db.Exec(
		`DELETE FROM messages WHERE session_key = ? AND id < (
			SELECT MAX(id) - 5000 FROM messages WHERE session_key = ?
		)`, s.key, s.key)
}

// loggedIn reports whether a device is paired; store reads that touch contacts
// panic before pairing, so guard them.
func (s *service) isLoggedIn() bool {
	return s.client.Store.ID != nil
}

// ---- handlers ----

func (s *service) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	qr, expiry, loggedIn, pairErr := s.qrCode, s.qrExpiry, s.loggedIn, s.pairError
	s.mu.RUnlock()
	resp := map[string]any{
		"session":   s.key,
		"loggedIn":  loggedIn,
		"connected": s.client.IsConnected(),
	}
	if id := s.client.Store.ID; id != nil {
		resp["jid"] = id.String()
		resp["name"] = s.client.Store.PushName
	}
	if !loggedIn && qr != "" {
		resp["qr"] = qr
		resp["qrExpiresInSec"] = int(time.Until(expiry).Seconds())
	}
	if !loggedIn && pairErr != "" {
		resp["pairError"] = pairErr
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *service) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.client.Store.ID != nil {
		writeJSON(w, http.StatusOK, map[string]any{"alreadyLoggedIn": true, "session": s.key})
		return
	}
	if !s.client.IsConnected() {
		go s.startPairing(context.Background())
	}
	writeJSON(w, http.StatusOK, map[string]any{"pairing": true, "session": s.key})
}

func (s *service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.client.Logout(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	s.setLoggedIn(false)
	s.hub.forget(s.key)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": s.key})
}

type sendReq struct {
	To   string `json:"to"`
	Text string `json:"text"`
}

func (s *service) handleSend(w http.ResponseWriter, r *http.Request) {
	var req sendReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.To) == "" || req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "need {to, text}"})
		return
	}
	jid, name, err := s.resolve(r.Context(), req.To)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	msg := &waProto.Message{Conversation: proto.String(req.Text)}
	if _, err = s.client.SendMessage(r.Context(), jid, msg); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "to": jid.String(), "name": name, "session": s.key})
}

func (s *service) handleMessages(w http.ResponseWriter, r *http.Request) {
	chatQuery := strings.TrimSpace(r.URL.Query().Get("chat"))
	limit := parseLimit(r, 30, 200)
	var chatJID string
	if chatQuery != "" {
		jid, _, err := s.resolve(r.Context(), chatQuery)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		chatJID = jid.String()
	}
	q := `SELECT chat_jid, sender_jid, sender_name, from_me, ts, body FROM messages WHERE session_key = ?`
	args := []any{s.key}
	if chatJID != "" {
		q += ` AND chat_jid = ?`
		args = append(args, chatJID)
	}
	q += ` ORDER BY ts DESC LIMIT ?`
	args = append(args, limit)
	s.writeMessageRows(w, q, args)
}

func (s *service) handleChats(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 30, 200)
	q := `SELECT chat_jid, sender_jid, sender_name, from_me, ts, body FROM messages
	      WHERE session_key = ?
	        AND id IN (SELECT MAX(id) FROM messages WHERE session_key = ? GROUP BY chat_jid)
	      ORDER BY ts DESC LIMIT ?`
	s.writeMessageRows(w, q, []any{s.key, s.key, limit})
}

func (s *service) writeMessageRows(w http.ResponseWriter, q string, args []any) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var chat, sender, name, body string
		var fromMe int
		var ts int64
		if err = rows.Scan(&chat, &sender, &name, &fromMe, &ts, &body); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"chat": chat, "sender": sender, "senderName": name,
			"fromMe": fromMe == 1, "ts": ts, "body": body,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": out})
}

func (s *service) handleContacts(w http.ResponseWriter, r *http.Request) {
	if !s.isLoggedIn() {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "not linked; scan the QR first", "contacts": []any{}})
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("query")))
	contacts, err := s.client.Store.Contacts.GetAllContacts(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	out := []map[string]any{}
	for jid, info := range contacts {
		name := contactName(info)
		if query != "" && !strings.Contains(strings.ToLower(name), query) && !strings.Contains(jid.User, query) {
			continue
		}
		out = append(out, map[string]any{"jid": jid.String(), "name": name, "number": jid.User})
		if len(out) >= 200 {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"contacts": out})
}

func (s *service) handleResolve(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("query"))
	jid, name, err := s.resolve(r.Context(), query)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jid": jid.String(), "name": name})
}

// ---- resolution ----

// resolve turns a JID, a phone number, or a contact name into a real JID.
func (s *service) resolve(ctx context.Context, query string) (types.JID, string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return types.JID{}, "", fmt.Errorf("empty query")
	}
	if strings.Contains(query, "@") {
		jid, err := types.ParseJID(query)
		return jid, "", err
	}
	// A phone number: digits only (optionally a leading +).
	if onlyDigits(query) {
		number := digits.ReplaceAllString(query, "")
		results, err := s.client.IsOnWhatsApp(ctx, []string{number})
		if err == nil {
			for _, res := range results {
				if res.IsIn {
					return res.JID, "", nil
				}
			}
		}
		return types.NewJID(number, types.DefaultUserServer), "", nil
	}
	// A name: search the address book (case-insensitive contains).
	if !s.isLoggedIn() {
		return types.JID{}, "", fmt.Errorf("not linked; scan the QR first")
	}
	contacts, err := s.client.Store.Contacts.GetAllContacts(ctx)
	if err != nil {
		return types.JID{}, "", err
	}
	lc := strings.ToLower(query)
	for jid, info := range contacts {
		name := contactName(info)
		if strings.Contains(strings.ToLower(name), lc) {
			return jid, name, nil
		}
	}
	return types.JID{}, "", fmt.Errorf("no contact matches %q", query)
}

func contactName(info types.ContactInfo) string {
	if info.FullName != "" {
		return info.FullName
	}
	if info.BusinessName != "" {
		return info.BusinessName
	}
	return info.PushName
}

func onlyDigits(s string) bool {
	trimmed := strings.TrimPrefix(strings.TrimSpace(s), "+")
	if trimmed == "" {
		return false
	}
	for _, r := range trimmed {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func parseLimit(r *http.Request, def, max int) int {
	v, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || v <= 0 {
		return def
	}
	if v > max {
		return max
	}
	return v
}
