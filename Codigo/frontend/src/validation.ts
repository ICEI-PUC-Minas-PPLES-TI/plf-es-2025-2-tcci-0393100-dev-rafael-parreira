// Funções puras de validação e detecção de provedor, isoladas para reuso e teste.
import type { ConfigForm, ValidatedConfig } from "./types";

export function isWherebyUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "whereby.com" || h.endsWith(".whereby.com");
  } catch {
    return false;
  }
}

export function isJitsiUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "meet.jit.si" || h.endsWith(".jit.si") || h.includes("8x8.vc") || h.includes("jitsi");
  } catch {
    return false;
  }
}

export function isTokenOptional(url: string): boolean {
  return isWherebyUrl(url) || isJitsiUrl(url);
}

export function validateConfig(config: ConfigForm): ValidatedConfig {
  const users = Number(config.virtualUsers);
  if (!Number.isInteger(users) || users < 1 || users > 50) {
    throw new Error("O número de usuários deve ser no mínimo 1 e no máximo 50.");
  }
  if (isWherebyUrl(config.apiUrl) && users > 4) {
    throw new Error("O Whereby no plano gratuito permite no máximo 4 usuários simultâneos.");
  }
  const callDurationSec = Number(config.callDurationSec);
  if (!Number.isInteger(callDurationSec) || callDurationSec < 90 || callDurationSec > 1800) {
    throw new Error("A duração da chamada deve ser no mínimo 90 segundos (1min30s) e no máximo 1800 segundos (30min).");
  }
  try {
    const parsedUrl = new URL(config.apiUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("A URL da API deve usar HTTP ou HTTPS.");
    }
  } catch {
    throw new Error("Informe uma URL de API válida.");
  }
  if (!isTokenOptional(config.apiUrl) && !config.accessToken.trim()) {
    throw new Error("Informe o token de acesso.");
  }
  return {
    apiUrl: config.apiUrl.trim(),
    accessToken: config.accessToken.trim(),
    virtualUsers: users,
    callDurationSec
  };
}
