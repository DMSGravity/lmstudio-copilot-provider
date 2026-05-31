import * as vscode from 'vscode';
import * as cp from 'child_process';
import { Logger } from '../logger';

export const TERMINAL_TOOL_NAME = 'lmstudio_run_in_terminal';

interface TerminalToolInput {
  command: string;
  cwd?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function getWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

function execAsync(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    cp.exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, shell: '/bin/bash' },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
            ? (error as NodeJS.ErrnoException).code as unknown as number
            : error ? 1 : 0,
        });
      }
    );
  });
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.3);
  return (
    text.slice(0, head) +
    `\n\n... [${text.length - head - tail} chars omitted] ...\n\n` +
    text.slice(-tail)
  );
}

function makeResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

export function createTerminalTool(logger: Logger): vscode.LanguageModelTool<TerminalToolInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Running: ${options.input.command}`,
    }),

    invoke: async (options, token) => {
      const config = vscode.workspace.getConfiguration('lmstudio-copilot');
      const enabled = config.get<boolean>('enableTerminalTool', true);
      const command = options.input.command?.trim();
      const timeoutMs = config.get<number>('terminalToolTimeout', 30000);
      const terminalName = config.get<string>('terminalToolName', 'LM Studio Tool Terminal');

      if (!enabled) {
        return makeResult('Terminal tool is disabled (lmstudio-copilot.enableTerminalTool = false).');
      }

      if (!command) {
        return makeResult('No command provided.');
      }

      if (token.isCancellationRequested) {
        return makeResult('Cancelled.');
      }

      const cwd = options.input.cwd?.trim() || getWorkspaceCwd();
      logger.verbose(`[run_in_terminal] cwd=${cwd}  cmd=${command}`);

      // Show the command in the named terminal so the user can follow along
      // Only reuse a terminal that is still alive (exitStatus === undefined means it hasn't exited)
      const existing = vscode.window.terminals.find((t) => t.name === terminalName && t.exitStatus === undefined);
      const terminal = existing ?? vscode.window.createTerminal({ name: terminalName });
      terminal.show(true);
      terminal.sendText(command, true);

      // Execute with real output capture
      const { stdout, stderr, exitCode } = await execAsync(command, cwd, timeoutMs);
      logger.verbose(
        `[run_in_terminal] exit=${exitCode}  stdout=${stdout.length}b  stderr=${stderr.length}b`
      );

      // Budget-aware output size — ~3 chars per token is a safe estimate
      const budgetChars = options.tokenizationOptions?.tokenBudget
        ? options.tokenizationOptions.tokenBudget * 3
        : 12000;

      const parts: string[] = [`exit_code: ${exitCode}`];

      if (stdout.trim()) {
        parts.push(`stdout:\n${truncate(stdout.trimEnd(), Math.floor(budgetChars * 0.7))}`);
      }
      if (stderr.trim()) {
        parts.push(`stderr:\n${truncate(stderr.trimEnd(), Math.floor(budgetChars * 0.25))}`);
      }
      if (!stdout.trim() && !stderr.trim()) {
        parts.push('(no output)');
      }

      return makeResult(parts.join('\n\n'));
    },
  };
}
