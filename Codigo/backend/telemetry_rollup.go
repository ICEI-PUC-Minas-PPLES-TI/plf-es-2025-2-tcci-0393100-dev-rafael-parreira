package main

import (
	"encoding/json"
	"math"
	"strconv"
)

const (
	maxRttSamples     = 20000
	maxLatencySeries  = 4000
	maxJitterSamples  = 20000
)

// TelemetrySessionSummary agrega contadores e amostras a partir das linhas NDJSON do runner.
type TelemetrySessionSummary struct {
	EventCounts map[string]int `json:"eventCounts"`
	HTTP        struct {
		Requests          int            `json:"requests"`
		Responses         int            `json:"responses"`
		Failures          int            `json:"failures"`
		StatusHistogram   map[string]int `json:"statusHistogram,omitempty"`
	} `json:"http"`
	WebRTC struct {
		StatsSamples  int `json:"statsSamples"`
		RttMs         *MinMaxAvg `json:"rttMs,omitempty"`
		JitterVideoMs *MinMaxAvg `json:"jitterVideoMs,omitempty"`
		// LatencySeries: tempo × RTT / jitter (amostras webrtc_stats, limitada).
		LatencySeries []LatencySample `json:"latencySeries,omitempty"`
	} `json:"webrtc"`
}

// MinMaxAvg estatísticas simples.
type MinMaxAvg struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
	Avg float64 `json:"avg"`
}

// LatencySample um ponto no tempo para gráficos / relatórios.
type LatencySample struct {
	ElapsedSec float64  `json:"elapsedSec"`
	RttMs      *float64 `json:"rttMs,omitempty"`
	JitterMs   *float64 `json:"jitterVideoMs,omitempty"`
}

type rollupAccumulator struct {
	eventCounts  map[string]int
	statusHist   map[string]int
	httpReq      int
	httpResp     int
	httpFail     int
	rttVals      []float64
	jitterVals   []float64
	series       []LatencySample
	webrtcSamples int
}

func newRollupAccumulator() *rollupAccumulator {
	return &rollupAccumulator{
		eventCounts: make(map[string]int),
		statusHist:  make(map[string]int),
	}
}

func (a *rollupAccumulator) FeedLine(line []byte) {
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		return
	}
	if t, _ := m["type"].(string); t != "telemetry" {
		return
	}
	ev, _ := m["event"].(string)
	if ev == "" {
		return
	}
	a.eventCounts[ev]++

	switch ev {
	case "request":
		a.httpReq++
	case "response":
		a.httpResp++
		if st, ok := m["status"].(float64); ok {
			k := strconv.Itoa(int(st))
			a.statusHist[k]++
		}
	case "request_failed":
		a.httpFail++
	case "webrtc_stats":
		a.ingestWebRTC(m)
	}
}

func (a *rollupAccumulator) ingestWebRTC(m map[string]any) {
	a.webrtcSamples++
	elapsed, _ := m["elapsedSec"].(float64)

	summary, ok := m["summary"].(map[string]any)
	if !ok {
		return
	}

	var rttPtr *float64
	if cp, ok := summary["candidatePair"].(map[string]any); ok {
		if v, ok := cp["currentRoundTripTimeMs"].(float64); ok && v > 0 && !math.IsNaN(v) {
			rtt := v
			rttPtr = &rtt
			if len(a.rttVals) < maxRttSamples {
				a.rttVals = append(a.rttVals, rtt)
			}
		}
	}
	if rttPtr == nil {
		if ri, ok := summary["remoteInbound"].(map[string]any); ok {
			if v, ok := ri["videoRoundTripTimeMs"].(float64); ok && v > 0 && !math.IsNaN(v) {
				rtt := v
				rttPtr = &rtt
				if len(a.rttVals) < maxRttSamples {
					a.rttVals = append(a.rttVals, rtt)
				}
			} else if v, ok := ri["audioRoundTripTimeMs"].(float64); ok && v > 0 && !math.IsNaN(v) {
				rtt := v
				rttPtr = &rtt
				if len(a.rttVals) < maxRttSamples {
					a.rttVals = append(a.rttVals, rtt)
				}
			}
		}
	}

	var jitterPtr *float64
	if iv, ok := summary["inboundVideo"].(map[string]any); ok {
		if j, ok := iv["jitter"].(float64); ok && j >= 0 && !math.IsNaN(j) {
			jms := j * 1000
			jitterPtr = &jms
			if len(a.jitterVals) < maxJitterSamples {
				a.jitterVals = append(a.jitterVals, jms)
			}
		}
	}

	if len(a.series) < maxLatencySeries {
		a.series = append(a.series, LatencySample{
			ElapsedSec: elapsed,
			RttMs:      rttPtr,
			JitterMs:   jitterPtr,
		})
	}
}

func minMaxAvg(vals []float64) *MinMaxAvg {
	if len(vals) == 0 {
		return nil
	}
	minV := vals[0]
	maxV := vals[0]
	var sum float64
	for _, v := range vals {
		if v < minV {
			minV = v
		}
		if v > maxV {
			maxV = v
		}
		sum += v
	}
	return &MinMaxAvg{Min: minV, Max: maxV, Avg: sum / float64(len(vals))}
}

func (a *rollupAccumulator) ToSummary() *TelemetrySessionSummary {
	out := &TelemetrySessionSummary{
		EventCounts: map[string]int{},
	}
	for k, v := range a.eventCounts {
		out.EventCounts[k] = v
	}
	out.HTTP.Requests = a.httpReq
	out.HTTP.Responses = a.httpResp
	out.HTTP.Failures = a.httpFail
	if len(a.statusHist) > 0 {
		out.HTTP.StatusHistogram = map[string]int{}
		for k, v := range a.statusHist {
			out.HTTP.StatusHistogram[k] = v
		}
	}
	out.WebRTC.StatsSamples = a.webrtcSamples
	out.WebRTC.RttMs = minMaxAvg(a.rttVals)
	jma := minMaxAvg(a.jitterVals)
	out.WebRTC.JitterVideoMs = jma
	if len(a.series) > 0 {
		out.WebRTC.LatencySeries = append([]LatencySample(nil), a.series...)
	}
	return out
}
