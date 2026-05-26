import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export const IMAGE_GEN_TOOL_NAME = 'lmstudio_generate_image';

interface ImageGenInput {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  /** Workspace-relative or absolute path to save the image. Extension auto-appended if omitted. */
  savePath?: string;
}

interface Config {
  backend: 'dalle' | 'a1111';
  endpointUrl: string;
  model: string;
  defaultWidth: number;
  defaultHeight: number;
  defaultSteps: number;
  outputDir: string;
  apiKey: string;
}

// LM Studio's own server has no image generation endpoint.
// These are known LM Studio default addresses — if the user has pointed imageGenEndpointUrl
// at their LM Studio server, we catch it and explain what's needed.
const LMSTUDIO_HOSTS = ['localhost:1234', '127.0.0.1:1234', '0.0.0.0:1234'];
const DEFAULT_DALLE_MODEL = 'dall-e-3';
const DALLE_MODEL_ALIASES: Record<string, string> = {
  'dall-e-2': DEFAULT_DALLE_MODEL,
  'dall-e2': DEFAULT_DALLE_MODEL,
  'dalle-2': DEFAULT_DALLE_MODEL,
  'dalle2': DEFAULT_DALLE_MODEL,
  'dall-e-3': DEFAULT_DALLE_MODEL,
  'dall-e3': DEFAULT_DALLE_MODEL,
  'dalle-3': DEFAULT_DALLE_MODEL,
  'dalle3': DEFAULT_DALLE_MODEL,
};

function normalizeDalleModel(model: string): string {
  const trimmedModel = model.trim();
  const normalizedKey = trimmedModel.toLowerCase().replace(/\s+/g, '');

  if (!normalizedKey) {
    return DEFAULT_DALLE_MODEL;
  }

  const aliasedModel = DALLE_MODEL_ALIASES[normalizedKey];
  if (aliasedModel) {
    return aliasedModel;
  }

  return trimmedModel;
}

function isOpenAiImagesEndpoint(endpointUrl: string): boolean {
  try {
    const hostname = new URL(endpointUrl).hostname.toLowerCase();
    return hostname === 'api.openai.com' || hostname.endsWith('.openai.com');
  } catch {
    return false;
  }
}

function formatAvailableModels(modelIds: string[]): string {
  if (!modelIds.length) {
    return '';
  }

  return ` Available models reported by the server: ${modelIds.join(', ')}.`;
}

function formatDalleError(rawText: string, model: string, availableModels: string[] = []): string {
  if (/"param"\s*:\s*"model"/i.test(rawText) && /"code"\s*:\s*"invalid_value"/i.test(rawText)) {
    return `DALL-E API rejected image model "${model}". Use lmstudio-copilot.imageGenModel = "${DEFAULT_DALLE_MODEL}" for OpenAI, or set it to your backend's exact supported image model name if you are using another OpenAI-compatible image server.${formatAvailableModels(availableModels)} Raw error: ${rawText}`;
  }

  return `DALL-E API error: ${rawText}`;
}

async function fetchAvailableDalleModels(
  config: Config,
  signal: AbortSignal,
  outputChannel: vscode.OutputChannel
): Promise<string[]> {
  const modelsUrl = joinEndpointUrl(config.endpointUrl, '/v1/models');
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  try {
    outputChannel.appendLine(`[generate_image] GET ${modelsUrl}`);
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal,
    });

    if (!response.ok) {
      outputChannel.appendLine(
        `[generate_image] Model discovery failed with status ${response.status}`
      );
      return [];
    }

    const json = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    return json.data
      ?.map((entry) => entry.id?.trim())
      .filter((id): id is string => Boolean(id)) ?? [];
  } catch (error) {
    outputChannel.appendLine(`[generate_image] Model discovery failed: ${error}`);
    return [];
  }
}

async function resolveDalleModel(
  config: Config,
  signal: AbortSignal,
  outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
  if (config.model) {
    return config.model;
  }

  if (isOpenAiImagesEndpoint(config.endpointUrl)) {
    return DEFAULT_DALLE_MODEL;
  }

  const availableModels = await fetchAvailableDalleModels(config, signal, outputChannel);
  if (availableModels.length === 1) {
    outputChannel.appendLine(
      `[generate_image] Auto-selected sole available image model: ${availableModels[0]}`
    );
    return availableModels[0];
  }

  return undefined;
}

function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration('lmstudio-copilot');
  // Default is intentionally empty — user must configure a real image gen server.
  const backend = cfg.get<'dalle' | 'a1111'>('imageGenBackend', 'dalle');
  const configuredModel = cfg.get<string>('imageGenModel', '');

  return {
    backend,
    endpointUrl: cfg.get<string>('imageGenEndpointUrl', ''),
    model: backend === 'dalle' ? normalizeDalleModel(configuredModel) : configuredModel.trim(),
    defaultWidth: cfg.get<number>('imageGenWidth', 1024),
    defaultHeight: cfg.get<number>('imageGenHeight', 1024),
    defaultSteps: cfg.get<number>('imageGenSteps', 20),
    outputDir: cfg.get<string>('imageGenOutputDir', ''),
    apiKey: cfg.get<string>('imageGenApiKey', '').trim(),
  };
}

const SETUP_HELP = `
Image generation requires a dedicated backend server — LM Studio does not have an image generation endpoint.

To use this tool, configure one of the following in VS Code settings (File → Preferences → Settings → Open Settings JSON):

Option A — OpenAI DALL-E:
Get an API key from https://platform.openai.com then add to settings.json:
{
  "lmstudio-copilot.imageGenBackend": "dalle",
  "lmstudio-copilot.imageGenEndpointUrl": "https://api.openai.com",
  "lmstudio-copilot.imageGenApiKey": "sk-...",
  "lmstudio-copilot.imageGenModel": "dall-e-3"
}

Option B — Stable Diffusion / Automatic1111 (local, free):
Install from https://github.com/AUTOMATIC1111/stable-diffusion-webui and launch with the --api flag, then add:
{
  "lmstudio-copilot.imageGenBackend": "a1111",
  "lmstudio-copilot.imageGenEndpointUrl": "http://localhost:7860"
}

Option C — ComfyUI (local, free):
Install from https://github.com/comfyanonymous/ComfyUI with an A1111-compatible API wrapper, then add:
{
  "lmstudio-copilot.imageGenBackend": "a1111",
  "lmstudio-copilot.imageGenEndpointUrl": "http://localhost:8188"
}

After configuring, ask me to generate the image again.`.trim();

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

function joinEndpointUrl(endpointUrl: string, apiPath: string): string {
  const trimmedEndpoint = endpointUrl.trim().replace(/\/+$/, '');
  if (!trimmedEndpoint) {
    return apiPath;
  }

  if (trimmedEndpoint.endsWith(apiPath)) {
    return trimmedEndpoint;
  }

  const apiBase = apiPath.slice(0, apiPath.lastIndexOf('/'));
  if (apiBase && trimmedEndpoint.endsWith(apiBase)) {
    return `${trimmedEndpoint}${apiPath.slice(apiBase.length)}`;
  }

  return `${trimmedEndpoint}${apiPath}`;
}

function makeResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Call DALL-E / OpenAI images endpoint.
 * Handles both b64_json and url response formats automatically.
 * Returns raw PNG/JPEG bytes.
 */
const OPENAI_IMAGE_SIZES: Record<string, [number, number][]> = {
  'dall-e-2': [[256, 256], [512, 512], [1024, 1024]],
  'dall-e-3': [[1024, 1024], [1792, 1024], [1024, 1792]],
  'gpt-image-1': [[1024, 1024], [1536, 1024], [1024, 1536]],
};

const DEFAULT_OPENAI_IMAGE_SIZES = OPENAI_IMAGE_SIZES['gpt-image-1'];

function getOpenAiSizesForModel(model: string | undefined): [number, number][] | undefined {
  const normalizedModel = model?.toLowerCase();
  if (!normalizedModel) {
    return undefined;
  }

  const exact = OPENAI_IMAGE_SIZES[normalizedModel];
  if (exact) {
    return exact;
  }

  return Object.entries(OPENAI_IMAGE_SIZES).find(([knownModel]) =>
    normalizedModel.includes(knownModel)
  )?.[1];
}

function snapToSupportedSize(
  width: number,
  height: number,
  supported: [number, number][],
  outputChannel: vscode.OutputChannel,
  label: string
): string {
  const requested = `${width}x${height}`;
  if (supported.some(([w, h]) => w === width && h === height)) {
    return requested;
  }

  const targetRatio = width / height;
  let best = supported[0];
  let bestDiff = Math.abs(best[0] / best[1] - targetRatio);
  for (const candidate of supported.slice(1)) {
    const diff = Math.abs(candidate[0] / candidate[1] - targetRatio);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }

  const snapped = `${best[0]}x${best[1]}`;
  outputChannel.appendLine(
    `[generate_image] Requested size ${requested} is not supported by ${label}; using ${snapped}.`
  );
  return snapped;
}

function parseSupportedSizes(rawText: string, rejectedSize: string): [number, number][] {
  const seen = new Set<string>();
  const sizes: [number, number][] = [];
  for (const match of rawText.matchAll(/\b(\d{2,5})x(\d{2,5})\b/g)) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    const key = `${width}x${height}`;
    if (key === rejectedSize || seen.has(key)) {
      continue;
    }
    seen.add(key);
    sizes.push([width, height]);
  }

  return sizes;
}

function isInvalidImageSizeError(rawText: string): boolean {
  return /invalid size|supported sizes|unsupported size|"param"\s*:\s*"size"/i.test(rawText);
}

function supportsAutoImageSize(rawText: string): boolean {
  return /\bauto\b/i.test(rawText);
}

function chooseInitialDalleSize(
  endpointUrl: string,
  model: string | undefined,
  width: number,
  height: number,
  outputChannel: vscode.OutputChannel
): string | undefined {
  if (model?.toLowerCase().includes('gpt-image-1') && isOpenAiImagesEndpoint(endpointUrl)) {
    outputChannel.appendLine(
      '[generate_image] Omitting size for gpt-image-1 on OpenAI.'
    );
    return undefined;
  }

  if (isOpenAiImagesEndpoint(endpointUrl)) {
    return snapOpenAiSize(model, width, height, outputChannel);
  }

  outputChannel.appendLine(
    '[generate_image] Using initial size=auto for non-OpenAI image endpoint.'
  );
  return 'auto';
}

function snapOpenAiSize(
  model: string | undefined,
  width: number,
  height: number,
  outputChannel: vscode.OutputChannel
): string {
  const requested = `${width}x${height}`;
  const supported = getOpenAiSizesForModel(model);
  if (!supported) {
    return requested;
  }

  return snapToSupportedSize(width, height, supported, outputChannel, model ?? 'OpenAI image API');
}

async function postDalleRequest(
  generationsUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal,
  outputChannel: vscode.OutputChannel
): Promise<{ response: Response; rawText: string }> {
  outputChannel.appendLine(`[generate_image] POST ${generationsUrl}`);
  outputChannel.appendLine(`[generate_image] Request body: ${JSON.stringify(body)}`);

  const response = await fetch(generationsUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  const rawText = await response.text();
  outputChannel.appendLine(`[generate_image] Response ${response.status}: ${rawText.slice(0, 500)}`);
  return { response, rawText };
}

async function generateDalle(
  input: ImageGenInput,
  config: Config,
  signal: AbortSignal,
  outputChannel: vscode.OutputChannel
): Promise<Uint8Array> {
  const generationsUrl = joinEndpointUrl(config.endpointUrl, '/v1/images/generations');
  // Always honor the user's configured size; ignore any width/height the model
  // tries to pass via tool input (OpenAI image endpoints only accept a fixed set).
  const width = config.defaultWidth;
  const height = config.defaultHeight;
  const model = await resolveDalleModel(config, signal, outputChannel);
  const size = chooseInitialDalleSize(
    config.endpointUrl,
    model,
    width,
    height,
    outputChannel
  );
  const initialSize = size;

  // Do NOT send response_format — many compatible servers (including LM Studio)
  // reject unknown fields or only support the URL format by default.
  // We handle both url and b64_json in the response below.
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    n: 1,
  };

  if (size) {
    body.size = size;
  }

  if (model) {
    body.model = model;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  let { response, rawText } = await postDalleRequest(
    generationsUrl,
    headers,
    body,
    signal,
    outputChannel
  );

  if (!response.ok && isInvalidImageSizeError(rawText)) {
    const serverSizes = parseSupportedSizes(rawText, String(body.size));
    const supportedSizes = serverSizes.length
      ? serverSizes
      : getOpenAiSizesForModel(model) ?? DEFAULT_OPENAI_IMAGE_SIZES;
    const retrySize = supportsAutoImageSize(rawText)
      ? 'auto'
      : snapToSupportedSize(
          width,
          height,
          supportedSizes,
          outputChannel,
          'image API response'
        );

    if (retrySize !== String(body.size)) {
      outputChannel.appendLine(
        `[generate_image] Retrying after invalid size response with size=${retrySize}.`
      );
      body.size = retrySize;
      ({ response, rawText } = await postDalleRequest(
        generationsUrl,
        headers,
        body,
        signal,
        outputChannel
      ));
    }
  }

  if (!response.ok) {
    outputChannel.appendLine(
      `[generate_image] Final DALL-E failure after size handling. model=${model ?? '<unspecified>'} size=${String(body.size)}`
    );
    const availableModels =
      /"param"\s*:\s*"model"/i.test(rawText) && /"code"\s*:\s*"invalid_value"/i.test(rawText)
        ? await fetchAvailableDalleModels(config, signal, outputChannel)
        : [];
    throw new Error(
      `Request meta: model=${model ?? '<unspecified>'} initialSize=${initialSize ?? '<omitted>'} finalSize=${String(body.size ?? '<omitted>')} configuredWidth=${width} configuredHeight=${height}. ${formatDalleError(rawText, model ?? '<unspecified>', availableModels)} (HTTP ${response.status})`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`Non-JSON response from image API: ${rawText.slice(0, 200)}`);
  }

  // Handle both { data: [{ b64_json }] } and { data: [{ url }] } formats
  const data = (json as { data?: { b64_json?: string; url?: string }[] }).data;
  const first = data?.[0];

  if (first?.b64_json) {
    return Buffer.from(first.b64_json, 'base64');
  }

  if (first?.url) {
    outputChannel.appendLine(`[generate_image] Fetching image from URL: ${first.url}`);
    const imgResponse = await fetch(first.url, { signal });
    if (!imgResponse.ok) {
      throw new Error(`Failed to fetch image from URL ${first.url}: ${imgResponse.status}`);
    }
    const buf = await imgResponse.arrayBuffer();
    return new Uint8Array(buf);
  }

  throw new Error(
    `Unexpected response shape from image API. Got: ${rawText.slice(0, 300)}\n\nCheck the "LM Studio Provider" output channel for details.`
  );
}

/**
 * Call Automatic1111 / SD Web UI txt2img endpoint.
 * Returns raw PNG bytes.
 */
async function generateA1111(
  input: ImageGenInput,
  config: Config,
  signal: AbortSignal
): Promise<Uint8Array> {
  const txt2ImgUrl = joinEndpointUrl(config.endpointUrl, '/sdapi/v1/txt2img');
  const body = {
    prompt: input.prompt,
    negative_prompt: input.negativePrompt ?? '',
    width: config.defaultWidth,
    height: config.defaultHeight,
    steps: input.steps ?? config.defaultSteps,
    sampler_name: 'DPM++ 2M Karras',
    cfg_scale: 7,
    n_iter: 1,
    batch_size: 1,
  };

  const response = await fetch(txt2ImgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`A1111 API error ${response.status}: ${text}`);
  }

  const json = (await response.json()) as { images: string[] };
  const b64 = json.images?.[0];
  if (!b64) {
    throw new Error('No image data in A1111 response');
  }

  return Buffer.from(b64, 'base64');
}

/**
 * Resolve where to save the image.
 * Priority: input.savePath > config.outputDir/timestamp.png > workspace root/generated-images/timestamp.png
 */
function resolveSavePath(input: ImageGenInput, config: Config): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `generated-${timestamp}.png`;

  if (input.savePath) {
    const p = path.isAbsolute(input.savePath)
      ? input.savePath
      : path.join(workspaceRoot(), input.savePath);
    // If it's a directory, append filename
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      return path.join(p, filename);
    }
    // Add .png if no extension
    return p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.webp') ? p : `${p}.png`;
  }

  const base = config.outputDir
    ? path.isAbsolute(config.outputDir)
      ? config.outputDir
      : path.join(workspaceRoot(), config.outputDir)
    : path.join(workspaceRoot(), 'generated-images');

  fs.mkdirSync(base, { recursive: true });
  return path.join(base, filename);
}

export function createImageGenTool(
  outputChannel: vscode.OutputChannel
): vscode.LanguageModelTool<ImageGenInput> {
  return {
    prepareInvocation: (options) => ({
      invocationMessage: `Generating image: "${options.input.prompt.slice(0, 80)}${options.input.prompt.length > 80 ? '…' : ''}"`,
    }),

    invoke: async (options, token) => {
      const config = getConfig();
      const { prompt } = options.input;

      outputChannel.appendLine(
        `[generate_image] resolved config: backend=${config.backend} model=${config.model || '<unset>'} endpoint=${config.endpointUrl} width=${config.defaultWidth} height=${config.defaultHeight}`
      );

      if (!prompt?.trim()) {
        return makeResult('No prompt provided.');
      }

      if (config.backend === 'dalle' && !config.apiKey) {
        return makeResult(
          'Image generation API key is not configured. Set lmstudio-copilot.imageGenApiKey for the DALL-E/OpenAI-compatible image backend.'
        );
      }

      // Guard: endpoint must be configured and must not be LM Studio's server
      const endpointIsEmpty = !config.endpointUrl.trim();
      const urlLower = config.endpointUrl.toLowerCase();
      const isLmStudioUrl = LMSTUDIO_HOSTS.some((h) => urlLower.includes(h));
      outputChannel.appendLine(
        `[generate_image] config: backend="${config.backend}" endpointUrl="${config.endpointUrl}" empty=${endpointIsEmpty} isLmStudio=${isLmStudioUrl}`
      );
      if (endpointIsEmpty || isLmStudioUrl) {
        outputChannel.appendLine('[generate_image] No valid image gen endpoint configured — returning setup help');
        return makeResult(SETUP_HELP);
      }

      outputChannel.appendLine(
        `[generate_image] backend=${config.backend} prompt="${prompt.slice(0, 100)}"`
      );

      const abortController = new AbortController();
      token.onCancellationRequested(() => abortController.abort());

      let imageBytes: Uint8Array;
      try {
        if (config.backend === 'a1111') {
          imageBytes = await generateA1111(options.input, config, abortController.signal);
        } else {
          imageBytes = await generateDalle(options.input, config, abortController.signal, outputChannel);
        }
      } catch (e) {
        outputChannel.appendLine(`[generate_image] ERROR: ${e}`);
        return makeResult(`Image generation failed: ${e}`);
      }

      outputChannel.appendLine(`[generate_image] Generated ${imageBytes.length} bytes`);

      // Save to disk
      const savePath = resolveSavePath(options.input, config);
      try {
        fs.writeFileSync(savePath, imageBytes);
        outputChannel.appendLine(`[generate_image] Saved to: ${savePath}`);
      } catch (e) {
        outputChannel.appendLine(`[generate_image] Save failed: ${e}`);
      }

      // Open the saved file in VS Code if saving succeeded
      try {
        const uri = vscode.Uri.file(savePath);
        await vscode.commands.executeCommand('vscode.open', uri);
      } catch {
        // Non-fatal — image is still returned to chat
      }

      // Return image inline in chat
      const relPath = path.relative(workspaceRoot(), savePath);
      const caption = `Generated image saved to: ${relPath}\nPrompt: "${prompt}"`;

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(caption),
        vscode.LanguageModelDataPart.image(imageBytes, 'image/png'),
      ]);
    },
  };
}
