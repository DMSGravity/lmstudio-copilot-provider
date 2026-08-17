import * as vscode from 'vscode';
import { Logger } from '../logger';

export const TERMINAL_TOOL_NAME = 'lmstudio_run_in_terminal';

interface TerminalToolInput {
  command: string;
  cwd?: string;
}

function getWorkspaceCwd(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
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

async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (token.isCancellationRequested) {
    return undefined;
  }

  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }

  return new Promise((resolve) => {
    let finished = false;
    let cancelDisposable: vscode.Disposable | undefined;

    const finish = (value: vscode.TerminalShellIntegration | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      clearTimeout(timeout);
      cancelDisposable?.dispose();
      resolve(value);
    };

    const disposable = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        finish(event.shellIntegration);
      }
    });

    const timeout = setTimeout(() => {
      finish(undefined);
    }, timeoutMs);

    cancelDisposable = token.onCancellationRequested(() => {
      finish(undefined);
    });
  });
}

function normalizePathForComparison(inputPath: string): string {
  let result = inputPath.trim();

  if (process.platform === 'win32') {
    result = result.replace(/\//g, '\\').toLowerCase();
    if (result.length > 3) {
      result = result.replace(/[\\]+$/, '');
    }
  } else if (result.length > 1) {
    result = result.replace(/[\/]+$/, '');
  }

  return result;
}

function findTerminalForCwd(terminalName: string, cwd: string): vscode.Terminal | undefined {
  const wanted = normalizePathForComparison(cwd);

  return vscode.window.terminals.find((terminal) => {
    if (terminal.name !== terminalName) {
      return false;
    }

    const terminalCwd = terminal.shellIntegration?.cwd?.fsPath;

    if (!terminalCwd) {
      return false;
    }

    return normalizePathForComparison(terminalCwd) === wanted;
  });
}

function waitForExecutionEnd(
  execution: vscode.TerminalShellExecution,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = (exitCode: number | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      clearTimeout(timeout);
      cancelDisposable.dispose();
      resolve(exitCode);
    };

    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        finish(event.exitCode);
      }
    });

    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      cancelDisposable.dispose();
      reject(new Error(`Command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const cancelDisposable = token.onCancellationRequested(() => {
      if (finished) {
        return;
      }
      finished = true;
      disposable.dispose();
      clearTimeout(timeout);
      cancelDisposable.dispose();
      reject(new Error('Command cancelled.'));
    });
  });
}

async function executeInTerminal(
  terminal: vscode.Terminal,
  command: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
): Promise<{ output: string; exitCode: number | undefined }> {
  const shellIntegration = await waitForShellIntegration(terminal, 5000, token);

  if (!shellIntegration) {
    throw new Error(
      'VS Code shell integration is not available for this terminal. ' +
      'Make sure terminal.integrated.shellIntegration.enabled is true.',
    );
  }

  if (token.isCancellationRequested) {
    throw new Error('Command cancelled.');
  }

  const execution = shellIntegration.executeCommand(command);

  const outputChunks: string[] = [];
  const outputIterator = execution.read()[Symbol.asyncIterator]();

  const readPromise = (async () => {
    while (true) {
      const next = await outputIterator.next();
      if (next.done) {
        break;
      }
      if (token.isCancellationRequested) {
        break;
      }
      outputChunks.push(next.value);
    }
  })();

  try {
    const exitCode = await waitForExecutionEnd(execution, timeoutMs, token);
    await readPromise;
    return {
      output: outputChunks.join(''),
      exitCode,
    };
  } catch (error) {
    await outputIterator.return?.();
    await readPromise.catch(() => undefined);
    throw error;
  }
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
      logger.verbose(`[run_in_terminal] cwd=${cwd} cmd=${command}`);

      let terminal = findTerminalForCwd(terminalName, cwd);
      if (!terminal) {
        terminal = vscode.window.createTerminal({ name: terminalName, cwd });
      }

      terminal.show(true);

      try {
        const result = await executeInTerminal(terminal, command, timeoutMs, token);
        const output = result.output;
        const exitCode = result.exitCode;

        logger.verbose(`[run_in_terminal] exit=${exitCode ?? 'unknown'} output=${output.length}b`);

        const budgetChars = options.tokenizationOptions?.tokenBudget
          ? options.tokenizationOptions.tokenBudget * 3
          : 12000;

        const parts: string[] = [`exit_code: ${exitCode ?? 'unknown'}`];

        if (output.trim()) {
          parts.push(`output:\n${truncate(output.trimEnd(), Math.floor(budgetChars * 0.9))}`);
        } else {
          parts.push('(no output)');
        }

        return makeResult(parts.join('\n\n'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.verbose(`[run_in_terminal] error: ${message}`);
        return makeResult(`Terminal execution error: ${message}`);
      }
    },
  };
}
