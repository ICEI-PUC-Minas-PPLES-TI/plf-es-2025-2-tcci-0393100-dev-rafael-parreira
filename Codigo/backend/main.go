// Servidor Stream Sentry (pacote main repartido por main.go e tests_api.go).
// A partir desta pasta execute: go run .
// Não use apenas "go run main.go" — isso exclui os outros ficheiros .go e falha a compilação.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"golang.org/x/crypto/bcrypt"
)

type user struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	PasswordHash string `json:"-"`
}

type userRow struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	Email        string `json:"email"`
	PasswordHash string `json:"password_hash"`
}

// usersSnapshot is the on-disk format (password hash included).
type usersSnapshot struct {
	NextID int       `json:"next_id"`
	Users  []userRow `json:"users"`
}

type authServer struct {
	jwtSecret      []byte
	users          []user
	nextID         int
	mu             sync.RWMutex
	testMu         sync.Mutex
	testRunning    bool
	testCancel     context.CancelFunc // cancela o contexto do exec do audit (finalizar teste)
	usersStorePath string
	persistToDisk  bool
}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(_ *http.Request) bool {
		return true
	},
}

// telemetryHub broadcasts WebSocket messages to all connected audit clients.
// Kept in main.go so `go run main.go` works (Go only compiles listed files).
type telemetryHub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]struct{}
}

var globalHub = &telemetryHub{
	clients: make(map[*websocket.Conn]struct{}),
}

func (h *telemetryHub) register(c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

func (h *telemetryHub) unregister(c *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c)
}

func (h *telemetryHub) broadcast(message []byte) {
	h.mu.RLock()
	clients := make([]*websocket.Conn, 0, len(h.clients))
	for client := range h.clients {
		clients = append(clients, client)
	}
	h.mu.RUnlock()

	for _, client := range clients {
		if err := client.WriteMessage(websocket.TextMessage, message); err != nil {
			_ = client.Close()
			h.unregister(client)
		}
	}
}

func usersStoreConfigFromEnv() (path string, persist bool) {
	raw := strings.TrimSpace(os.Getenv("USERS_FILE"))
	if strings.EqualFold(raw, "off") || raw == "-" {
		return "", false
	}
	if raw == "" {
		return "stream-sentry-users.json", true
	}
	return raw, true
}

func (s *authServer) loadUsersFromDisk() error {
	if !s.persistToDisk || s.usersStorePath == "" {
		return nil
	}
	data, err := os.ReadFile(s.usersStorePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var snap usersSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.users = make([]user, 0, len(snap.Users))
	for _, row := range snap.Users {
		s.users = append(s.users, user{
			ID:           row.ID,
			Name:         row.Name,
			Email:        row.Email,
			PasswordHash: row.PasswordHash,
		})
	}
	s.nextID = snap.NextID
	if s.nextID < 1 {
		s.nextID = 1
	}
	// Garante nextID acima do maior id carregado (arquivo antigo/corrompido).
	for _, u := range s.users {
		if u.ID >= s.nextID {
			s.nextID = u.ID + 1
		}
	}
	return nil
}

// Caller must hold s.mu (write lock).
func (s *authServer) saveUsersLocked() error {
	if !s.persistToDisk || s.usersStorePath == "" {
		return nil
	}
	var snap usersSnapshot
	snap.NextID = s.nextID
	for _, u := range s.users {
		snap.Users = append(snap.Users, userRow{
			ID: u.ID, Name: u.Name, Email: u.Email, PasswordHash: u.PasswordHash,
		})
	}
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.usersStorePath, data, 0o600)
}

func main() {
	_ = godotenv.Load()

	port := getEnvInt("PORT", 3001)
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev_secret_only"
	}

	storePath, persist := usersStoreConfigFromEnv()
	server := &authServer{
		jwtSecret:      []byte(secret),
		users:          make([]user, 0),
		nextID:         1,
		usersStorePath: storePath,
		persistToDisk:  persist,
	}
	if err := server.loadUsersFromDisk(); err != nil {
		log.Printf("aviso: não foi possível carregar usuários de %q: %v", storePath, err)
	}
	if persist {
		log.Printf("persistência de usuários: %s (defina USERS_FILE=off para desligar)", storePath)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", server.handleHealth)
	mux.HandleFunc("POST /auth/register", server.handleRegister)
	mux.HandleFunc("POST /auth/login", server.handleLogin)
	mux.HandleFunc("GET /auth/me", server.handleMe)
	mux.HandleFunc("POST /puppeteer/smoke", server.handlePuppeteerSmoke)
	mux.HandleFunc("POST /test/start", server.handleTestStart)
	mux.HandleFunc("POST /test/stop", server.handleTestStop)
	mux.HandleFunc("POST /test/control", server.handleTestControl)
	mux.HandleFunc("POST /test/pause", server.handleTestPause)
	mux.HandleFunc("POST /test/resume", server.handleTestResume)
	mux.HandleFunc("GET /tests/history", server.handleGetTestHistory)
	mux.HandleFunc("GET /reports/session/{id}", server.handleGetSessionReportDetail)
	mux.HandleFunc("GET /reports/export", server.handleExportReports)
	mux.HandleFunc("GET /ws/telemetry", server.handleWSTelemetry)

	addr := fmt.Sprintf(":%d", port)
	log.Printf("Stream Sentry Auth API (Go) running on %s", addr)
	if err := http.ListenAndServe(addr, withCORSMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}

func getEnvInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func withCORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (s *authServer) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *authServer) handleRegister(w http.ResponseWriter, r *http.Request) {
	type request struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}

	var payload request
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request body"})
		return
	}

	name := strings.TrimSpace(payload.Name)
	email := strings.ToLower(strings.TrimSpace(payload.Email))
	password := payload.Password

	if name == "" || email == "" || password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "name, email and password are required"})
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, existing := range s.users {
		if existing.Email == email {
			writeJSON(w, http.StatusConflict, map[string]string{"message": "email already in use"})
			return
		}
	}

	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": "failed to encrypt password"})
		return
	}

	newUser := user{
		ID:           s.nextID,
		Name:         name,
		Email:        email,
		PasswordHash: string(passwordHash),
	}
	s.nextID++
	s.users = append(s.users, newUser)

	if err := s.saveUsersLocked(); err != nil {
		log.Printf("persist users: %v", err)
	}

	token, err := s.generateToken(newUser)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": "failed to generate token"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"message": "user registered successfully",
		"token":   token,
		"user": map[string]any{
			"id":    newUser.ID,
			"name":  newUser.Name,
			"email": newUser.Email,
		},
	})
}

func (s *authServer) handleLogin(w http.ResponseWriter, r *http.Request) {
	type request struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}

	var payload request
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request body"})
		return
	}

	email := strings.ToLower(strings.TrimSpace(payload.Email))
	password := payload.Password
	if email == "" || password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "email and password are required"})
		return
	}

	// Cópia por valor: evita ponteiro para elemento de slice (inválido após append em outra goroutine).
	s.mu.RLock()
	var found user
	var have bool
	for _, u := range s.users {
		if u.Email == email {
			found = u
			have = true
			break
		}
	}
	s.mu.RUnlock()

	if !have {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(found.PasswordHash), []byte(password)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "invalid credentials"})
		return
	}

	token, err := s.generateToken(found)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": "failed to generate token"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "login successful",
		"token":   token,
		"user": map[string]any{
			"id":    found.ID,
			"name":  found.Name,
			"email": found.Email,
		},
	})
}

func (s *authServer) handleMe(w http.ResponseWriter, r *http.Request) {
	userID, err := s.validateBearerToken(r.Header.Get("Authorization"))
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, existing := range s.users {
		if existing.ID == userID {
			writeJSON(w, http.StatusOK, map[string]any{
				"user": map[string]any{
					"id":    existing.ID,
					"name":  existing.Name,
					"email": existing.Email,
				},
			})
			return
		}
	}

	writeJSON(w, http.StatusNotFound, map[string]string{"message": "user not found"})
}

func (s *authServer) handlePuppeteerSmoke(w http.ResponseWriter, r *http.Request) {
	type request struct {
		APIURL       string `json:"apiUrl"`
		AccessToken  string `json:"accessToken"`
		VirtualUsers int    `json:"virtualUsers"`
	}

	var payload request
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request body"})
		return
	}

	if err := validateTechnicalConfig(payload.APIURL, payload.AccessToken, payload.VirtualUsers); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	scriptPath := filepath.Join("puppeteer", "smoke.mjs")
	cmd := exec.CommandContext(
		ctx,
		"node",
		scriptPath,
		strings.TrimSpace(payload.APIURL),
		strings.TrimSpace(payload.AccessToken),
		strconv.Itoa(payload.VirtualUsers),
	)

	output, err := cmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{
			"message": "timeout running puppeteer smoke test",
		})
		return
	}

	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "failed to run puppeteer smoke test. install dependencies in backend/puppeteer",
			"error":   strings.TrimSpace(string(output)),
		})
		return
	}

	var parsed map[string]any
	if jsonErr := json.Unmarshal(output, &parsed); jsonErr != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"message": "puppeteer smoke test executed",
			"result": map[string]any{
				"rawOutput": strings.TrimSpace(string(output)),
			},
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "puppeteer smoke test executed",
		"result":  parsed,
	})
}

func (s *authServer) handleWSTelemetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "method not allowed"})
		return
	}

	rawToken := r.URL.Query().Get("token")
	if rawToken == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "missing token query parameter"})
		return
	}

	if _, err := s.validateBearerToken("Bearer " + rawToken); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
	}

	globalHub.register(conn)
	defer globalHub.unregister(conn)

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

func (s *authServer) handleTestStart(w http.ResponseWriter, r *http.Request) {
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}

	type request struct {
		APIURL       string            `json:"apiUrl"`
		AccessToken  string            `json:"accessToken"`
		VirtualUsers int               `json:"virtualUsers"`
		Chaos        *chaosProfileJSON `json:"chaos,omitempty"`
	}

	var payload request
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "invalid request body"})
		return
	}

	if err := validateTechnicalConfig(payload.APIURL, payload.AccessToken, payload.VirtualUsers); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}

	s.testMu.Lock()
	if s.testRunning {
		s.testMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"message": "a test is already running"})
		return
	}
	s.testRunning = true
	s.testMu.Unlock()

	apiURL := strings.TrimSpace(payload.APIURL)
	token := strings.TrimSpace(payload.AccessToken)
	users := payload.VirtualUsers

	cp := chaosProfileJSON{Profile: "off"}
	if payload.Chaos != nil && strings.TrimSpace(payload.Chaos.Profile) != "" {
		cp.Profile = strings.TrimSpace(payload.Chaos.Profile)
	}
	if err := writeInitialAuditControl(users, cp); err != nil {
		log.Printf("aviso: escrever control.json: %v", err)
	}

	sessionID := newSessionID()
	go s.runAuditTest(apiURL, token, users, sessionID)

	writeJSON(w, http.StatusAccepted, map[string]string{
		"message":   "test started; connect to WebSocket /ws/telemetry for live audit",
		"sessionId": sessionID,
	})
}

func (s *authServer) handleTestStop(w http.ResponseWriter, r *http.Request) {
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}

	s.testMu.Lock()
	if !s.testRunning || s.testCancel == nil {
		s.testMu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]string{"message": "nenhum teste em execução"})
		return
	}
	stop := s.testCancel
	s.testMu.Unlock()

	stop()

	b, _ := json.Marshal(map[string]any{
		"type":    "telemetry",
		"event":   "test_stopped",
		"reason":  "requested",
		"message": "teste interrompido pelo utilizador",
		"ts":      time.Now().UTC().Format(time.RFC3339Nano),
	})
	globalHub.broadcast(b)

	writeJSON(w, http.StatusOK, map[string]string{"message": "teste em encerramento"})
}

func (s *authServer) runAuditTest(apiURL string, accessToken string, virtualUsers int, sessionID string) {
	ctx, cancel := context.WithCancel(context.Background())
	timer := time.AfterFunc(25*time.Minute, func() { cancel() })

	s.testMu.Lock()
	s.testCancel = cancel
	s.testMu.Unlock()

	startedAt := time.Now()

	defer func() {
		timer.Stop()
		cancel()
		s.testMu.Lock()
		s.testRunning = false
		s.testCancel = nil
		s.testMu.Unlock()
	}()

	scriptPath := filepath.Join("puppeteer", "run-audit.mjs")
	cmd := exec.CommandContext(
		ctx,
		"node",
		scriptPath,
		apiURL,
		accessToken,
		strconv.Itoa(virtualUsers),
	)
	cmd.Env = append(os.Environ(),
		"TEST_SESSION_ID="+sessionID,
		"TEST_STARTED_AT="+startedAt.UTC().Format(time.RFC3339Nano),
		"STREAM_SENTRY_POOL=1",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		b, _ := json.Marshal(map[string]any{"type": "telemetry", "event": "error", "message": "failed to open stdout pipe"})
		globalHub.broadcast(b)
		return
	}

	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		b, _ := json.Marshal(map[string]any{"type": "telemetry", "event": "error", "message": err.Error()})
		globalHub.broadcast(b)
		return
	}

	scanner := bufio.NewScanner(stdout)
	buffer := make([]byte, 0, 256*1024)
	scanner.Buffer(buffer, 1024*1024)

	reportPath := sessionTelemetryNDJSONPath(sessionID)
	if err := os.MkdirAll(filepath.Dir(reportPath), 0o755); err != nil {
		log.Printf("aviso: criar pasta de relatórios: %v", err)
	}
	repFile, repErr := os.OpenFile(reportPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if repErr != nil {
		log.Printf("aviso: abrir ficheiro de telemetria NDJSON: %v", repErr)
	}
	if repFile != nil {
		defer repFile.Close()
	}

	rollup := newRollupAccumulator()

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		copyLine := append([]byte(nil), line...)
		globalHub.broadcast(copyLine)
		if repFile != nil {
			if _, werr := repFile.Write(line); werr != nil {
				log.Printf("aviso: escrever relatório: %v", werr)
			} else {
				_, _ = repFile.Write([]byte("\n"))
			}
		}
		rollup.FeedLine(line)
	}

	if scanErr := scanner.Err(); scanErr != nil {
		b, _ := json.Marshal(map[string]any{"type": "telemetry", "event": "error", "message": scanErr.Error()})
		globalHub.broadcast(b)
	}

	waitErr := cmd.Wait()
	endedAt := time.Now()
	dur := endedAt.Sub(startedAt).Seconds()

	rec := TestHistoryRecord{
		ID:           sessionID,
		StartedAt:    startedAt,
		EndedAt:      endedAt,
		DurationSec:  dur,
		APIURL:       apiURL,
		VirtualUsers: virtualUsers,
		ExitOK:       waitErr == nil,
		Summary:      rollup.ToSummary(),
	}
	if repFile != nil {
		rec.TelemetryFile = filepath.ToSlash(filepath.Join("puppeteer", "reports", sessionID+".ndjson"))
	}
	if ctrl, err := readAuditControl(); err == nil {
		rec.ChaosProfile = strings.TrimSpace(ctrl.Chaos.Profile)
		if rec.ChaosProfile == "" {
			rec.ChaosProfile = "off"
		}
	}
	if waitErr != nil {
		rec.ErrorMessage = waitErr.Error()
		b, _ := json.Marshal(map[string]any{"type": "telemetry", "event": "error", "message": waitErr.Error()})
		globalHub.broadcast(b)
	}
	appendTestHistory(rec)

	summary, _ := json.Marshal(map[string]any{
		"type":         "telemetry",
		"event":        "server_audit_summary",
		"sessionId":    sessionID,
		"durationSec":  dur,
		"startedAt":    startedAt.UTC().Format(time.RFC3339Nano),
		"endedAt":      endedAt.UTC().Format(time.RFC3339Nano),
		"virtualUsers": virtualUsers,
		"exitOk":       waitErr == nil,
	})
	globalHub.broadcast(summary)
}

func (s *authServer) generateToken(u user) (string, error) {
	claims := jwt.MapClaims{
		"sub":   u.ID,
		"email": u.Email,
		"exp":   time.Now().Add(2 * time.Hour).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func subjectIDFromClaims(claims jwt.MapClaims) (int, error) {
	raw, ok := claims["sub"]
	if !ok {
		return 0, errors.New("sessão inválida; faça login novamente")
	}
	switch v := raw.(type) {
	case float64:
		return int(v), nil
	case int64:
		return int(v), nil
	case int:
		return v, nil
	case string:
		n, err := strconv.Atoi(v)
		if err != nil {
			return 0, errors.New("sessão inválida; faça login novamente")
		}
		return n, nil
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, errors.New("sessão inválida; faça login novamente")
		}
		return int(n), nil
	default:
		return 0, errors.New("sessão inválida; faça login novamente")
	}
}

func (s *authServer) validateBearerToken(authHeader string) (int, error) {
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return 0, errors.New("missing bearer token")
	}

	rawToken := strings.TrimPrefix(authHeader, "Bearer ")
	parsed, err := jwt.Parse(rawToken, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return 0, errors.New("sessão expirada; faça login novamente")
		}
		return 0, errors.New("sessão inválida; faça login novamente")
	}
	if !parsed.Valid {
		return 0, errors.New("sessão inválida; faça login novamente")
	}

	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return 0, errors.New("sessão inválida; faça login novamente")
	}

	return subjectIDFromClaims(claims)
}

func validateTechnicalConfig(apiURL string, accessToken string, virtualUsers int) error {
	trimmedURL := strings.TrimSpace(apiURL)
	parsedURL, err := url.Parse(trimmedURL)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" {
		return errors.New("invalid apiUrl")
	}

	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return errors.New("apiUrl must use http or https")
	}

	if strings.TrimSpace(accessToken) == "" {
		return errors.New("accessToken is required")
	}

	if virtualUsers < 1 || virtualUsers > 50 {
		return errors.New("virtualUsers must be between 1 and 50")
	}

	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}
