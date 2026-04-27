package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TestHistoryRecord entrada persistida após cada execução do audit.
type TestHistoryRecord struct {
	ID           string    `json:"id"`
	StartedAt    time.Time `json:"startedAt"`
	EndedAt      time.Time `json:"endedAt"`
	DurationSec  float64   `json:"durationSec"`
	APIURL       string    `json:"apiUrl"`
	VirtualUsers int       `json:"virtualUsers"`
	ExitOK       bool      `json:"exitOk"`
	ErrorMessage string    `json:"errorMessage,omitempty"`
	// TelemetryFile caminho relativo ao cwd do servidor (NDJSON linha a linha = log completo).
	TelemetryFile string `json:"telemetryFile,omitempty"`
	ChaosProfile  string `json:"chaosProfile,omitempty"`
	Summary       *TelemetrySessionSummary `json:"summary,omitempty"`
}

type chaosProfileJSON struct {
	Profile string `json:"profile"`
}

type auditControlFile struct {
	Paused             bool             `json:"paused"`
	TargetVirtualUsers int              `json:"targetVirtualUsers"`
	Chaos              chaosProfileJSON `json:"chaos"`
}

var (
	controlFileMu  sync.Mutex
	testsHistoryMu sync.Mutex
)

func testsHistoryPath() string {
	if p := strings.TrimSpace(os.Getenv("TESTS_HISTORY_FILE")); p != "" {
		return p
	}
	return "stream-sentry-test-history.json"
}

func controlFilePath() string {
	return filepath.Join("puppeteer", "control.json")
}

func telemetryReportsDir() string {
	if p := strings.TrimSpace(os.Getenv("TELEMETRY_REPORTS_DIR")); p != "" {
		return p
	}
	return filepath.Join("puppeteer", "reports")
}

func sessionTelemetryNDJSONPath(sessionID string) string {
	return filepath.Join(telemetryReportsDir(), sessionID+".ndjson")
}

func loadNDJSONEventLines(path string) ([]json.RawMessage, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(raw, []byte("\n"))
	out := make([]json.RawMessage, 0, len(lines))
	for _, line := range lines {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		// validar JSON
		if !json.Valid(line) {
			continue
		}
		out = append(out, json.RawMessage(append([]byte(nil), line...)))
	}
	return out, nil
}

func newSessionID() string {
	return fmt.Sprintf("sess-%d", time.Now().UnixNano())
}

func writeInitialAuditControl(targetUsers int, chaos chaosProfileJSON) error {
	dir := filepath.Dir(controlFilePath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	prof := chaos.Profile
	if prof == "" {
		prof = "off"
	}
	c := auditControlFile{
		Paused:             false,
		TargetVirtualUsers: targetUsers,
		Chaos:              chaosProfileJSON{Profile: prof},
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(controlFilePath(), raw, 0o644)
}

func readAuditControl() (auditControlFile, error) {
	var z auditControlFile
	raw, err := os.ReadFile(controlFilePath())
	if err != nil {
		return z, err
	}
	if err := json.Unmarshal(raw, &z); err != nil {
		return z, err
	}
	return z, nil
}

func mergeWriteAuditControl(patch map[string]any) error {
	controlFileMu.Lock()
	defer controlFileMu.Unlock()

	cur, err := readAuditControl()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			cur = auditControlFile{TargetVirtualUsers: 1, Chaos: chaosProfileJSON{Profile: "off"}}
		} else {
			return err
		}
	}
	if v, ok := patch["paused"].(bool); ok {
		cur.Paused = v
	}
	if v, ok := patch["targetVirtualUsers"].(float64); ok {
		cur.TargetVirtualUsers = int(v)
	}
	if v, ok := patch["targetVirtualUsers"].(int); ok {
		cur.TargetVirtualUsers = v
	}
	if m, ok := patch["chaos"].(map[string]any); ok {
		if p, ok := m["profile"].(string); ok {
			cur.Chaos.Profile = p
		}
	}

	raw, err := json.MarshalIndent(cur, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(controlFilePath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(controlFilePath(), raw, 0o644)
}

func appendTestHistory(rec TestHistoryRecord) {
	testsHistoryMu.Lock()
	defer testsHistoryMu.Unlock()

	path := testsHistoryPath()
	var list []TestHistoryRecord
	if raw, err := os.ReadFile(path); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &list)
	}
	list = append(list, rec)
	raw, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, raw, 0o600)
}

func loadTestHistory() ([]TestHistoryRecord, error) {
	path := testsHistoryPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []TestHistoryRecord{}, nil
		}
		return nil, err
	}
	var list []TestHistoryRecord
	if len(raw) == 0 {
		return list, nil
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	return list, nil
}

func findSessionRecord(list []TestHistoryRecord, id string) *TestHistoryRecord {
	id = strings.TrimSpace(id)
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

func (s *authServer) handleGetTestHistory(w http.ResponseWriter, r *http.Request) {
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}
	list, err := loadTestHistory()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": list})
}

// handleGetSessionReportDetail GET /reports/session/{id} — metadados + todos os eventos NDJSON parseados.
func (s *authServer) handleGetSessionReportDetail(w http.ResponseWriter, r *http.Request) {
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "id da sessão em falta"})
		return
	}
	list, err := loadTestHistory()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	rec := findSessionRecord(list, id)
	if rec == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "sessão não encontrada no histórico"})
		return
	}
	path := sessionTelemetryNDJSONPath(id)
	events, err := loadNDJSONEventLines(path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"session":     rec,
			"events":      []json.RawMessage{},
			"eventCount":  0,
			"telemetryNote": "ficheiro NDJSON não encontrado ou vazio: " + err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session":    rec,
		"events":     events,
		"eventCount": len(events),
	})
}

func (s *authServer) handleExportReports(w http.ResponseWriter, r *http.Request) {
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "json"
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("sessionId"))
	includeEvents := r.URL.Query().Get("includeEvents") == "1" || r.URL.Query().Get("detailed") == "1"

	list, err := loadTestHistory()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}

	if sessionID != "" {
		rec := findSessionRecord(list, sessionID)
		if rec == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "sessão não encontrada"})
			return
		}
		if format == "json" {
			payload := map[string]any{"exportVersion": 2, "session": rec}
			if includeEvents {
				events, errEv := loadNDJSONEventLines(sessionTelemetryNDJSONPath(sessionID))
				if errEv != nil {
					payload["events"] = []json.RawMessage{}
					payload["telemetryError"] = errEv.Error()
				} else {
					payload["events"] = events
					payload["eventCount"] = len(events)
				}
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="stream-sentry-sessao-`+sessionID+`.json"`)
			_ = json.NewEncoder(w).Encode(payload)
			return
		}
		if format == "csv" && includeEvents {
			path := sessionTelemetryNDJSONPath(sessionID)
			events, errEv := loadNDJSONEventLines(path)
			if errEv != nil {
				writeJSON(w, http.StatusNotFound, map[string]string{"message": errEv.Error()})
				return
			}
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="stream-sentry-eventos-`+sessionID+`.csv"`)
			cw := csv.NewWriter(w)
			_ = cw.Write([]string{"index", "event", "elapsedSec", "sessionId", "json"})
			for i, raw := range events {
				ev, el, sid, compact := flattenEventCSVFields(raw)
				_ = cw.Write([]string{
					strconv.Itoa(i),
					ev,
					el,
					sid,
					compact,
				})
			}
			cw.Flush()
			return
		}
		if format == "csv" && !includeEvents {
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="stream-sentry-sessao-`+sessionID+`.csv"`)
			cw := csv.NewWriter(w)
			_ = cw.Write([]string{
				"id", "startedAt", "endedAt", "durationSec", "apiUrl", "virtualUsers", "exitOk", "errorMessage",
				"chaosProfile", "telemetryFile",
				"httpRequests", "httpResponses", "httpFailures",
				"webrtcStatsSamples", "rttAvgMs", "rttMinMs", "rttMaxMs", "jitterAvgMs", "jitterMinMs", "jitterMaxMs",
			})
			_ = cw.Write(sessionRecordToCSVRow(*rec))
			cw.Flush()
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"message": "com sessionId use format=json ou format=csv (com ou sem includeEvents=1)",
		})
		return
	}

	switch format {
	case "json":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="stream-sentry-relatorio.json"`)
		if !includeEvents {
			_ = json.NewEncoder(w).Encode(list)
			return
		}
		// Todas as sessões com eventos completos (pode ser pesado).
		out := make([]map[string]any, 0, len(list))
		for _, rec := range list {
			row := map[string]any{"session": rec}
			events, errEv := loadNDJSONEventLines(sessionTelemetryNDJSONPath(rec.ID))
			if errEv != nil {
				row["events"] = []json.RawMessage{}
				row["telemetryError"] = errEv.Error()
			} else {
				row["events"] = events
				row["eventCount"] = len(events)
			}
			out = append(out, row)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"exportVersion": 2,
			"generatedAt":   time.Now().UTC().Format(time.RFC3339Nano),
			"sessions":      out,
		})
	case "csv":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="stream-sentry-relatorio.csv"`)
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{
			"id", "startedAt", "endedAt", "durationSec", "apiUrl", "virtualUsers", "exitOk", "errorMessage",
			"chaosProfile", "telemetryFile",
			"httpRequests", "httpResponses", "httpFailures",
			"webrtcStatsSamples", "rttAvgMs", "rttMinMs", "rttMaxMs", "jitterAvgMs", "jitterMinMs", "jitterMaxMs",
		})
		for _, e := range list {
			_ = cw.Write(sessionRecordToCSVRow(e))
		}
		cw.Flush()
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "formato: json ou csv; use sessionId e includeEvents=1 para detalhe"})
	}
}

func flattenEventCSVFields(raw json.RawMessage) (event, elapsedSec, sessionID, jsonCompact string) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", "", "", string(raw)
	}
	if ev, ok := m["event"].(string); ok {
		event = ev
	}
	if v, ok := m["elapsedSec"].(float64); ok {
		elapsedSec = strconv.FormatFloat(v, 'f', 3, 64)
	}
	if v, ok := m["sessionId"].(string); ok {
		sessionID = v
	}
	b, err := json.Marshal(m)
	if err != nil {
		jsonCompact = string(raw)
	} else {
		jsonCompact = string(b)
	}
	return
}

func sessionRecordToCSVRow(e TestHistoryRecord) []string {
	rttAvg, rttMin, rttMax := "", "", ""
	jAvg, jMin, jMax := "", "", ""
	req, resp, fail := "", "", ""
	wc := ""
	if e.Summary != nil {
		req = strconv.Itoa(e.Summary.HTTP.Requests)
		resp = strconv.Itoa(e.Summary.HTTP.Responses)
		fail = strconv.Itoa(e.Summary.HTTP.Failures)
		wc = strconv.Itoa(e.Summary.WebRTC.StatsSamples)
		if e.Summary.WebRTC.RttMs != nil {
			rttAvg = strconv.FormatFloat(e.Summary.WebRTC.RttMs.Avg, 'f', 2, 64)
			rttMin = strconv.FormatFloat(e.Summary.WebRTC.RttMs.Min, 'f', 2, 64)
			rttMax = strconv.FormatFloat(e.Summary.WebRTC.RttMs.Max, 'f', 2, 64)
		}
		if e.Summary.WebRTC.JitterVideoMs != nil {
			jAvg = strconv.FormatFloat(e.Summary.WebRTC.JitterVideoMs.Avg, 'f', 2, 64)
			jMin = strconv.FormatFloat(e.Summary.WebRTC.JitterVideoMs.Min, 'f', 2, 64)
			jMax = strconv.FormatFloat(e.Summary.WebRTC.JitterVideoMs.Max, 'f', 2, 64)
		}
	}
	return []string{
		e.ID,
		e.StartedAt.Format(time.RFC3339),
		e.EndedAt.Format(time.RFC3339),
		strconv.FormatFloat(e.DurationSec, 'f', 3, 64),
		e.APIURL,
		strconv.Itoa(e.VirtualUsers),
		strconv.FormatBool(e.ExitOK),
		e.ErrorMessage,
		e.ChaosProfile,
		e.TelemetryFile,
		req, resp, fail,
		wc, rttAvg, rttMin, rttMax, jAvg, jMin, jMax,
	}
}

type testControlRequest struct {
	Paused             *bool             `json:"paused"`
	TargetVirtualUsers *int              `json:"targetVirtualUsers"`
	Chaos              *chaosProfileJSON `json:"chaos"`
}

func (s *authServer) handleTestControl(w http.ResponseWriter, r *http.Request) {
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}
	s.testMu.Lock()
	run := s.testRunning
	s.testMu.Unlock()
	if !run {
		writeJSON(w, http.StatusConflict, map[string]string{"message": "nenhum teste em execução"})
		return
	}
	var body testControlRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "corpo JSON inválido"})
		return
	}
	patch := map[string]any{}
	if body.Paused != nil {
		patch["paused"] = *body.Paused
	}
	if body.TargetVirtualUsers != nil {
		u := *body.TargetVirtualUsers
		if u < 1 {
			u = 1
		}
		if u > 50 {
			u = 50
		}
		patch["targetVirtualUsers"] = u
	}
	if body.Chaos != nil && body.Chaos.Profile != "" {
		patch["chaos"] = map[string]any{"profile": body.Chaos.Profile}
	}
	if len(patch) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "nada para atualizar"})
		return
	}
	if err := mergeWriteAuditControl(patch); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "controlo atualizado"})
}


func (s *authServer) handleTestPause(w http.ResponseWriter, r *http.Request) {
	_ = r
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}
	s.testMu.Lock()
	run := s.testRunning
	s.testMu.Unlock()
	if !run {
		writeJSON(w, http.StatusConflict, map[string]string{"message": "nenhum teste em execução"})
		return
	}
	if err := mergeWriteAuditControl(map[string]any{"paused": true}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "pausa pedida"})
}

func (s *authServer) handleTestResume(w http.ResponseWriter, r *http.Request) {
	_ = r
	if _, err := s.validateBearerToken(r.Header.Get("Authorization")); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": err.Error()})
		return
	}
	s.testMu.Lock()
	run := s.testRunning
	s.testMu.Unlock()
	if !run {
		writeJSON(w, http.StatusConflict, map[string]string{"message": "nenhum teste em execução"})
		return
	}
	if err := mergeWriteAuditControl(map[string]any{"paused": false}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "retomada pedida"})
}
