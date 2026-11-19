import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';
import type { ActivityTask } from './shared/protocol';

/** The command being executed and the item it acts on, set once per command invocation. */
const scope = new AsyncLocalStorage<{ command: string; target?: string }>();

/**
 * Git operations in progress. The windows show them (progress bar, label, spinner on the affected item)
 * while staying interactive, instead of appearing frozen until the operation and refresh finish.
 */
export class Activity implements vscode.Disposable {
  private readonly running = new Map<number, ActivityTask>();
  private next = 0;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  get tasks(): ActivityTask[] {
    return [...this.running.values()];
  }

  /** Runs `fn` so that work tracked inside it is attributed to `command` and `target`. */
  static within<T>(command: string, target: string | undefined, fn: () => T): T {
    return scope.run({ command, target }, fn);
  }

  async track<T>(title: string, work: () => Promise<T>): Promise<T> {
    const id = ++this.next;
    this.running.set(id, { id, title, ...scope.getStore() });
    this.emitter.fire();
    try {
      return await work();
    } finally {
      this.running.delete(id);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
