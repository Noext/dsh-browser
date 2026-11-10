#!/usr/bin/env node
/**
 * Build both halves of dsh-browser.
 *
 * The Host half is ordinary ESM. The Client half must satisfy the Web Client's
 * module contract: a script that only registers a factory through
 * `window.__ModuleLoader__.load({ id, factory })`, resolving shared modules
 * through the injected `require`. DSH's own preset lives outside any published
 * package, so this build reproduces it with esbuild.
 */
import { build } from 'esbuild'
import { rm, mkdir, readFile } from 'node:fs/promises'

const PACKAGE_NAME = 'dsh-browser'
const { version } = JSON.parse(await readFile('package.json', 'utf8'))

/** Module specifiers the shell shares into its frozen table; everything else is inlined. */
const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })

// ---- Host half ----
await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  minify: false,
  // DSH packages are provided by the running installation, never vendored here.
  external: ['@deepseek-ai/*', 'ws', 'node:*'],
  // Stamped so a running Host can say which build it loaded, not which
  // package.json happens to sit next to it on disk.
  define: { __DSH_BROWSER_VERSION__: JSON.stringify(version) },
  banner: { js: `/** dsh-browser host half v${version} */` },
})

// ---- Client half ----
const result = await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  minify: false,
  external: EXTERNALS,
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
})

if (result.errors.length > 0) {
  console.error(result.errors)
  process.exit(1)
}
console.log(`built lib/index.js and lib/client.js (v${version})`)
