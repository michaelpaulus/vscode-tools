import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface ExecOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Return raw bytes instead of utf-8 text. */
  raw?: boolean;
}

export class GitCli {
  /** Optional sink for a log of executed commands and failures. */
  onLog?: (line: string) => void;

  constructor(public gitPath = 'git') {}

  exec(cwd: string, args: readonly string[], options?: ExecOptions & { raw?: false }): Promise<string>;
  exec(cwd: string, args: readonly string[], options: ExecOptions & { raw: true }): Promise<Buffer>;
  exec(cwd: string, args: readonly string[], options: ExecOptions = {}): Promise<string | Buffer> {
    this.onLog?.(`> git ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          // Never block on an interactive editor (merge/revert/rebase --continue).
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
          LC_ALL: 'C',
          ...options.env,
        },
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', code => {
        const stdout = Buffer.concat(out);
        if (code === 0) {
          resolve(options.raw ? stdout : stdout.toString('utf8'));
          return;
        }
        const stderr = Buffer.concat(err).toString('utf8').trim();
        const text = stdout.toString('utf8');
        this.onLog?.(stderr || `exit code ${code}`);
        const message = stderr || text.trim() || `git ${args[0]} failed with exit code ${code}`;
        reject(new GitError(message, args, code, stderr, text));
      });
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
  }
}
