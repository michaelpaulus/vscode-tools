import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, ...IDENTITY } });
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

async function main(): Promise<void> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitrepo-it-')));
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'clone', '-q', origin, work);
  git(work, 'config', 'user.name', IDENTITY.GIT_AUTHOR_NAME);
  git(work, 'config', 'user.email', IDENTITY.GIT_AUTHOR_EMAIL);
  commit(work, 'a.txt', 'one\n', 'First commit');
  commit(work, 'b.txt', 'two\n', 'Second commit');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature/one');
  commit(work, 'c.txt', 'three\n', 'Feature commit');
  git(work, 'push', '-q', '-u', 'origin', 'feature/one');
  git(work, 'checkout', '-q', 'main');
  git(work, 'branch', 'test');
  git(work, 'branch', 'staging');
  git(work, 'tag', 'v1.0');

  const root = path.resolve(__dirname, '..');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'dist-test', 'suite.js'),
      launchArgs: [work, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(tmp, 'user-data')],
      extensionTestsEnv: { GITREPO_TEST_WORK: work, GITREPO_TEST_ROOT: tmp, ...IDENTITY },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
