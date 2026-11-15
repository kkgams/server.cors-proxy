import { lstat, readdir, unlink, rmdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const root = 'build.nosync';
const known = ['relay.log', 'github-download.zip', 'github-direct.zip', 'github-headers.txt'];
async function stat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const info = await stat(root);
if (info) {
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refuse non-directory or symlink build.nosync');
  const tracked = spawnSync('git', ['ls-files', '-z', '--', root], { encoding: 'utf8' });
  if (tracked.status !== 0) throw new Error('Cannot check tracked files');
  const trackedPaths = tracked.stdout.split('\0');
  // Validate all candidates before deleting any. Unknown files are never removed.
  const remove = [];
  for (const name of known) {
    const path = `${root}/${name}`;
    const entry = await stat(path);
    if (!entry) continue;
    if (trackedPaths.includes(path) || entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Refuse unsafe clean target: ${path}`);
    remove.push(path);
  }
  for (const path of remove) await unlink(path);
  if ((await readdir(root)).length === 0) await rmdir(root);
}
