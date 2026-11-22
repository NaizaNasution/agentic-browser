// Which URLs agents may open (SPEC §15.3 `file_scheme`: file://, chrome://, and devtools URLs are denied).
// Agents get http, https, and about:blank. There is no search fallback: `agb goto` takes URLs, not queries.

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: "denied" | "invalid"; message: string };

const LOCAL_HOSTS = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

export function normalizeAgentUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "invalid", message: "the URL is empty" };
  if (/\s/.test(raw)) return { ok: false, reason: "invalid", message: `"${raw}" is not a URL` };
  if (raw.toLowerCase() === "about:blank") return { ok: true, url: "about:blank" };

  // "localhost:3000/x" looks like a scheme to a naive parser; host:port is a host.
  const hostPort = /^[^/:?#]+:\d+(?:[/?#]|$)/.test(raw);
  const scheme = hostPort ? undefined : /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  let candidate: string;
  if (scheme === undefined) {
    const host = raw.split(/[/?#]/)[0]!.replace(/:\d+$/, "");
    candidate = (LOCAL_HOSTS.test(host) ? "http://" : "https://") + raw;
  } else if (scheme === "http" || scheme === "https") {
    candidate = raw;
  } else {
    return { ok: false, reason: "denied", message: `agents can't open ${scheme}: URLs` };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid", message: `"${raw}" is not a valid URL` };
  }
  if (!url.hostname) return { ok: false, reason: "invalid", message: `"${raw}" has no host` };
  return { ok: true, url: url.href };
}
