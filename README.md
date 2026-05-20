# LM Studio for Copilot Chat

Run local LM Studio models inside VS Code Copilot Chat with streaming responses, tool calling, and optional image generation.

If LM Studio is installed on your machine, the extension is designed to work out of the box. It also supports connecting to remote LM Studio servers.

Install from the VS Code Marketplace:

[DanLambiase.lmstudio-copilot-provider](https://marketplace.visualstudio.com/items?itemName=DanLambiase.lmstudio-copilot-provider)

## What it does

- Adds LM Studio models to the Copilot Chat model picker
- Streams responses directly into VS Code chat
- Can auto-start LM Studio and lazy-load the selected model on first use (when using localhost)
- Supports remote LM Studio servers without local CLI dependencies

## Requirements

- VS Code 1.104.0 or later
- LM Studio server accessible at the configured URL (default: `http://localhost:1234`)
- For local usage: LM Studio installed on your machine
- For remote usage: Access to a running LM Studio server on another machine

## Quick Start

1. Install this extension.
2. Open Copilot Chat.
3. Pick an LM Studio model.
4. Send a prompt.

No separate CLI install, PATH setup, or manual model preload should be required for local setups.

## Remote Server Usage

You can connect to an LM Studio server running on a remote machine:

1. Set `lmstudio-copilot.serverUrl` to the remote server's URL (e.g., `http://your-server:1234`).
2. Ensure the remote server is running and accessible.
3. When using a remote server, local CLI features (auto-start, model discovery via CLI) are automatically disabled to avoid attempting to control the remote instance.

This is useful for setups where LM Studio runs on a dedicated server or in a container.

## About The CLI

You do not need to install the LM Studio CLI separately.

The CLI ships with LM Studio, and the extension will try to find it automatically for local installations.

The extension tries to find the CLI in this order:

- `lmstudio-copilot.cliPath`
- `lms` on `PATH`
- common LM Studio install locations

For most users, nothing needs to be configured here. CLI features are skipped when using remote servers.

## Important Settings

Most users can leave the defaults alone. These are the settings that matter most:

- `lmstudio-copilot.serverUrl`: LM Studio server URL (default: `http://localhost:1234`)
- `lmstudio-copilot.cliPath`: Override the LM Studio CLI path if auto-detection does not find it
- `lmstudio-copilot.autoStartServer`: Start LM Studio automatically when the extension activates
- `lmstudio-copilot.launchCommand`: Fallback terminal command if CLI-based startup is unavailable
- `lmstudio-copilot.enableToolCalling`: Enable tool calling for supported models
- `lmstudio-copilot.maxTools`: Limit the number of tools exposed per request
- `lmstudio-copilot.imageGenEndpointUrl`: Base URL for DALL-E/OpenAI-compatible or A1111 image generation
- `lmstudio-copilot.imageGenApiKey`: Dedicated API key for image generation backends such as OpenAI DALL-E

## Commands

- `LM Studio: Refresh Available Models`
- `LM Studio: Start Server in Integrated Terminal`
- `LM Studio: Stop Server Terminal`
- `LM Studio: Check Server Connection`

## Usage

Select an LM Studio model in Copilot Chat and start chatting. The extension will use LM Studio automatically and, when possible, start the local server and load the selected model for you.

## Optional Features

- Tool calling for supported local models
- Optional image generation through A1111 or DALL-E-compatible endpoints

### DALL-E Setup

Use these settings for OpenAI image generation:

```json
{
	"lmstudio-copilot.imageGenBackend": "dalle",
	"lmstudio-copilot.imageGenEndpointUrl": "https://api.openai.com",
	"lmstudio-copilot.imageGenApiKey": "sk-...",
	"lmstudio-copilot.imageGenModel": "dall-e-3"
}
```

`lmstudio-copilot.imageGenApiKey` is completely separate from `lmstudio-copilot.apiKey`. Chat requests keep using the LM Studio server key, and image generation uses only the dedicated image backend key.

## Troubleshooting

### Models not appearing

- Make sure LM Studio is running
- Check `lmstudio-copilot.serverUrl`
- Run `LM Studio: Check Server Connection`
- If LM Studio is installed in a non-standard location, set `lmstudio-copilot.cliPath`

### Slow responses

- LM Studio performance depends on your hardware and the model size
- Consider using a smaller/faster model
- Increase the timeout in settings if needed

## Development

```bash
# Install dependencies
npm install

# Compile and watch
npm run watch

# Package the extension
npm run package

# Build a VSIX for local install / Marketplace submission
npm run package:vsix
```

## License

MIT
