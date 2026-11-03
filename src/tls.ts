/** Self-signed certificate for `tls: "auto"` (generated with the system `openssl`, stored in the config dir). */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";

export interface TlsFiles {
  cert: string;
  key: string;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === "IPv4") out.push(a.address);
  }
  return out;
}

export function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sanList(host: string): { dns: string[]; ips: string[] } {
  const dns = new Set(["localhost"]);
  const ips = new Set(["127.0.0.1", "::1"]);
  const hn = os.hostname();
  if (hn) dns.add(hn);
  for (const ip of lanAddresses()) ips.add(ip);
  if (net.isIP(host)) ips.add(host);
  return { dns: [...dns], ips: [...ips] };
}

/** True when the existing cert is valid for at least 30 more days and covers every current address. */
export function certIsFresh(certPath: string, host: string): boolean {
  try {
    const c = new X509Certificate(fs.readFileSync(certPath));
    if (new Date(c.validTo).getTime() - Date.now() < 30 * 86_400_000) return false;
    return sanList(host).ips.every((ip) => !!c.checkIP(ip));
  } catch {
    return false;
  }
}

export function ensureSelfSigned(configDir: string, host: string): TlsFiles {
  const cert = path.join(configDir, "cert.pem");
  const key = path.join(configDir, "key.pem");
  if (fs.existsSync(cert) && fs.existsSync(key) && certIsFresh(cert, host)) return { cert, key };
  const { dns, ips } = sanList(host);
  const cnf = [
    "[req]",
    "distinguished_name=dn",
    "x509_extensions=v3",
    "prompt=no",
    "[dn]",
    "CN=tmux-terminals",
    "[v3]",
    "basicConstraints=CA:FALSE",
    "keyUsage=digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${[...dns.map((d) => `DNS:${d}`), ...ips.map((i) => `IP:${i}`)].join(",")}`,
    "",
  ].join("\n");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const cnfPath = path.join(configDir, `.openssl-${process.pid}.cnf`);
  fs.writeFileSync(cnfPath, cnf, { mode: 0o600 });
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "825", "-keyout", key, "-out", cert, "-config", cnfPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    throw new Error(`could not generate a self-signed certificate with openssl (${(e as Error).message.split("\n")[0]}). Install openssl, or set "tls": "off" / provide cert+key paths.`);
  } finally {
    try {
      fs.unlinkSync(cnfPath);
    } catch {
      /* ignore */
    }
  }
  fs.chmodSync(key, 0o600);
  return { cert, key };
}
