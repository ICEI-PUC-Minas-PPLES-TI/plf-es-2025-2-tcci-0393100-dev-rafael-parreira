package main

import "testing"

func TestMinMaxAvg(t *testing.T) {
	if minMaxAvg(nil) != nil {
		t.Fatalf("esperava nil para fatia vazia")
	}
	r := minMaxAvg([]float64{10, 20, 30})
	if r == nil || r.Min != 10 || r.Max != 30 || r.Avg != 20 {
		t.Fatalf("min/max/avg incorretos: %+v", r)
	}
	single := minMaxAvg([]float64{5})
	if single == nil || single.Min != 5 || single.Max != 5 || single.Avg != 5 {
		t.Fatalf("valor único incorreto: %+v", single)
	}
}

func TestRollupAccumulatorHTTP(t *testing.T) {
	a := newRollupAccumulator()
	a.FeedLine([]byte(`{"type":"telemetry","event":"request"}`))
	a.FeedLine([]byte(`{"type":"telemetry","event":"response","status":200}`))
	a.FeedLine([]byte(`{"type":"telemetry","event":"response","status":404}`))
	a.FeedLine([]byte(`{"type":"telemetry","event":"request_failed"}`))
	// Linhas que devem ser ignoradas:
	a.FeedLine([]byte(`{"type":"log","event":"request"}`)) // não é telemetry
	a.FeedLine([]byte(`{invalido`))                        // JSON inválido

	s := a.ToSummary()
	if s.HTTP.Requests != 1 {
		t.Fatalf("requests esperado 1, obtido %d", s.HTTP.Requests)
	}
	if s.HTTP.Responses != 2 {
		t.Fatalf("responses esperado 2, obtido %d", s.HTTP.Responses)
	}
	if s.HTTP.Failures != 1 {
		t.Fatalf("failures esperado 1, obtido %d", s.HTTP.Failures)
	}
	if s.HTTP.StatusHistogram["200"] != 1 || s.HTTP.StatusHistogram["404"] != 1 {
		t.Fatalf("histograma de status incorreto: %+v", s.HTTP.StatusHistogram)
	}
}

func TestRollupAccumulatorWebRTC(t *testing.T) {
	a := newRollupAccumulator()
	line := `{"type":"telemetry","event":"webrtc_stats","elapsedSec":2.0,` +
		`"summary":{"candidatePair":{"currentRoundTripTimeMs":50},` +
		`"inboundVideo":{"jitter":0.02}}}`
	a.FeedLine([]byte(line))

	s := a.ToSummary()
	if s.WebRTC.StatsSamples != 1 {
		t.Fatalf("statsSamples esperado 1, obtido %d", s.WebRTC.StatsSamples)
	}
	if s.WebRTC.RttMs == nil || s.WebRTC.RttMs.Avg != 50 {
		t.Fatalf("RTT médio esperado 50, obtido %+v", s.WebRTC.RttMs)
	}
	// jitter 0.02 s deve virar 20 ms
	if s.WebRTC.JitterVideoMs == nil || s.WebRTC.JitterVideoMs.Avg != 20 {
		t.Fatalf("jitter médio esperado 20 ms, obtido %+v", s.WebRTC.JitterVideoMs)
	}
	if len(s.WebRTC.LatencySeries) != 1 {
		t.Fatalf("série de latência esperada com 1 ponto, obtida %d", len(s.WebRTC.LatencySeries))
	}
}
