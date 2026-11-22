// Turns what the user typed in the address bar into a URL to load.
import { parse as parseDomain } from "tldts";

export const SEARCH_URL = "https://duckduckgo.com/?q=";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "about:"]);

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".test") ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h === "[::1]" ||
    /^(10|192\.168)(\.\d{1,3}){2,3}$/.test(h)
  );
}

const isIPv4 = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
const isHostname = (h: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(h);

/** True when the host ends in a real public suffix (ICANN TLDs like .com/.co.id, or private ones like github.io). */
function hasPublicSuffix(host: string): boolean {
  const p = parseDomain(host, { allowPrivateDomains: true });
  return Boolean(p.isIcann || p.isPrivate);
}

/**
 * Returns the URL to navigate to for an address-bar input.
 * - Full URLs with an allowed scheme are used as they are.
 * - Hosts with a real public suffix (example.com, user.github.io) get https://.
 * - Local hosts and IPs (localhost:3000, 127.0.0.1, myapp.test) get http://.
 * - Hosts without a known suffix (notes.txt, intranet.corp, wiki) are searched, unless the
 *   user signals a host with a port or a trailing path ("intranet.corp/", "wiki:8080");
 *   those get http://, since they are almost always internal servers.
 * - Everything else becomes a web search.
 *
 * Like Chrome, inputs whose "extension" is also a real TLD (readme.md, archive.zip) are treated
 * as hosts, because .md and .zip are real top-level domains.
 */
export function resolveInput(raw: string): string {
  const input = raw.trim();
  if (!input) return "about:blank";

  // Explicit scheme (but not "host:port")
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[^/]+:\d+(\/|$)/.test(input)) {
    try {
      const u = new URL(input);
      if (ALLOWED_SCHEMES.has(u.protocol)) return u.toString();
    } catch {
      /* fall through to search */
    }
    return search(input);
  }

  if (/\s/.test(input)) return search(input);

  const hostPart = input.split(/[/?#]/)[0] ?? "";
  const portMatch = /:(\d+)$/.exec(hostPart);
  const host = portMatch ? hostPart.slice(0, -portMatch[0].length) : hostPart;
  const hasPort = Boolean(portMatch);
  const hasPath = input.charAt(hostPart.length) === "/"; // "wiki/" yes; "what?" is a question, not a host

  let scheme: "http://" | "https://" | null = null;
  if (isLocalHost(host) || isIPv4(host)) scheme = "http://";
  else if (!isHostname(host)) scheme = null;
  else if (host.includes(".") && hasPublicSuffix(host)) scheme = "https://";
  else if (hasPort || hasPath) scheme = "http://"; // explicit intranet host

  if (!scheme) return search(input);
  try {
    return new URL(scheme + input).toString();
  } catch {
    return search(input);
  }
}

function search(q: string): string {
  return SEARCH_URL + encodeURIComponent(q);
}
