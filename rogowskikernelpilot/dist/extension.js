"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var import_node_crypto = require("node:crypto");
var KernelPilotChatProvider = class {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }
  extensionUri;
  static viewType = "kernelpilot.chat";
  view;
  history = [];
  systemPrompt = [
    "You are KernelPilot, a local AI programming assistant inside VS Code.",
    "Always respond in English by default, unless the user explicitly requests another language.",
    "Help users understand, write, debug, refactor, optimize, and convert code.",
    "You can generate complete implementations, including conversions between C++, CUDA C++, Python, and other programming languages.",
    "Do not refuse ordinary programming tasks without a concrete reason.",
    "When asked to convert code, provide a practical implementation instead of only general advice.",
    "Preserve the original functionality unless the user requests a change.",
    "Never invent variables, function arguments, APIs, or compiler features.",
    "Check types, declarations, array bounds, indexing, memory ownership, and error handling.",
    "For CUDA code, consider host and device memory, memory transfers, kernel launch configuration, thread indexing, synchronization when needed, and CUDA error checking.",
    "When converting CPU code to CUDA, provide the necessary host-side wrapper and memory management when appropriate, not only a kernel.",
    "Explain important assumptions and limitations.",
    "Use Markdown headings, lists, and fenced code blocks with the appropriate language identifier.",
    "When reviewing code, distinguish actual bugs from possible improvements.",
    "Do not claim that code has been compiled, executed, or tested unless it actually has.",
    "If information is missing, ask a focused question or state reasonable assumptions.",
    "Prefer accurate, clear, useful answers over unnecessarily long explanations."
  ].join(" ");
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    console.log("[KernelPilot] Chat panel opened.");
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage(
      async (message) => {
        if (!message || typeof message.type !== "string") {
          return;
        }
        if (message.type === "clear") {
          this.history = [];
          console.log("[KernelPilot] Conversation history cleared.");
          return;
        }
        if (message.type !== "send" || typeof message.text !== "string") {
          return;
        }
        const text = message.text.trim();
        if (!text) {
          return;
        }
        this.history.push({
          role: "user",
          content: text
        });
        try {
          const reply = await this.getOllamaReply();
          this.history.push({
            role: "assistant",
            content: reply
          });
          const maxHistoryMessages = 20;
          if (this.history.length > maxHistoryMessages) {
            this.history = this.history.slice(
              -maxHistoryMessages
            );
          }
          await webview.postMessage({
            type: "reply",
            text: reply
          });
        } catch (error) {
          this.history.pop();
          const details = error instanceof Error ? error.message : "Unknown error.";
          console.error(
            "[KernelPilot] Ollama error:",
            error
          );
          await webview.postMessage({
            type: "reply",
            text: "I could not get a response from Ollama.\n\nMake sure Ollama is running and the model qwen2.5-coder:3b is installed.\n\nDetails: " + details
          });
        }
      }
    );
  }
  async getOllamaReply() {
    const startedAt = Date.now();
    console.log(
      `[KernelPilot] Sending request to Ollama. History messages: ${this.history.length}`
    );
    const response = await fetch(
      "http://127.0.0.1:11434/api/chat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen2.5-coder:3b",
          messages: [
            {
              role: "system",
              content: this.systemPrompt
            },
            ...this.history
          ],
          stream: false
        }),
        signal: AbortSignal.timeout(12e4)
      }
    );
    console.log(
      `[KernelPilot] Ollama responded after ${Date.now() - startedAt} ms`
    );
    if (!response.ok) {
      throw new Error(
        `Ollama returned HTTP status ${response.status}`
      );
    }
    const data = await response.json();
    if (data.error) {
      throw new Error(data.error);
    }
    const answer = data.message?.content?.trim();
    if (!answer) {
      throw new Error("The model returned an empty response.");
    }
    return answer;
  }
  sendCodeToChat(code) {
    if (!this.view) {
      vscode.window.showWarningMessage(
        "Open the KernelPilot panel first."
      );
      return;
    }
    this.view.show?.(true);
    void this.view.webview.postMessage({
      type: "insertCode",
      text: code
    });
  }
  getHtml(webview) {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <meta
        http-equiv="Content-Security-Policy"
        content="${csp};"
    >

    <title>KernelPilot Chat</title>

    <style>
        :root {
            color-scheme: light dark;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 12px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        .header {
            margin-bottom: 18px;
        }

        .logo {
            font-size: 21px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }

        .subtitle {
            margin-top: 5px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        #messages {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 16px;
        }

        .message {
            min-width: 0;
            padding: 10px 12px;
            border-radius: 8px;
            line-height: 1.5;
            overflow-wrap: anywhere;
            white-space: pre-wrap;
        }

        .assistant {
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-focusBorder);
        }

        .user {
            background: var(--vscode-input-background);
            border: 1px solid
                var(--vscode-input-border, transparent);
        }

        .label {
            display: block;
            margin-bottom: 5px;
            font-size: 11px;
            font-weight: 700;
            color: var(--vscode-descriptionForeground);
        }

        .composer {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        textarea {
            width: 100%;
            min-height: 76px;
            resize: vertical;
            padding: 9px;
            border-radius: 5px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            font: inherit;
        }

        textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        button {
            padding: 8px 12px;
            border: none;
            border-radius: 5px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            cursor: pointer;
            font: inherit;
        }

        button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button:disabled {
            opacity: 0.6;
            cursor: default;
        }

        .secondary {
            color: var(--vscode-foreground);
            background: transparent;
            border: 1px solid
                var(
                    --vscode-button-border,
                    var(--vscode-panel-border)
                );
        }

        .actions {
            display: flex;
            gap: 8px;
        }

        .actions button:first-child {
            flex: 1;
        }

        .hint {
            margin-top: 12px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
    </style>
</head>

<body>
    <header class="header">
        <div class="logo">KernelPilot</div>
        <div class="subtitle">
            Your local AI programming assistant
        </div>
    </header>

    <main id="messages" aria-live="polite">
        <div class="message assistant">
            <span class="label">KERNELPILOT</span>
            <div>Hi! \u{1F44B} I'm KernelPilot.

Ask a programming question, paste some code, or describe a bug. I'll help you analyze it.</div>
        </div>
    </main>

    <form id="composer" class="composer">
        <textarea
            id="input"
            placeholder="Ask a programming question..."
            aria-label="Message"
            required
        ></textarea>

        <div class="actions">
            <button id="send" type="submit">Send \u2191</button>
            <button
                id="clear"
                class="secondary"
                type="button"
            >
                Clear
            </button>
        </div>
    </form>

    <div class="hint">
        Local AI \xB7 Ollama \xB7 qwen2.5-coder:3b
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const messages = document.getElementById('messages');
        const input = document.getElementById('input');
        const send = document.getElementById('send');
        const clear = document.getElementById('clear');
        const form = document.getElementById('composer');

        let waitingForReply = false;

        function addMessage(text, role) {
            const article = document.createElement('div');
            article.className = 'message ' + role;

            const label = document.createElement('span');
            label.className = 'label';
            label.textContent =
                role === 'user' ? 'YOU' : 'KERNELPILOT';

            const content = document.createElement('div');

            // textContent prevents model output from being interpreted as HTML.
            content.textContent = text;

            article.append(label, content);
            messages.appendChild(article);

            article.scrollIntoView({
                block: 'nearest',
                behavior: 'smooth'
            });
        }

        function setWaiting(waiting) {
            waitingForReply = waiting;
            send.disabled = waiting;
            input.disabled = waiting;
            clear.disabled = waiting;

            send.textContent = waiting
                ? 'Thinking...'
                : 'Send \u2191';
        }

        form.addEventListener('submit', (event) => {
            event.preventDefault();

            const text = input.value.trim();

            if (!text || waitingForReply) {
                return;
            }

            addMessage(text, 'user');

            input.value = '';
            setWaiting(true);

            vscode.postMessage({
                type: 'send',
                text
            });
        });

        clear.addEventListener('click', () => {
            if (waitingForReply) {
                return;
            }

            vscode.postMessage({
                type: 'clear'
            });

            messages.replaceChildren();

            const welcome = document.createElement('div');
            welcome.className = 'message assistant';

            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = 'KERNELPILOT';

            const content = document.createElement('div');
            content.textContent =
                'Conversation cleared. How can I help?';

            welcome.append(label, content);
            messages.appendChild(welcome);

            input.focus();
        });

        window.addEventListener('message', (event) => {
            const message = event.data;

            if (
                !message ||
                typeof message.type !== 'string'
            ) {
                return;
            }

            if (
                message.type === 'insertCode' &&
                typeof message.text === 'string'
            ) {
                const codePrompt =
                    'Explain the following code, describe how it works, ' +
                    'and identify potential bugs:\\n\\n' +
                    '\`\`\`\\n' + message.text + '\\n\`\`\`';

                input.value = codePrompt;
                input.focus();

                return;
            }

            if (
                message.type === 'reply' &&
                typeof message.text === 'string'
            ) {
                addMessage(message.text, 'assistant');
                setWaiting(false);
                input.focus();
            }
        });

        input.addEventListener('keydown', (event) => {
            if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.isComposing
            ) {
                event.preventDefault();
                form.requestSubmit();
            }
        });
    </script>
</body>
</html>`
    );
  }
};
function getNonce() {
  return (0, import_node_crypto.randomBytes)(16).toString("hex");
}
function activate(context) {
  console.log("[KernelPilot] Extension activated.");
  const provider = new KernelPilotChatProvider(
    context.extensionUri
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      KernelPilotChatProvider.viewType,
      provider
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rogowskikernelpilot.helloWorld",
      () => {
        vscode.window.showInformationMessage(
          "Hello World from KernelPilot!"
        );
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rogowskikernelpilot.explainSelection",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage(
            "Open a file containing code first."
          );
          return;
        }
        const selection = editor.selection;
        const code = editor.document.getText(selection);
        if (!code.trim()) {
          vscode.window.showWarningMessage(
            "Select a code fragment first."
          );
          return;
        }
        provider.sendCodeToChat(code);
      }
    )
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
