package main

import (
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestValidateTechnicalConfig(t *testing.T) {
	cases := []struct {
		name         string
		apiURL       string
		accessToken  string
		virtualUsers int
		wantErr      bool
	}{
		{"alvo genérico com token", "https://api.exemplo.com", "tok123", 10, false},
		{"alvo genérico sem token", "https://api.exemplo.com", "", 10, true},
		{"jitsi dispensa token", "https://meet.jit.si/SalaTeste", "", 10, false},
		{"whereby dispensa token", "https://stream.whereby.com/sala", "", 4, false},
		{"zoom dispensa token", "https://zoom.us/j/123456", "", 5, false},
		{"usuarios abaixo do limite", "https://meet.jit.si/X", "", 0, true},
		{"usuarios acima do limite", "https://meet.jit.si/X", "", 51, true},
		{"limite superior valido", "https://meet.jit.si/X", "", 50, false},
		{"url sem esquema", "meet.jit.si/X", "", 10, true},
		{"esquema invalido", "ftp://meet.jit.si/X", "", 10, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTechnicalConfig(tc.apiURL, tc.accessToken, tc.virtualUsers)
			if tc.wantErr && err == nil {
				t.Fatalf("esperava erro, mas recebeu nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("não esperava erro, recebeu: %v", err)
			}
		})
	}
}

func TestSubjectIDFromClaims(t *testing.T) {
	if id, err := subjectIDFromClaims(jwt.MapClaims{"sub": float64(42)}); err != nil || id != 42 {
		t.Fatalf("sub float64: id=%d err=%v", id, err)
	}
	if id, err := subjectIDFromClaims(jwt.MapClaims{"sub": "7"}); err != nil || id != 7 {
		t.Fatalf("sub string numérica: id=%d err=%v", id, err)
	}
	if _, err := subjectIDFromClaims(jwt.MapClaims{}); err == nil {
		t.Fatalf("esperava erro quando 'sub' ausente")
	}
	if _, err := subjectIDFromClaims(jwt.MapClaims{"sub": "abc"}); err == nil {
		t.Fatalf("esperava erro com 'sub' não numérico")
	}
}

func TestNewSessionID(t *testing.T) {
	id := newSessionID()
	if len(id) < len("sess-")+1 || id[:5] != "sess-" {
		t.Fatalf("formato inesperado de sessionID: %q", id)
	}
}
