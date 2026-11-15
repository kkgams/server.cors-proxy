# server.cors-proxy

Dependency-free public download relay for a Cloudflare Worker or local Node 24.

## Local use

```sh
nix develop                     # pinned Node 24 and Make; or direnv allow
make test
make serve                      # http://127.0.0.1:8787
```

`PORT` changes the local port; the server always binds `127.0.0.1`. If your network requires an environment-configured proxy, explicitly use `NODE_OPTIONS=--use-env-proxy make serve` with Node 24 and your proxy environment variables. The server installs no tools and configures no upstream proxy itself.

```sh
mkdir -p build.nosync
curl --fail --get \
  --data-urlencode 'url=https://github.com/kkgams/theme.gams/releases/download/v1.0.1/theme.gams.zip' \
  -o build.nosync/github-download.zip http://127.0.0.1:8787/download
```

Browser: `fetch(relay + '/download?url=' + encodeURIComponent(originalAbsoluteURL))`. Use the original release URL, not its temporary signed redirect URL. Do not send credentials or custom request headers.

## API

| Request | Result |
| --- | --- |
| `GET /download?url=<encoded absolute URL>` | Stream upstream status and unchanged bytes |
| `HEAD /download?url=<encoded absolute URL>` | Upstream status and metadata, no body |
| `OPTIONS /download` | GET/HEAD CORS preflight; no custom request headers |

Downloads require exactly one `url` query parameter and no others. Other paths return 404; unsupported methods return 405. Invalid URLs return 400, forbidden origins/hosts/protocols 403, oversized declared bodies 413, upstream/redirect/encoding failures 502, and timeouts before headers 504. Failures after headers terminate the stream rather than replacing its status. Treat incomplete downloads as failures.

Allowed origins receive reflected `Access-Control-Allow-Origin` on success and errors. All responses use `Vary: Origin` and `Cache-Control: no-store`. Upstream status and `Content-Type`, `Content-Length`, `Content-Disposition` are retained when present; these headers are exposed to browsers. Upstream cookies, CORS/security headers, redirect locations and other metadata are not copied.

## Configuration

Worker bindings and local environment variables use the same CSV settings. Entry whitespace is trimmed; an empty value allows nothing.

| Variable | Default |
| --- | --- |
| `CORS_PROXY_ALLOWED_ORIGINS` | `http://127.0.0.1:8093,http://localhost:8093,https://kkgams.github.io` |
| `CORS_PROXY_ALLOWED_HOSTS` | `github.com,release-assets.githubusercontent.com,objects.githubusercontent.com` |

Origins match exactly, including scheme/port. Hosts match the parsed URL's exact `host`, including non-default ports. There are no wildcards or suffix matches. URL parsing canonicalizes host case/default ports. Every redirect is validated again, with at most five redirects; redirects are never browser-visible.

For local HTTP fixtures only, explicitly whitelist `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`. HTTP is forbidden for every other host. HTTPS requires a whitelisted public DNS name; IP literals, loopback names, dotless names and common internal-name suffixes are rejected. Only add trusted public DNS names: this Web API handler does not resolve/pin DNS addresses, so operators must not whitelist names resolving to private infrastructure. Defaults only trust GitHub download infrastructure.

## Security and limits

This is a **public relay**, not an authenticated service. No Origin is allowed for curl without ACAO; unknown origins return 403. Origin checks are browser policy, not authentication, and do not prevent non-browser use or bandwidth abuse. There is no rate limiting or caching.

Only GET/HEAD reach upstream. Caller cookies, authorization, origin and other headers are never forwarded. Upstream uses fixed `User-Agent: server-cors-proxy`, `Accept: */*`, `Accept-Encoding: identity`, and omitted credentials. Targets with credentials, fragments, malformed URLs or unlisted hosts are rejected. Local CONNECT and WebSocket upgrades are unsupported.

Transfers stream with backpressure, bounded to **64 MiB** and **120 seconds total**, including redirects/body consumption. Cancellation/disconnect aborts upstream. Non-identity `Content-Encoding` is rejected because Node fetch can decompress it, preventing byte preservation. The relay does not validate archives; consumers should verify published checksums.

`src/worker.mjs` exports `{ fetch(request, env) }` and `createProxy({ fetch, maxBytes, timeoutMs, maxRedirects })` for fixtures. `src/local.mjs` adapts Node HTTP streams to the same handler. `wrangler.toml` pins the entry and compatibility date; no Wrangler installation/deployment is included.

`make clean` removes only known verification files `build.nosync/{relay.log,github-download.zip,github-direct.zip,github-headers.txt}` and the directory if empty. It refuses tracked files/symlinks and preserves unrelated files. It does not stop servers or remove `.direnv/`.

Apache-2.0; see LICENSE and NOTICE.
