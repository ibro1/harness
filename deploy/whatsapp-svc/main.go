// WhatsApp sidecar for the DeepSeek Harness.
//
// A standalone whatsmeow service that owns the WhatsApp multidevice connection
// and its durable session (SQLite via a pure-Go driver, so the binary is static
// and needs no CGO). It exposes a tiny token-authenticated HTTP API on loopback
// that the harness's Node plugin, settings card and MCP tools drive:
//
//	GET  /status               connection + login state, and the pairing QR
//	POST /login                (re)start QR pairing when not logged in
//	POST /logout               unlink this device
//	POST /send   {to,text}     send a text message (to = JID | phone | name)
//	GET  /messages?chat=&limit recent stored messages for a chat
//	GET  /chats?limit          recent chats, newest first
//	GET  /contacts?query=      address-book matches
//	GET  /resolve?query=       best JID for a name or number
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
	waProto "go.mau.fi/whatsmeow/proto/waE2E"
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

// service holds the single WhatsApp client and the latest pairing QR.
type service struct {
	client *whatsmeow.Client
	db     *sql.DB
	log    waLog.Logger

	mu       sync.RWMutex
	qrCode   string
	qrExpiry time.Time
	loggedIn bool
}

var digits = regexp.MustCompile(`\D`)

func main() {
	addr := env("WA_SVC_ADDR", "127.0.0.1:8003")
	token := strings.TrimSpace(os.Getenv("WA_SVC_TOKEN"))
	dbPath := env("WA_DB_PATH", "whatsapp.db")
	if token == "" {
		fmt.Fprintln(os.Stderr, "wa-svc: WA_SVC_TOKEN is required")
		os.Exit(2)
	}

	ctx := context.Background()
	logLevel := env("WA_LOG", "WARN")
	dbLog := waLog.Stdout("wa-db", logLevel, true)

	db, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: open db:", err)
		os.Exit(1)
	}
	container := sqlstore.NewWithDB(db, "sqlite3", dbLog)
	if err = container.Upgrade(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: store upgrade:", err)
		os.Exit(1)
	}
	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: get device:", err)
		os.Exit(1)
	}

	svc := &service{
		client: whatsmeow.NewClient(deviceStore, waLog.Stdout("wa-client", logLevel, true)),
		db:     db,
		log:    waLog.Stdout("wa-svc", logLevel, true),
	}
	if err = svc.initMessageTable(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: message table:", err)
		os.Exit(1)
	}
	svc.client.AddEventHandler(svc.onEvent)

	if svc.client.Store.ID == nil {
		go svc.startPairing(ctx)
	} else {
		if err = svc.client.Connect(); err != nil {
			svc.log.Errorf("connect: %v", err)
		}
		svc.setLoggedIn(true)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/status", svc.auth(token, svc.handleStatus))
	mux.HandleFunc("/login", svc.auth(token, svc.handleLogin))
	mux.HandleFunc("/logout", svc.auth(token, svc.handleLogout))
	mux.HandleFunc("/send", svc.auth(token, svc.handleSend))
	mux.HandleFunc("/messages", svc.auth(token, svc.handleMessages))
	mux.HandleFunc("/chats", svc.auth(token, svc.handleChats))
	mux.HandleFunc("/contacts", svc.auth(token, svc.handleContacts))
	mux.HandleFunc("/resolve", svc.auth(token, svc.handleResolve))

	svc.log.Infof("wa-svc listening on %s", addr)
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err = server.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "wa-svc: serve:", err)
		os.Exit(1)
	}
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
		case "code":
			s.mu.Lock()
			s.qrCode = evt.Code
			s.qrExpiry = time.Now().Add(evt.Timeout)
			s.mu.Unlock()
		case "success":
			s.mu.Lock()
			s.qrCode = ""
			s.mu.Unlock()
			s.setLoggedIn(true)
			return
		default:
			s.log.Infof("qr event: %s", evt.Event)
		}
	}
}

func (s *service) setLoggedIn(v bool) {
	s.mu.Lock()
	s.loggedIn = v
	s.mu.Unlock()
}

func (s *service) onEvent(evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		s.storeMessage(v)
	case *events.Connected:
		s.setLoggedIn(true)
	case *events.LoggedOut:
		s.setLoggedIn(false)
		go s.startPairing(context.Background())
	case *events.PairSuccess:
		s.setLoggedIn(true)
	}
}

// ---- message store ----

func (s *service) initMessageTable(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
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
	`)
	return err
}

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
		`INSERT INTO messages(chat_jid, sender_jid, sender_name, from_me, ts, body) VALUES(?,?,?,?,?,?)`,
		m.Info.Chat.String(), m.Info.Sender.String(), m.Info.PushName, fromMe, m.Info.Timestamp.Unix(), body,
	)
	if err != nil {
		s.log.Warnf("store message: %v", err)
		return
	}
	// Cap the table so a busy account cannot grow it without bound.
	_, _ = s.db.Exec(`DELETE FROM messages WHERE id < (SELECT MAX(id) - 5000 FROM messages)`)
}

// ---- HTTP helpers ----

func (s *service) auth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Errorf("handler panic on %s: %v", r.URL.Path, rec)
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

// loggedIn reports whether a device is paired; store reads that touch contacts
// panic before pairing, so guard them.
func (s *service) isLoggedIn() bool {
	return s.client.Store.ID != nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ---- handlers ----

func (s *service) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	qr, expiry, loggedIn := s.qrCode, s.qrExpiry, s.loggedIn
	s.mu.RUnlock()
	resp := map[string]any{
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
	writeJSON(w, http.StatusOK, resp)
}

func (s *service) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.client.Store.ID != nil {
		writeJSON(w, http.StatusOK, map[string]any{"alreadyLoggedIn": true})
		return
	}
	if !s.client.IsConnected() {
		go s.startPairing(context.Background())
	}
	writeJSON(w, http.StatusOK, map[string]any{"pairing": true})
}

func (s *service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.client.Logout(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	s.setLoggedIn(false)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "to": jid.String(), "name": name})
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
	q := `SELECT chat_jid, sender_jid, sender_name, from_me, ts, body FROM messages`
	args := []any{}
	if chatJID != "" {
		q += ` WHERE chat_jid = ?`
		args = append(args, chatJID)
	}
	q += ` ORDER BY ts DESC LIMIT ?`
	args = append(args, limit)
	s.writeMessageRows(w, q, args)
}

func (s *service) handleChats(w http.ResponseWriter, r *http.Request) {
	limit := parseLimit(r, 30, 200)
	q := `SELECT chat_jid, sender_jid, sender_name, from_me, ts, body FROM messages
	      WHERE id IN (SELECT MAX(id) FROM messages GROUP BY chat_jid)
	      ORDER BY ts DESC LIMIT ?`
	s.writeMessageRows(w, q, []any{limit})
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
