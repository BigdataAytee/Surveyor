/**
 * The build step that turns `src/offline/sw.js` into a real service worker.
 *
 * The only thing the worker cannot know for itself is what the built files are
 * called — Vite content-hashes them, which is what makes them safe to cache
 * forever and also what makes the list unknowable ahead of time. So it is
 * written with two placeholders and filled in here.
 *
 * The list is read from the output directory rather than from the bundle,
 * after everything has been written. That is not a stylistic choice: at the
 * point the bundle exists, `index.html` has not been emitted and nothing from
 * `public/` has been copied — so a list built from the bundle precaches the
 * JavaScript and CSS and leaves out the one file a navigation actually asks
 * for. The app would then fail to open offline while appearing to have a
 * perfectly good cache.
 *
 * Deliberately not a dependency. A precaching plugin is a few dozen lines of
 * list-building, and the alternative is a large library whose behaviour has to
 * be learned before the caching rules can be reasoned about at all.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src/offline/sw.js', import.meta.url));

/** Files worth having on the device before they are ever asked for. */
function shouldPrecache(path) {
  if (path === 'sw.js') return false;
  // Source maps are for debugging, not for a phone in a field.
  if (path.endsWith('.map')) return false;
  /*
   * The admin console is deliberately not cached.
   *
   * It is a monitoring surface, and a cached one shows whatever it saw last
   * time it had a connection with nothing to say the figures are stale. A
   * console that lies quietly is worse than one that will not open — and it
   * has no business taking up room on a surveyor's phone either.
   */
  if (path === 'admin/index.html' || path.startsWith('admin/')) return false;
  return /\.(html|css|js|woff2?|svg|png|webmanifest)$/.test(path);
}

async function filesUnder(root) {
  const found = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        // Posix separators: these become URLs, and a Windows build must not
        // produce a precache list full of backslashes.
        found.push(relative(root, full).split(sep).join(posix.sep));
      }
    }
  }

  await walk(root);
  return found;
}

export function serviceWorker() {
  let outDir = null;

  return {
    name: 'surveyor-service-worker',
    // The output has to exist before its file names can be listed.
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    async writeBundle(options) {
      const root = options.dir ?? outDir;
      if (!root) return;

      const urls = (await filesUnder(root)).filter(shouldPrecache).map((file) => `/${file}`);

      // "/" and "/index.html" are the same document to this app but different
      // cache keys to the browser, and a navigation asks for whichever the URL
      // bar says.
      if (urls.includes('/index.html')) urls.unshift('/');

      /*
       * The cache name is derived from the file list, so a deploy that changes
       * nothing does not throw away a working cache, and one that changes
       * anything gets a clean one. A timestamp would do neither.
       */
      const buildId = createHash('sha256')
        .update([...urls].sort().join('\n'))
        .digest('hex')
        .slice(0, 12);

      const source = await readFile(SOURCE, 'utf8');
      const code = source
        .replace('__BUILD_ID__', buildId)
        .replace('__PRECACHE__', JSON.stringify(urls, null, 2));

      await writeFile(join(root, 'sw.js'), code, 'utf8');
    },
  };
}
