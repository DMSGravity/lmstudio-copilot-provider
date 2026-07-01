import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
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
    : 24000;
}

// Directories to skip when walking the tree
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  'coverage',
  '.nyc_output',
  '.tsbuildinfo',
]);

// Binary/non-useful extensions to skip
const BINARY_EXTS = new Set([
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
  '.vsix',
  '.snap',
]);

// Extensions that are worth symbol-scanning
const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.swift',
  '.kt',
  '.php',
  '.vue',
  '.svelte',
]);

interface FileEntry {
  relPath: string;
  sizeBytes: number;
  symbols: string[];
}

/**
 * Extracts top-level declaration names from source code using simple regex patterns.
 * Works for TypeScript, JavaScript, Python, Go, Rust, Java, C#, etc.
 */
function extractSymbols(content: string, ext: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();

  const add = (name: string) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      symbols.push(name);
    }
  };

  const patterns: RegExp[] = [];

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    // export function foo / export async function foo
    patterns.push(/^\s*export\s+(?:async\s+)?function\s+(\w+)/gm);
    // export class Foo
    patterns.push(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm);
    // export const foo / export let foo / export var foo
    patterns.push(/^\s*export\s+(?:const|let|var)\s+(\w+)/gm);
    // export type Foo / export interface Foo / export enum Foo
    patterns.push(/^\s*export\s+(?:type|interface|enum)\s+(\w+)/gm);
    // export default function foo
    patterns.push(/^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)/gm);
    // export default class Foo
    patterns.push(/^\s*export\s+default\s+class\s+(\w+)/gm);
  } else if (ext === '.py') {
    patterns.push(/^\s*def\s+(\w+)/gm);
    patterns.push(/^\s*class\s+(\w+)/gm);
    patterns.push(/^\s*async\s+def\s+(\w+)/gm);
  } else if (ext === '.go') {
    // Matches top-level functions and methods. The optional receiver group handles
    // simple cases (e.g. `(r *Receiver)`) but does not cover all valid receiver
    // syntaxes such as generics — this is a best-effort heuristic.
    patterns.push(/^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm);
    patterns.push(/^\s*type\s+(\w+)\s+(?:struct|interface)/gm);
  } else if (ext === '.rs') {
    patterns.push(/^\s*pub\s+(?:async\s+)?fn\s+(\w+)/gm);
    patterns.push(/^\s*pub\s+struct\s+(\w+)/gm);
    patterns.push(/^\s*pub\s+enum\s+(\w+)/gm);
    patterns.push(/^\s*pub\s+trait\s+(\w+)/gm);
  } else if (['.java', '.cs'].includes(ext)) {
    patterns.push(/^\s*(?:public|protected|private|internal)\s+(?:static\s+)?(?:\w+\s+)*class\s+(\w+)/gm);
    // Match method declarations: require a return type keyword before the name, and
    // end with `(` — this avoids matching constructor calls and plain invocations.
    patterns.push(/^\s*(?:public|protected|private|internal)\s+(?:static\s+)?(?:override\s+|virtual\s+|abstract\s+)?(?:void|int|long|bool|boolean|string|String|double|float|byte|short|char|\w+(?:<[^>]+>)?(?:\[\])?)\s+(\w+)\s*\(/gm);
  } else if (ext === '.rb') {
    patterns.push(/^\s*def\s+(\w+)/gm);
    patterns.push(/^\s*class\s+(\w+)/gm);
    patterns.push(/^\s*module\s+(\w+)/gm);
  }

  for (const regex of patterns) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      add(m[1]);
    }
  }

  return symbols;
}

function collectFiles(
  dir: string,
  rootDir: string,
  maxFileSizeBytes: number,
  includeSymbols: boolean,
  results: FileEntry[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        collectFiles(fullPath, rootDir, maxFileSizeBytes, includeSymbols, results);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (BINARY_EXTS.has(ext)) {
      continue;
    }

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(fullPath).size;
    } catch {
      continue;
    }

    const symbols: string[] = [];
    if (includeSymbols && CODE_EXTS.has(ext) && sizeBytes <= maxFileSizeBytes) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        symbols.push(...extractSymbols(content, ext));
      } catch {
        // best-effort; skip on read error
      }
    }

    results.push({ relPath, sizeBytes, symbols });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── codebase_index tool ──────────────────────────────────────────────────────

export const CODEBASE_INDEX_TOOL_NAME = 'lmstudio_get_codebase_index';

interface CodebaseIndexInput {
  includeSymbols?: boolean;
  maxFileSizeKB?: number;
}

export function createCodebaseIndexTool(
  logger: Logger
): vscode.LanguageModelTool<CodebaseIndexInput> {
  return {
    prepareInvocation: () => ({
      invocationMessage: 'Indexing codebase…',
    }),

    invoke: async (options) => {
      const root = workspaceRoot();
      const includeSymbols = options.input.includeSymbols ?? true;
      const requestedKB = options.input.maxFileSizeKB ?? 128;
      const cappedKB = Math.min(requestedKB, 512);
      if (requestedKB > 512) {
        logger.verbose(
          `[get_codebase_index] maxFileSizeKB ${requestedKB} exceeds cap of 512; clamped to 512`
        );
      }
      const maxFileSizeBytes = cappedKB * 1024;

      logger.verbose(
        `[get_codebase_index] root="${root}" symbols=${includeSymbols} maxFileSize=${maxFileSizeBytes}`
      );

      const files: FileEntry[] = [];
      collectFiles(root, root, maxFileSizeBytes, includeSymbols, files);

      if (files.length === 0) {
        return makeResult('No files found in workspace.');
      }

      const lines: string[] = [
        `Codebase Index: ${root}`,
        `Files indexed: ${files.length}`,
        '',
      ];

      for (const file of files) {
        const sizeLabel = formatSize(file.sizeBytes);
        if (file.symbols.length > 0) {
          lines.push(`${file.relPath} (${sizeLabel})`);
          lines.push(`  symbols: ${file.symbols.join(', ')}`);
        } else {
          lines.push(`${file.relPath} (${sizeLabel})`);
        }
      }

      const full = lines.join('\n');
      const budget = budgetChars(options);
      logger.verbose(`[get_codebase_index] raw output ${full.length} chars, budget ${budget}`);

      return makeResult(truncate(full, budget));
    },
  };
}
