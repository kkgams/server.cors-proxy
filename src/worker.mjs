const DEFAULT_ORIGINS = "http://127.0.0.1:8093,http://localhost:8093,https://kkgams.github.io"
const DEFAULT_HOSTS = "github.com,release-assets.githubusercontent.com,objects.githubusercontent.com"
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const csv = (value) =>
    new Set(
        value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
    )
class ProxyError extends Error {
    constructor(status, message) {
        super(message)
        this.status = status
    }
}
function validateTarget(value, hosts) {
    let url
    try {
        if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) throw new Error("Invalid URL")
        url = new URL(value)
    } catch {
        throw new ProxyError(400, "Invalid target URL")
    }
    if (url.username || url.password || value.includes("#"))
        throw new ProxyError(400, "Credentials and fragments are forbidden")
    if (!hosts.has(url.host)) throw new ProxyError(403, "Target host is not allowed")
    const name = url.hostname
    const loopback = name === "localhost" || name === "127.0.0.1" || name === "[::1]"
    if (url.protocol === "http:" && loopback) return url
    if (url.protocol !== "https:") throw new ProxyError(403, "HTTPS is required")
    // Configured public DNS names are trusted; literal/private/internal destinations are not.
    if (
        loopback ||
        name.startsWith("[") ||
        /^\d+\.\d+\.\d+\.\d+$/.test(name) ||
        !name.includes(".") ||
        /\.(localhost|local|internal|test|invalid)$/.test(name) ||
        name.endsWith(".")
    ) {
        throw new ProxyError(403, "Public DNS host required")
    }
    return url
}

/** Dependency injection supports native fixtures without Node APIs in this module. */
export function createProxy({
    fetch: upstreamFetch = globalThis.fetch,
    maxBytes = 64 * 1024 * 1024,
    timeoutMs = 120_000,
    maxRedirects = 5,
} = {}) {
    if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        !Number.isSafeInteger(maxRedirects) ||
        maxRedirects < 0
    )
        throw new TypeError("Invalid proxy limits")
    return async function proxy(request, env = {}) {
        const origin = request.headers.get("Origin")
        const origins = csv(env.CORS_PROXY_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS)
        const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" })
        if (origin !== null && origins.has(origin)) {
            headers.set("Access-Control-Allow-Origin", origin)
            headers.set("Access-Control-Expose-Headers", "Content-Type, Content-Length, Content-Disposition")
        }
        const errorResponse = (status, message) => {
            const result = new Headers(headers)
            result.delete("Content-Length")
            result.delete("Content-Disposition")
            result.set("Content-Type", "text/plain; charset=utf-8")
            return new Response(request.method === "HEAD" ? null : `${message}\n`, { status, headers: result })
        }
        if (origin !== null && !origins.has(origin)) return errorResponse(403, "Origin is not allowed")
        const incoming = new URL(request.url)
        if (incoming.pathname !== "/download") return errorResponse(404, "Not found")
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
            headers.set("Allow", "GET, HEAD, OPTIONS")
            return errorResponse(405, "Method not allowed")
        }
        const params = [...incoming.searchParams]
        const validQuery = params.length === 1 && params[0][0] === "url" && Boolean(params[0][1])
        if (request.method === "OPTIONS") {
            if (incoming.search && !validQuery) return errorResponse(400, "Exactly one url parameter is required")
            const method = request.headers.get("Access-Control-Request-Method")
            if (method && !["GET", "HEAD"].includes(method)) return errorResponse(405, "Method not allowed")
            if (request.headers.get("Access-Control-Request-Headers"))
                return errorResponse(403, "Request headers are not allowed")
            headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            return new Response(null, { status: 204, headers })
        }
        if (!validQuery) return errorResponse(400, "Exactly one url parameter is required")
        const controller = new AbortController()
        let timedOut = false
        let finished = false
        let reader
        const abortClient = () => controller.abort(request.signal.reason)
        request.signal.addEventListener("abort", abortClient, { once: true })
        if (request.signal.aborted) abortClient()
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort(new Error("Download timeout"))
        }, timeoutMs)
        const cleanup = () => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            request.signal.removeEventListener("abort", abortClient)
        }
        const aborted = new Promise((_, reject) => {
            const fail = () =>
                reject(new ProxyError(timedOut ? 504 : 502, timedOut ? "Download timeout" : "Download aborted"))
            if (controller.signal.aborted) fail()
            else controller.signal.addEventListener("abort", fail, { once: true })
        })
        aborted.catch(() => {})
        const cancelBody = (body, reason) => {
            if (body) void body.cancel(reason).catch(() => {})
        }
        try {
            const hosts = csv(env.CORS_PROXY_ALLOWED_HOSTS ?? DEFAULT_HOSTS)
            let target = validateTarget(params[0][1], hosts)
            let upstream
            for (let redirects = 0; ; redirects++) {
                upstream = await Promise.race([
                    upstreamFetch(target.href, {
                        method: request.method,
                        redirect: "manual",
                        credentials: "omit",
                        cache: "no-store",
                        headers: { "User-Agent": "server-cors-proxy", Accept: "*/*", "Accept-Encoding": "identity" },
                        signal: controller.signal,
                    }),
                    aborted,
                ])
                if (!REDIRECTS.has(upstream.status)) break
                cancelBody(upstream.body)
                if (redirects >= maxRedirects) throw new ProxyError(502, "Too many redirects")
                const location = upstream.headers.get("Location")
                if (!location) throw new ProxyError(502, "Redirect has no Location")
                let next
                try {
                    next = new URL(location, target).href
                } catch {
                    throw new ProxyError(502, "Invalid redirect")
                }
                target = validateTarget(next, hosts)
            }
            const encoding = upstream.headers.get("Content-Encoding")
            if (encoding && encoding.trim().toLowerCase() !== "identity") {
                cancelBody(upstream.body)
                throw new ProxyError(502, "Encoded upstream body is not supported")
            }
            const length = upstream.headers.get("Content-Length")
            if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
                cancelBody(upstream.body)
                throw new ProxyError(502, "Invalid upstream Content-Length")
            }
            if (length !== null && Number(length) > maxBytes) {
                cancelBody(upstream.body)
                throw new ProxyError(413, "Download exceeds byte limit")
            }
            for (const name of ["Content-Type", "Content-Length", "Content-Disposition"]) {
                const value = upstream.headers.get(name)
                if (value !== null) headers.set(name, value)
            }
            if (request.method === "HEAD" || !upstream.body || [204, 205, 304].includes(upstream.status)) {
                cancelBody(upstream.body)
                cleanup()
                return new Response(null, { status: upstream.status, headers })
            }
            reader = upstream.body.getReader()
            let bytes = 0
            const stream = new ReadableStream({
                async pull(destination) {
                    try {
                        const { value, done } = await Promise.race([reader.read(), aborted])
                        if (done) {
                            cleanup()
                            destination.close()
                            return
                        }
                        bytes += value.byteLength
                        if (bytes > maxBytes) throw new ProxyError(413, "Download exceeds byte limit")
                        destination.enqueue(value)
                    } catch (error) {
                        controller.abort(error)
                        void reader.cancel(error).catch(() => {})
                        cleanup()
                        destination.error(error)
                    }
                },
                cancel(reason) {
                    controller.abort(reason)
                    cleanup()
                    return reader.cancel(reason)
                },
            })
            return new Response(stream, { status: upstream.status, headers })
        } catch (error) {
            controller.abort(error)
            if (reader) void reader.cancel(error).catch(() => {})
            cleanup()
            return errorResponse(
                error instanceof ProxyError ? error.status : 502,
                error instanceof ProxyError ? error.message : "Upstream request failed",
            )
        }
    }
}
export default { fetch: createProxy() }
