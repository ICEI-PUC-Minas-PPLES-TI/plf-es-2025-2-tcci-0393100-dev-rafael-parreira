import { describe, it, expect } from "vitest";
import { isWherebyUrl, isJitsiUrl, isTokenOptional, validateConfig } from "./validation";
import type { ConfigForm } from "./types";

describe("detecção de provedor", () => {
  it("reconhece URLs do Whereby", () => {
    expect(isWherebyUrl("https://stream.whereby.com/sala")).toBe(true);
    expect(isWherebyUrl("https://whereby.com/x")).toBe(true);
    expect(isWherebyUrl("https://exemplo.com")).toBe(false);
    expect(isWherebyUrl("texto inválido")).toBe(false);
  });

  it("reconhece URLs do Jitsi", () => {
    expect(isJitsiUrl("https://meet.jit.si/Sala")).toBe(true);
    expect(isJitsiUrl("https://jitsi.exemplo.com/x")).toBe(true);
    expect(isJitsiUrl("https://exemplo.com")).toBe(false);
  });

  it("torna o token opcional para Jitsi e Whereby", () => {
    expect(isTokenOptional("https://meet.jit.si/X")).toBe(true);
    expect(isTokenOptional("https://stream.whereby.com/x")).toBe(true);
    expect(isTokenOptional("https://api.exemplo.com")).toBe(false);
  });
});

describe("validateConfig", () => {
  const base: ConfigForm = {
    apiUrl: "https://meet.jit.si/Sala",
    accessToken: "",
    virtualUsers: 10,
    callDurationSec: 120
  };

  it("aceita uma configuração Jitsi válida", () => {
    const r = validateConfig(base);
    expect(r.virtualUsers).toBe(10);
    expect(r.callDurationSec).toBe(120);
  });

  it("rejeita usuários fora do intervalo 1–50", () => {
    expect(() => validateConfig({ ...base, virtualUsers: 0 })).toThrow();
    expect(() => validateConfig({ ...base, virtualUsers: 51 })).toThrow();
  });

  it("limita o Whereby a 4 usuários", () => {
    const whereby = { ...base, apiUrl: "https://stream.whereby.com/sala" };
    expect(() => validateConfig({ ...whereby, virtualUsers: 5 })).toThrow();
    expect(validateConfig({ ...whereby, virtualUsers: 4 }).virtualUsers).toBe(4);
  });

  it("exige duração da chamada entre 90 e 1800 s", () => {
    expect(() => validateConfig({ ...base, callDurationSec: 89 })).toThrow();
    expect(() => validateConfig({ ...base, callDurationSec: 1801 })).toThrow();
  });

  it("exige token para alvos genéricos", () => {
    expect(() => validateConfig({ ...base, apiUrl: "https://api.exemplo.com", accessToken: "" })).toThrow();
    expect(
      validateConfig({ ...base, apiUrl: "https://api.exemplo.com", accessToken: "tok" }).accessToken
    ).toBe("tok");
  });

  it("rejeita URL inválida ou sem http/https", () => {
    expect(() => validateConfig({ ...base, apiUrl: "ftp://meet.jit.si/x" })).toThrow();
    expect(() => validateConfig({ ...base, apiUrl: "sem-esquema" })).toThrow();
  });
});
