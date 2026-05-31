import * as vscode from 'vscode';
import { Logger } from '../logger';
import { TERMINAL_TOOL_NAME, createTerminalTool } from './terminal-tool';
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  LIST_DIRECTORY_TOOL_NAME,
  SEARCH_FILES_TOOL_NAME,
  createReadFileTool,
  createWriteFileTool,
  createListDirectoryTool,
  createSearchFilesTool,
} from './file-tools';
import { IMAGE_GEN_TOOL_NAME, createImageGenTool } from './image-tool';

export {
  TERMINAL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  LIST_DIRECTORY_TOOL_NAME,
  SEARCH_FILES_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
};

/**
 * Registers all LM tools with the extension context.
 * Each tool must also have a matching entry in package.json contributes.languageModelTools.
 */
export function registerAllTools(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(TERMINAL_TOOL_NAME, createTerminalTool(logger)),
    vscode.lm.registerTool(READ_FILE_TOOL_NAME, createReadFileTool(logger)),
    vscode.lm.registerTool(WRITE_FILE_TOOL_NAME, createWriteFileTool(logger)),
    vscode.lm.registerTool(LIST_DIRECTORY_TOOL_NAME, createListDirectoryTool(logger)),
    vscode.lm.registerTool(SEARCH_FILES_TOOL_NAME, createSearchFilesTool(logger)),
    vscode.lm.registerTool(IMAGE_GEN_TOOL_NAME, createImageGenTool(logger))
  );

  logger.info(
    `✅ Registered LM tools: ${
      [
        TERMINAL_TOOL_NAME,
        READ_FILE_TOOL_NAME,
        WRITE_FILE_TOOL_NAME,
        LIST_DIRECTORY_TOOL_NAME,
        SEARCH_FILES_TOOL_NAME,
        IMAGE_GEN_TOOL_NAME,
      ].join(', ')
    }`
  );
}
