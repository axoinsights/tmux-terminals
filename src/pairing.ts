import * as os from "node:os";
import QRCode from "qrcode";
import { isLoopback, type Config } from "./config.js";
import { lanAddresses } from "./tls.js";

/** The scheme the server will actually use for a config. */
export function effectiveScheme(config: Config): "http" | "https" {
  if (config.tls === "off") return "http";
  if (config.tls === "auto") return isLoopback(config.host) ? "http" : "https";
  return "https";
}

/** Base URLs (no token) a client can use to reach the server. */
export function baseUrls(config: Config): string[] {
  const scheme = effectiveScheme(config);
  const wildcard = config.host === "0.0.0.0" || config.host === "::";
  const hosts = wildcard ? [...lanAddresses(), os.hostname()].filter(Boolean) : [config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host];
  return hosts.map((h) => `${scheme}://${h}:${config.port}`);
}

export function pairingUrls(config: Config): string[] {
  return baseUrls(config).map((b) => `${b}/?token=${encodeURIComponent(config.token)}`);
}

export async function qrText(url: string): Promise<string> {
  return QRCode.toString(url, { type: "terminal", small: true });
}
