/**
 * Pure diagnostic for the commonest Atlas TLS footgun: a `mongodb://`
 * (non-SRV) URI against a remote host without `tls=true`. Atlas requires
 * TLS; without it the handshake dies with something like `tlsv1 alert
 * internal error`. Returns a warning message, or null when the URI looks
 * fine (or is unparseable, in which case the driver reports the error).
 * The message names the remote host only — never credentials.
 */
export function getMongoUriTlsWarning(uri: string): string | null {
  if (/^mongodb\+srv:\/\//i.test(uri)) return null; // SRV implies TLS.
  const hostsMatch = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri);
  if (!hostsMatch) return null;
  if (/[?&](tls|ssl)=true/i.test(uri)) return null;
  const raw = hostsMatch[1].split(",")[0].trim().toLowerCase();
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.split(":")[0];
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) {
    return null;
  }
  return (
    `MONGODB_URI uses mongodb:// without tls=true against remote host "${host}"; ` +
    `Atlas requires TLS (use a mongodb+srv:// URI or add ?tls=true).`
  );
}
