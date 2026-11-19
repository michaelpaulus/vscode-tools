import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, watchFile } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

mkdirSync('dist/codicons', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) {
  cpSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/codicons/${f}`);
}
cpSync('webview/styles.css', 'dist/webview.css');

const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };
const tests = process.argv.includes('--tests');
const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' }),
  esbuild.context({ ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' }),
  ...(tests
    ? [esbuild.context({ ...common, entryPoints: ['test/integration/runTest.ts', 'test/integration/suite.ts'], outdir: 'dist-test', platform: 'node', format: 'cjs', external: ['vscode', '@vscode/test-electron'], target: 'node20' })]
    : []),
]);
if (watch) {
  watchFile('webview/styles.css', { interval: 500 }, () => cpSync('webview/styles.css', 'dist/webview.css'));
  await Promise.all(contexts.map(c => c.watch()));
} else {
  await Promise.all(contexts.map(c => c.rebuild()));
  await Promise.all(contexts.map(c => c.dispose()));
}
