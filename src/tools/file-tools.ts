import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { Logger } from '../logger';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.join(workspaceRoot(), inputPath);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.55);
  const tail = Math.floor(maxChars * 0.35);
  return (
    text.slice(0, head) +
    `\n\n... [${text.length - head - tail} chars omitted] ...\n\n` +
    text.slice(-tail)
  );
}

function budgetChars(options: vscode.LanguageModelToolInvocationOptions<unknown>): number {
  return options.tokenizationOptions?.tokenBudget
    ? options.tokenizationOptions.tokenBudget * 3
    : 16000;
}

// ─── read_file ────────────────────────────────────────────────────────────────

export const READ_FILE_TOOL_NAME = 'lmstudio_read_file';

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function createReadFileTool(
  logger: Logger
): vscode.LanguageModelTool<ReadFileInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Reading file: ${options.input.path}`,
    }),

    invoke: async (options) => {
      const resolved = resolvePath(options.input.path);
      logger.verbose(`[read_file] ${resolved}`);

      if (!fs.existsSync(resolved)) {
        return makeResult(`File not found: ${resolved}`);
      }

      let content: string;
      try {
        content = fs.readFileSync(resolved, 'utf8');
      } catch (e) {
        return makeResult(`Error reading file: ${e}`);
      }

      const lines = content.split('\n');
      const totalLines = lines.length;

      const start = Math.max(1, options.input.startLine ?? 1) - 1;
      const end = Math.min(totalLines, options.input.endLine ?? totalLines);

      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, i) => `${String(start + i + 1).padStart(6)} | ${line}`)
        .join('\n');

      const header = `File: ${resolved} (lines ${start + 1}-${end} of ${totalLines})\n\n`;
      const full = header + numbered;
      const maxChars = budgetChars(options);

      return makeResult(truncate(full, maxChars));
    },
  };
}

// ─── write_file ───────────────────────────────────────────────────────────────

export const WRITE_FILE_TOOL_NAME = 'lmstudio_write_file';

interface WriteFileInput {
  path: string;
  content: string;
  createDirectories?: boolean;
}

export function createWriteFileTool(
  logger: Logger
): vscode.LanguageModelTool<WriteFileInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Writing file: ${options.input.path}`,
    }),

    invoke: async (options) => {
      const resolved = resolvePath(options.input.path);
      logger.verbose(`[write_file] ${resolved}`);

      try {
        if (options.input.createDirectories !== false) {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
        }
        fs.writeFileSync(resolved, options.input.content, 'utf8');
      } catch (e) {
        return makeResult(`Error writing file: ${e}`);
      }

      const lines = options.input.content.split('\n').length;
      return makeResult(
        `Written: ${resolved}\n${lines} lines, ${options.input.content.length} bytes`
      );
    },
  };
}

// ─── list_directory ───────────────────────────────────────────────────────────

export const LIST_DIRECTORY_TOOL_NAME = 'lmstudio_list_directory';

interface ListDirectoryInput {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
}

function listDir(
  dirPath: string,
  depth: number,
  maxDepth: number,
  prefix: string
): string[] {
  if (depth > maxDepth) {
    return [prefix + '  ... (max depth reached)'];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [prefix + '  [permission denied]'];
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  const ignored = new Set([
    'node_modules',
    '.git',
    'dist',
    'out',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
    '.next',
    'build',
    'coverage',
    '.nyc_output',
  ]);

  for (const entry of sorted) {
    const icon = entry.isDirectory() ? '📁' : '📄';
    const suffix = entry.isDirectory() ? '/' : '';
    lines.push(`${prefix}${icon} ${entry.name}${suffix}`);

    if (entry.isDirectory() && !ignored.has(entry.name)) {
      const children = listDir(
        path.join(dirPath, entry.name),
        depth + 1,
        maxDepth,
        prefix + '  '
      );
      lines.push(...children);
    }
  }

  return lines;
}

export function createListDirectoryTool(
  logger: Logger
): vscode.LanguageModelTool<ListDirectoryInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Listing: ${options.input.path ?? 'workspace root'}`,
    }),

    invoke: async (options) => {
      const dirPath = resolvePath(options.input.path ?? '.');
      logger.verbose(`[list_directory] ${dirPath}`);

      if (!fs.existsSync(dirPath)) {
        return makeResult(`Directory not found: ${dirPath}`);
      }

      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return makeResult(`Not a directory: ${dirPath}`);
      }

      const maxDepth = options.input.recursive ? (options.input.maxDepth ?? 4) : 1;
      const lines = listDir(dirPath, 0, maxDepth, '');
      const header = `Directory: ${dirPath}\n\n`;
      const body = lines.join('\n') || '(empty directory)';
      const full = header + body;

      return makeResult(truncate(full, budgetChars(options)));
    },
  };
}

// ─── search_files ─────────────────────────────────────────────────────────────

export const SEARCH_FILES_TOOL_NAME = 'lmstudio_search_files';

interface SearchFilesInput {
  pattern: string;
  glob?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  contextLines?: number;
}

function hasCommand(cmd: string): boolean {
  try {
    cp.execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function searchWithRipgrep(
  pattern: string,
  cwd: string,
  options: {
    isRegex: boolean;
    caseSensitive: boolean;
    glob?: string;
    maxResults: number;
    contextLines: number;
  }
): Promise<string> {
  const args = ['rg', '--color=never', '--with-filename', '--line-number'];
  if (!options.isRegex) {
    args.push('--fixed-strings');
  }
  if (!options.caseSensitive) {
    args.push('--ignore-case');
  }
  if (options.glob) {
    args.push('--glob', options.glob);
  }
  args.push('--context', String(options.contextLines));
  args.push('--max-count', String(options.maxResults));
  args.push(pattern);

  return new Promise((resolve) => {
    cp.exec(
      args.join(' '),
      { cwd, maxBuffer: 1024 * 1024 * 5, timeout: 15000 },
      (error, stdout, stderr) => {
        // rg exits with code 1 when no matches (not an error)
        resolve(stdout || stderr || 'No matches found.');
      }
    );
  });
}

async function searchManually(
  pattern: string,
  cwd: string,
  options: {
    isRegex: boolean;
    caseSensitive: boolean;
    glob?: string;
    maxResults: number;
    contextLines: number;
  }
): Promise<string> {
  const flags = options.isRegex ? 'g' : 'g';
  let regex: RegExp;
  try {
    const source = options.isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(source, options.caseSensitive ? flags : flags + 'i');
  } catch (e) {
    return `Invalid regex pattern: ${e}`;
  }

  const results: string[] = [];
  let hitCount = 0;

  const walk = (dir: string) => {
    if (hitCount >= options.maxResults) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hitCount >= options.maxResults) {
        break;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skipped = [
          'node_modules',
          '.git',
          'dist',
          'out',
          'build',
          '.venv',
          'venv',
        ];
        if (!skipped.includes(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        // Skip binary-ish extensions
        const ext = path.extname(entry.name).toLowerCase();
        const binaryExts = new Set([
          '.png',
          '.jpg',
          '.jpeg',
          '.gif',
          '.svg',
          '.ico',
          '.woff',
          '.woff2',
          '.ttf',
          '.eot',
          '.pdf',
          '.zip',
          '.tar',
          '.gz',
          '.exe',
          '.dll',
          '.so',
          '.bin',
          '.map',
          '.lock',
        ]);
        if (binaryExts.has(ext)) {
          continue;
        }

        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (hitCount >= options.maxResults) {
            break;
          }
          if (regex.test(lines[i])) {
            regex.lastIndex = 0;
            const ctx = options.contextLines;
            const before = lines.slice(Math.max(0, i - ctx), i);
            const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + ctx));
            const relPath = path.relative(cwd, fullPath);
            const snip = [
              `${relPath}:${i + 1}: ${lines[i]}`,
              ...before.map((l, bi) => `  ${i - before.length + bi + 1}: ${l}`),
              ...after.map((l, ai) => `  ${i + ai + 2}: ${l}`),
            ].join('\n');
            results.push(snip);
            hitCount++;
          }
          regex.lastIndex = 0;
        }
      }
    }
  };

  walk(cwd);

  if (results.length === 0) {
    return 'No matches found.';
  }
  return results.join('\n---\n');
}

export function createSearchFilesTool(
  logger: Logger
): vscode.LanguageModelTool<SearchFilesInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Searching for: ${options.input.pattern}`,
    }),

    invoke: async (options) => {
      const pattern = options.input.pattern?.trim();
      if (!pattern) {
        return makeResult('No search pattern provided.');
      }

      const cwd = workspaceRoot();
      const maxResults = Math.min(options.input.maxResults ?? 50, 200);
      const contextLines = Math.min(options.input.contextLines ?? 2, 10);
      const isRegex = options.input.isRegex ?? false;
      const caseSensitive = options.input.caseSensitive ?? false;

      logger.verbose(
        `[search_files] pattern="${pattern}" regex=${isRegex} case=${caseSensitive} max=${maxResults}`
      );

      let results: string;
      if (hasCommand('rg')) {
        results = await searchWithRipgrep(pattern, cwd, {
          isRegex,
          caseSensitive,
          glob: options.input.glob,
          maxResults,
          contextLines,
        });
      } else {
        results = await searchManually(pattern, cwd, {
          isRegex,
          caseSensitive,
          glob: options.input.glob,
          maxResults,
          contextLines,
        });
      }

      const header = `Search results for "${pattern}" in ${cwd}:\n\n`;
      const full = header + results;
      return makeResult(truncate(full, budgetChars(options)));
    },
  };
}
