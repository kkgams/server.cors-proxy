import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("../", import.meta.url))
const targets = ["build.nosync", "tools", "gams_modules"]

function fixture(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clean-test-")))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, "scripts"))
    copyFileSync(join(source, "scripts/clean.mjs"), join(root, "scripts/clean.mjs"))
    copyFileSync(join(source, "Makefile"), join(root, "Makefile"))
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0)
    for (const name of targets) {
        mkdirSync(join(root, name, "unmarked/nested"), { recursive: true })
        writeFileSync(join(root, name, "unmarked/nested/stale"), "recreate")
    }
    for (const name of ["models", "catalog", "authored"]) {
        mkdirSync(join(root, name))
        writeFileSync(join(root, name, "keep"), "preserve")
    }
    return root
}
function clean(root) {
    return spawnSync("make", ["clean"], { cwd: root, encoding: "utf8" })
}
function preserved(root) {
    for (const name of targets) assert.ok(existsSync(join(root, name, "unmarked/nested/stale")))
}

test("Make clean removes complete unmarked trees and is repeatable", (t) => {
    const root = fixture(t)
    for (let i = 0; i < 2; i++) {
        const result = clean(root)
        assert.equal(result.status, 0, result.stderr)
    }
    for (const name of targets) assert.ok(!existsSync(join(root, name)))
    for (const name of ["models", "catalog", "authored"]) assert.ok(existsSync(join(root, name, "keep")))
})

test("tracked paths in any tree block all deletion", (t) => {
    const root = fixture(t)
    for (const name of targets) {
        const path = `${name}/unmarked/nested/stale`
        assert.equal(spawnSync("git", ["add", "-f", path], { cwd: root }).status, 0)
        assert.notEqual(clean(root).status, 0)
        preserved(root)
        assert.equal(spawnSync("git", ["rm", "--cached", "-q", path], { cwd: root }).status, 0)
    }
})

test("nested file, directory and dangling symlinks block all deletion", (t) => {
    const root = fixture(t)
    for (const name of targets) {
        for (const target of ["authored/keep", "authored", "missing"]) {
            const link = join(root, name, "link")
            symlinkSync(join(root, target), link)
            assert.notEqual(clean(root).status, 0)
            preserved(root)
            unlinkSync(link)
        }
    }
})

test("top-level symlinks and non-directories block deletion", (t) => {
    const root = fixture(t)
    for (const name of targets) {
        const path = join(root, name)
        const saved = `${path}-saved`
        renameSync(path, saved)
        for (const target of [saved, join(root, "missing")]) {
            symlinkSync(target, path)
            assert.notEqual(clean(root).status, 0)
            assert.ok(existsSync(saved))
            unlinkSync(path)
        }
        writeFileSync(path, "not a directory")
        assert.notEqual(clean(root).status, 0)
        unlinkSync(path)
        renameSync(saved, path)
        preserved(root)
    }
})
