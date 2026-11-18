import assert from "node:assert/strict"
import { once } from "node:events"
import http from "node:http"
import net from "node:net"
import test from "node:test"
import { createLocalServer } from "../src/local.mjs"
import { createProxy } from "../src/worker.mjs"

const origin = "http://127.0.0.1:8093"
const target = "https://github.com/asset"
const request = (url = target, init = {}) => new Request(`http://relay/download?url=${encodeURIComponent(url)}`, init)
const call = (fetch, options = {}) => createProxy({ fetch, ...options })
const listen = async (server) => {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    return `http://127.0.0.1:${server.address().port}`
}
const close = (server) =>
    new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
    })

test("CORS exact match, errors, no Origin and configured origins", async () => {
    const proxy = call(async () => new Response("ok"))
    for (const value of [origin, "http://localhost:8093", "https://kkgams.github.io"]) {
        const result = await proxy(request(target, { headers: { Origin: value } }))
        assert.equal(result.headers.get("Access-Control-Allow-Origin"), value)
        assert.equal(result.headers.get("Vary"), "Origin")
        assert.equal(result.headers.get("Cache-Control"), "no-store")
        await result.text()
    }
    for (const value of ["null", `${origin}/`, "https://kkgams.github.io.evil.com", "http://localhost:8094"]) {
        const result = await proxy(request(target, { headers: { Origin: value } }))
        assert.equal(result.status, 403)
        assert.equal(result.headers.get("Access-Control-Allow-Origin"), null)
    }
    const plain = await proxy(request())
    assert.equal(plain.headers.get("Access-Control-Allow-Origin"), null)
    await plain.text()
    const error = await proxy(request("https://evil.com", { headers: { Origin: origin } }))
    assert.equal(error.status, 403)
    assert.equal(error.headers.get("Access-Control-Allow-Origin"), origin)
    assert.equal(
        (await proxy(request(target, { headers: { Origin: origin } }), { CORS_PROXY_ALLOWED_ORIGINS: "" })).status,
        403,
    )
})

test("routing, methods, single query and OPTIONS", async () => {
    const proxy = call(() => {
        throw new Error("must not fetch")
    })
    for (const query of ["", "?x=1", "?url=", "?url=x&url=y", "?url=x&extra=1"])
        assert.equal((await proxy(new Request(`http://relay/download${query}`))).status, 400)
    assert.equal((await proxy(new Request("http://relay/other"))).status, 404)
    assert.equal((await proxy(request(target, { method: "POST", body: "private" }))).status, 405)
    const options = await proxy(
        new Request("http://relay/download", {
            method: "OPTIONS",
            headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
        }),
    )
    assert.equal(options.status, 204)
    assert.equal(options.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS")
    assert.equal(options.headers.get("Access-Control-Allow-Credentials"), null)
    for (const headers of [
        { "Access-Control-Request-Method": "PUT" },
        { "Access-Control-Request-Headers": "Authorization" },
    ])
        assert.ok((await proxy(request(target, { method: "OPTIONS", headers }))).status >= 400)
})

test("reject forbidden destinations, credentials, fragments and malformed URLs", async () => {
    const proxy = call(() => {
        throw new Error("must not fetch")
    })
    for (const url of [
        "nonsense",
        "/asset",
        "https:github.com/a",
        " https://github.com/a",
        "https://u:p@github.com/a",
        "https://github.com/a#",
        "https://github.com/a#fragment",
        "http://github.com/a",
        "ftp://github.com/a",
        "https://evil.com",
        "https://github.com.evil.com",
    ])
        assert.ok((await proxy(request(url))).status >= 400, url)
    for (const url of [
        "https://127.0.0.1/a",
        "https://[::1]/a",
        "https://192.168.1.1/a",
        "https://metadata.internal/a",
        "https://intranet/a",
    ])
        assert.equal((await proxy(request(url), { CORS_PROXY_ALLOWED_HOSTS: new URL(url).host })).status, 403)
    assert.equal((await proxy(request("http://127.0.0.1:9999/a"))).status, 403)
})

test("redirects stay server-side; every destination validated; five-hop maximum", async () => {
    const seen = []
    const proxy = call(async (url, init) => {
        seen.push(url)
        assert.equal(init.redirect, "manual")
        return seen.length === 1
            ? new Response(null, { status: 302, headers: { Location: "https://objects.githubusercontent.com/file" } })
            : new Response("bytes")
    })
    const result = await proxy(request())
    assert.equal(await result.text(), "bytes")
    assert.equal(result.headers.get("Location"), null)
    assert.equal(seen.length, 2)
    for (const location of [
        "https://evil.com/a",
        "http://github.com/a",
        "https://user@github.com/a",
        "https://github.com/a#bad",
    ]) {
        let calls = 0
        const deny = call(async () => {
            calls++
            return new Response(null, { status: 307, headers: { Location: location } })
        })
        assert.ok((await deny(request())).status >= 400)
        assert.equal(calls, 1)
    }
    let calls = 0
    const loop = call(async () => {
        calls++
        return new Response(null, { status: 301, headers: { Location: "/loop" } })
    })
    assert.equal((await loop(request())).status, 502)
    assert.equal(calls, 6)
    assert.equal((await call(async () => new Response(null, { status: 302 }))(request())).status, 502)
})

test("binary, HEAD, status and header filtering; no credentials forwarded", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 0])
    for (const method of ["GET", "HEAD"]) {
        const proxy = call(async (_url, init) => {
            assert.equal(init.method, method)
            assert.equal(init.credentials, "omit")
            assert.equal(init.cache, "no-store")
            assert.deepEqual(init.headers, {
                "User-Agent": "server-cors-proxy",
                Accept: "*/*",
                "Accept-Encoding": "identity",
            })
            return new Response(method === "HEAD" ? null : bytes, {
                status: 404,
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": "6",
                    "Content-Disposition": 'attachment; filename="a.zip"',
                    "Set-Cookie": "secret=1",
                    "Access-Control-Allow-Origin": "*",
                    "Content-Security-Policy": "default-src 'none'",
                    ETag: "x",
                },
            })
        })
        const result = await proxy(
            request(target, {
                method,
                headers: { Origin: origin, Cookie: "secret", Authorization: "Bearer secret", Range: "bytes=1-2" },
            }),
        )
        assert.equal(result.status, 404)
        assert.equal(result.headers.get("Content-Length"), "6")
        assert.equal(result.headers.get("Content-Disposition"), 'attachment; filename="a.zip"')
        for (const header of ["Set-Cookie", "Content-Security-Policy", "ETag"])
            assert.equal(result.headers.get(header), null)
        assert.deepEqual(new Uint8Array(await result.arrayBuffer()), method === "HEAD" ? new Uint8Array() : bytes)
    }
    for (const status of [200, 206, 400, 403, 429, 500, 503]) {
        const result = await call(async () => new Response("body", { status }))(request())
        assert.equal(result.status, status)
        await result.text()
    }
    for (const status of [204, 205, 304])
        assert.equal((await call(async () => new Response(null, { status }))(request())).status, status)
})

test("known/streamed byte limits and unsupported content encoding", async () => {
    assert.equal(
        (
            await call(async () => new Response("12345", { headers: { "Content-Length": "5" } }), { maxBytes: 4 })(
                request(),
            )
        ).status,
        413,
    )
    assert.equal(
        (await call(async () => new Response("x", { headers: { "Content-Encoding": "gzip" } }))(request())).status,
        502,
    )
    assert.equal(
        (await call(async () => new Response("x", { headers: { "Content-Length": "invalid" } }))(request())).status,
        502,
    )
    let cancelled = false
    const proxy = call(
        async () =>
            new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(new Uint8Array(3))
                        c.enqueue(new Uint8Array(3))
                    },
                    cancel() {
                        cancelled = true
                    },
                }),
            ),
        { maxBytes: 4 },
    )
    await assert.rejects((await proxy(request())).arrayBuffer(), /byte limit/)
    assert.equal(cancelled, true)
})

test("timeouts cover headers/body; abort and response cancellation reach upstream", async () => {
    let signal
    const pending = call(
        (_url, init) => {
            signal = init.signal
            return new Promise(() => {})
        },
        { timeoutMs: 20 },
    )
    assert.equal((await pending(request())).status, 504)
    assert.equal(signal.aborted, true)
    let bodyCancelled = false
    const slow = call(
        async (_url, init) => {
            signal = init.signal
            return new Response(
                new ReadableStream({
                    cancel() {
                        bodyCancelled = true
                    },
                }),
            )
        },
        { timeoutMs: 20 },
    )
    await assert.rejects((await slow(request())).text(), /timeout/)
    assert.equal(signal.aborted, true)
    assert.equal(bodyCancelled, true)
    const controller = new AbortController()
    const waiting = pending(request(target, { signal: controller.signal }))
    controller.abort()
    assert.equal((await waiting).status, 502)
    assert.equal(signal.aborted, true)
    const cancel = await call(async (_url, init) => {
        signal = init.signal
        return new Response(new ReadableStream())
    })(request())
    await cancel.body.cancel()
    assert.equal(signal.aborted, true)
})

test("real HTTP fixtures/local adapter preserve binary/status/HEAD and isolate credentials", async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13])
    const observed = []
    const fixture = http.createServer((req, res) => {
        observed.push(req.headers)
        if (req.url === "/redirect") {
            res.writeHead(302, { Location: "/file" })
            res.end()
            return
        }
        if (req.url === "/denied") {
            res.writeHead(302, { Location: "http://127.0.0.1:1/private" })
            res.end()
            return
        }
        if (req.url === "/loop") {
            res.writeHead(302, { Location: "/loop" })
            res.end()
            return
        }
        res.writeHead(418, { "Content-Type": "application/zip", "Content-Length": bytes.length, "Set-Cookie": "bad=1" })
        res.end(bytes)
    })
    const upstream = await listen(fixture)
    const local = createLocalServer({ env: { CORS_PROXY_ALLOWED_HOSTS: new URL(upstream).host } })
    const relay = await listen(local)
    try {
        for (const method of ["GET", "HEAD"]) {
            const response = await fetch(`${relay}/download?url=${encodeURIComponent(`${upstream}/redirect`)}`, {
                method,
                headers: { Origin: origin, Cookie: "private", Authorization: "private" },
            })
            assert.equal(response.status, 418)
            assert.equal(response.headers.get("Content-Type"), "application/zip")
            assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin)
            assert.equal(response.headers.get("Set-Cookie"), null)
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === "GET" ? bytes : Buffer.alloc(0))
        }
        for (const headers of observed) {
            for (const header of ["cookie", "authorization", "origin"]) assert.equal(headers[header], undefined)
            assert.equal(headers["accept-encoding"], "identity")
            assert.equal(headers["user-agent"], "server-cors-proxy")
        }
        assert.equal((await fetch(`${relay}/download?url=${encodeURIComponent(`${upstream}/denied`)}`)).status, 403)
        assert.equal((await fetch(`${relay}/download?url=${encodeURIComponent(`${upstream}/loop`)}`)).status, 502)
        assert.equal((await fetch(`${relay}/download`, { method: "OPTIONS", headers: { Origin: origin } })).status, 204)
        assert.equal(
            (
                await fetch(`${relay}/download`, {
                    method: "POST",
                    body: new ReadableStream({
                        start(c) {
                            c.enqueue(new Uint8Array(100))
                            c.close()
                        },
                    }),
                    duplex: "half",
                })
            ).status,
            405,
        )
        assert.equal((await fetch(`${relay}/download`, { headers: { Origin: "https://evil.com" } })).status, 403)
    } finally {
        await close(local)
        await close(fixture)
    }
})

test("HTTP client disconnect cancels upstream; CONNECT forbidden; stream errors terminate sockets", async () => {
    let disconnect
    const disconnected = new Promise((resolve) => {
        disconnect = resolve
    })
    const fixture = http.createServer((_req, res) => {
        res.writeHead(200)
        res.write(Buffer.alloc(1024))
        res.on("close", disconnect)
    })
    const upstream = await listen(fixture)
    const local = createLocalServer({ env: { CORS_PROXY_ALLOWED_HOSTS: new URL(upstream).host } })
    const relay = await listen(local)
    try {
        await new Promise((resolve, reject) => {
            http.get(`${relay}/download?url=${encodeURIComponent(upstream)}`, (res) => {
                res.once("data", () => {
                    res.destroy()
                    resolve()
                })
                res.on("error", () => {})
            }).on("error", reject)
        })
        await Promise.race([
            disconnected,
            new Promise((_, reject) => {
                const timer = setTimeout(() => reject(new Error("Upstream not cancelled")), 1000)
                timer.unref()
            }),
        ])
        const socket = net.connect(new URL(relay).port, "127.0.0.1")
        await once(socket, "connect")
        socket.write("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com\r\n\r\n")
        const [reply] = await once(socket, "data")
        assert.match(reply.toString(), /405/)
        socket.destroy()
    } finally {
        await close(local)
        await close(fixture)
    }
    const broken = createLocalServer({
        handler: call(
            async () =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            c.enqueue(new Uint8Array(2))
                        },
                        pull() {
                            throw new Error("fixture failure")
                        },
                    }),
                ),
        ),
    })
    const url = await listen(broken)
    try {
        await assert.rejects(async () => {
            const response = await fetch(`${url}/download?url=${encodeURIComponent(target)}`)
            await response.arrayBuffer()
        })
    } finally {
        await close(broken)
    }
})

test("real HTTP body limits/timeouts and transport failures propagate through adapter", async () => {
    const fixture = http.createServer((req, res) => {
        if (req.url === "/timeout") {
            res.writeHead(200)
            res.write("a")
            return
        }
        if (req.url === "/broken") {
            res.writeHead(200, { "Content-Length": "3" })
            res.write("a")
            setImmediate(() => res.destroy())
            return
        }
        res.writeHead(200)
        res.write("123")
        setImmediate(() => res.end("456"))
    })
    const upstream = await listen(fixture)
    const local = createLocalServer({
        handler: createProxy({ maxBytes: 4, timeoutMs: 50 }),
        env: { CORS_PROXY_ALLOWED_HOSTS: new URL(upstream).host },
    })
    const relay = await listen(local)
    try {
        for (const path of ["/big", "/timeout", "/broken"]) {
            let response
            try {
                response = await fetch(`${relay}/download?url=${encodeURIComponent(upstream + path)}`)
            } catch (error) {
                assert.match(error.message, /fetch failed/, path)
                continue
            }
            assert.equal(response.status, 200, path)
            await assert.rejects(response.arrayBuffer(), undefined, path)
        }
    } finally {
        await close(local)
        await close(fixture)
    }
})
