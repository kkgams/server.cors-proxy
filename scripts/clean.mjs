import { spawnSync } from "node:child_process"
import { lstat, readdir, rm } from "node:fs/promises"
import { dirname, join, parse } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const targets = ["build.nosync", "tools", "gams_modules"]

async function stat(path) {
    try {
        return await lstat(path)
    } catch (error) {
        if (error.code === "ENOENT") return null
        throw error
    }
}

async function preflight(path) {
    const entry = await stat(path)
    if (!entry) return
    if (entry.isSymbolicLink()) throw new Error(`Refuse symlink: ${path}`)
    if (entry.isDirectory()) {
        for (const name of await readdir(path)) await preflight(join(path, name))
    }
}

for (let parent = dirname(root); ; parent = dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Refuse symlink ancestor: ${parent}`)
    if (parent === parse(parent).root) break
}
const tracked = spawnSync("git", ["ls-files", "-z", "--", ...targets], { cwd: root, encoding: "utf8" })
if (tracked.status !== 0) throw new Error("Cannot check tracked files")
if (tracked.stdout) throw new Error("Refuse tracked clean targets")
// Check every tree before deleting any of them.
for (const name of targets) {
    const path = join(root, name)
    const entry = await stat(path)
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        throw new Error(`Refuse non-directory or symlink: ${path}`)
    await preflight(path)
}
for (const name of targets) await rm(join(root, name), { recursive: true, force: true })
