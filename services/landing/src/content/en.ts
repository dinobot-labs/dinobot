/** Product copy; historical privacy semantics preserved. */
export const en = {
  "meta": {
    "title": "Dinobot — Work on your files with AI.",
    "description": "Use your AI model to read and edit project files and run commands from Desktop or the terminal. Connect Slack, Discord or Telegram when your team needs a chat entry point.",
    "ogLocale": "en_US",
    "ogLocaleAlt": "ko_KR",
    "ogImage": "/brand/og-en.png",
    "ogImageAlt": "Dinobot — desktop and terminal agent",
    "isKo": false
  },
  "a11y": {
    "skip": "Skip to content",
    "language": "Language",
    "mainNav": "Main",
    "home": "Dinobot home",
    "footerNav": "Footer"
  },
  "nav": {
    "home": "/",
    "product": "Product",
    "install": "Install",
    "faq": "FAQ",
    "cta": "Install"
  },
  "hero": {
    "eyebrow": "AI for project work",
    "title": "Work on your files with AI.",
    "body": "Use your AI model to read and edit project files and run commands from Desktop or the terminal. Connect Slack, Discord or Telegram when your team needs a chat entry point.",
    "setup": "Your model account is required. Chat channels and optional tools need configuration.",
    "primary": "Get Dinobot",
    "secondary": "See a workflow",
    "open": "Open original image",
    "caption": "Scripted app demo: local mock model, real file and command execution. JavaScript syntax check only—not a full test suite.",
    "alt": "Dinobot Desktop in its native light theme: a README request, actual bash execution, and the newly written getting-started guide.",
    "detailAlt": "Actual bash output showing README contents and the generated GETTING_STARTED.md guide after node --check app.js.",
    "unavailable": "Image unavailable. Use the original image link.",
    "imageHint": "Real Desktop · README → getting-started guide",
    "mobileHint": "Scroll the image to read the complete command, or open the original."
  },
  "interfaces": {
    "title": "Different ways to reach the agent",
    "desktop": "A dedicated graphical client, downloaded separately. Requires a compatible Dinobot daemon.",
    "cli": "The terminal interface to the local agent daemon. Closing the TUI does not stop that daemon.",
    "chat": "Configured chat",
    "chatBody": "Slack, Discord or Telegram adapters for permitted users and destinations—not a hosted shared workspace.",
    "privacy": "These are entry points to the agent, not a promise that conversations move automatically between them.",
    "eyebrow": "Desktop · Terminal · Chat",
    "daemon": "Local agent daemon",
    "model": "Selected model provider",
    "tools": "Files, commands & configured tools",
    "diagramLabel": "Desktop, TUI and configured chat connect to the local agent daemon, which uses a selected external model provider and available tools."
  },
  "install": {
    "title": "Get Dinobot.",
    "installer": "Download installer",
    "zip": "Download ZIP",
    "unsigned": "Unsigned Windows installer and app.",
    "checksums": "Checksums",
    "linux": "Linux: use the CLI/TUI. No Linux Desktop download is listed.",
    "cliTitle": "Install the CLI / TUI.",
    "requires": "Requires Bun 1.4.2 or newer, already installed. These commands do not install Bun.",
    "os": "Command for",
    "copy": "Copy command",
    "pending": "Copying…",
    "copied": "Copied",
    "success": "Command copied.",
    "manual": "Copy unavailable. Select and copy the command.",
    "path": "Use the launcher path printed by the installer, or add its bin directory to PATH yourself. PATH is not changed automatically; an older global install may take precedence.",
    "details": "Launcher paths and updates",
    "updates": "By default, Windows uses LOCALAPPDATA/dinobot/bin/dinobot.cmd; macOS and Linux use ~/.local/bin/dinobot. A custom DINOBOT_INSTALL_DIR changes the location. The managed launcher checks for updates each time it starts. A running daemon changes version at its next natural startup through that launcher—not when you only close the TUI. Old global installs are not migrated automatically."
  },
  "faq": {
    "title": "Before you start.",
    "rows": [
      {
        "q": "Do I need a model account?",
        "a": "Yes. Sign in with your own model-provider credentials and choose a model. The download does not include unlimited model usage."
      },
      {
        "q": "Are Desktop and the CLI the same download?",
        "a": "No. Desktop is a separate client. The CLI installer installs the core daemon and terminal interface, not Desktop."
      },
      {
        "q": "Which platforms are available?",
        "a": "Desktop downloads listed here are Windows x64 0.1.5, unsigned, and macOS Apple Silicon/Intel 0.1.4. There is no listed Linux Desktop download. The CLI/TUI supports Windows, macOS and Linux with Bun 1.4.2 or newer."
      },
      {
        "q": "When do managed updates take effect?",
        "a": "The managed launcher checks when launched. A running daemon uses its current files until its next natural startup through that launcher. Closing only the TUI does not restart it. Old global installs are not automatically migrated or updated by this launcher."
      },
      {
        "q": "Is Dinobot open source?",
        "a": "The source is available under PolyForm Noncommercial 1.0.0. This is not an OSI-approved open-source license or unrestricted permission for commercial use."
      },
      {
        "q": "Does everything stay on my device?",
        "a": "No. Dinobot runs locally, but external-model requests go to your chosen provider. Connected channels and tools may also communicate with external services. Review the services you configure."
      }
    ]
  },
  "footer": {
    "core": "Core source",
    "desktop": "Desktop source",
    "privacy": "Privacy",
    "privacyHref": "/privacy/",
    "license": "Source available · PolyForm Noncommercial",
    "legal": "©2026 Dinobot",
    "tagline": "Work on your files with AI."
  },
  "privacy": {
    "title": "Privacy notice · dinobot waitlist",
    "description": "How the dinobot waitlist collects, uses and stores your email address.",
    "eyebrow": "Privacy",
    "h1": "Waitlist privacy notice",
    "lede": "This notice covers the email waitlist on this site and nothing else. It explains what we collect, why, where it is stored and how to have it removed.",
    "effectiveLabel": "Effective",
    "effective": "2026-10-11",
    "back": "Back to the home page",
    "sections": [
      {
        "title": "Who is responsible",
        "html": "The waitlist is run by 정승현, who decides how this data is used. Contact: <a href=\"mailto:dev0jsh@gmail.com\">dev0jsh@gmail.com</a>."
      },
      {
        "title": "What we collect",
        "html": "Your email address, the language of the page you signed up on, the time you signed up, which form you used (optional), and the version of the consent text you agreed to. We do not store your IP address or browser details with your entry."
      },
      {
        "title": "Why we collect it",
        "html": "To send you waitlist updates and an invitation when early access opens. Nothing else: no advertising, no profiling."
      },
      {
        "title": "How long we keep it",
        "html": "Until one year after launch, or until you withdraw, whichever comes first. Then the entry is deleted."
      },
      {
        "title": "Where it is stored",
        "html": "In a Cloudflare D1 database operated by Cloudflare, Inc. (United States) with an Asia-Pacific location hint. This means your email is transferred to and stored on servers outside Korea. It is sent over an encrypted connection when you submit the form and is kept for the period above."
      },
      {
        "title": "Sharing",
        "html": "We do not sell your email or share it with anyone. Cloudflare stores it on our behalf as the hosting provider."
      },
      {
        "title": "Your rights",
        "html": "You can ask to see, correct or delete your entry, or withdraw your consent, at any time by emailing <a href=\"mailto:dev0jsh@gmail.com\">dev0jsh@gmail.com</a>. We act on requests without delay."
      },
      {
        "title": "You may refuse",
        "html": "Joining is optional. If you do not agree, simply don't submit the form; the only consequence is that you won't be on the waitlist."
      },
      {
        "title": "Cookies",
        "html": "This site sets one cookie, <code>lang</code>, and only when you switch languages, to remember your choice. There are no analytics or advertising cookies."
      }
    ]
  },
  "notFound": {
    "title": "Page not found · dinobot",
    "description": "This page does not exist.",
    "eyebrow": "404",
    "h1": "This page doesn't exist.",
    "body": "The link may be old, or the address has a typo. Downloads are on the home page.",
    "home": "Go to the home page",
    "mascot": "dinobot with crossed-out eyes"
  },
  "workflow": {
    "eyebrow": "A task, from request to result",
    "title": "From a project folder to a getting-started guide",
    "exampleLabel": "Example request",
    "request": "Read the README, write GETTING_STARTED.md, run node --check app.js, and show me the output.",
    "intro": "One small project. A document written to disk. A command result you can inspect.",
    "steps": [
      {
        "title": "Read the project",
        "command": "cat README.md",
        "body": "Read the existing project notes before writing the guide."
      },
      {
        "title": "Write the guide",
        "command": "GETTING_STARTED.md",
        "body": "Write a short getting-started document into the project folder."
      },
      {
        "title": "Check syntax",
        "command": "node --check app.js",
        "body": "Check JavaScript syntax. This does not run the app or test its behavior."
      },
      {
        "title": "Read the result",
        "command": "cat GETTING_STARTED.md",
        "body": "Print the new guide so its contents can be reviewed."
      }
    ],
    "result": "The visible result: GETTING_STARTED.md, with a command to run the demo. The app itself was not run.",
    "detail": "Actual file and command output"
  },
  "features": {
    "eyebrow": "What changes in your work",
    "title": "Beyond advice in a chat window",
    "rows": [
      {
        "title": "Work with files and commands",
        "problem": "Copying an answer into your project is still work.",
        "body": "Let the selected model use read, write, edit and command tools. Inspect the changed file and command output rather than only a suggested answer.",
        "example": "In this demo: a new GETTING_STARTED.md and its printed contents."
      },
      {
        "title": "Choose your model and tools",
        "problem": "Your model needs a connection to your working setup.",
        "body": "Sign in to a provider and select an available model. Configure additional integrations for the tasks you need; model usage is not included with the download.",
        "example": "Start with /login and /model. MCP connects tools; it is not a model provider."
      },
      {
        "title": "Bring requests from team chat",
        "problem": "Team requests often start outside the terminal.",
        "body": "Configure Slack, Discord or Telegram credentials and access settings so permitted people can request work in a connected channel.",
        "example": "Chat requires setup. It is not automatic conversation transfer between interfaces."
      }
    ]
  },
  "configuration": {
    "eyebrow": "Before the first request",
    "title": "Your model. Your setup.",
    "rows": [
      {
        "title": "Connect and choose",
        "body": "Use /login to connect a provider and /model to select an available model. Your credentials and provider usage are your responsibility."
      },
      {
        "title": "Add integrations deliberately",
        "body": "File and command tools are core. Browser, computer and MCP integrations have their own setup, dependencies and accounts. Chat needs credentials and access configuration."
      },
      {
        "title": "Understand the boundary",
        "body": "Local execution is not isolation or a promise of privacy. External models and connected services may receive data. The HTTP API is unauthenticated: keep it on loopback with trusted local accounts; do not expose it to the Internet."
      }
    ],
    "security": "Read the security guidance",
    "license": "Source available under PolyForm Noncommercial 1.0.0, not OSI-approved open source. Commercial use requires separate written permission.",
    "licenseLink": "Read the license"
  },
  "start": {
    "title": "Then make your first request",
    "body": "Launch Dinobot in your project folder, connect your provider with /login, choose an available model with /model, and start with a small task you can review.",
    "link": "Return to the example workflow"
  }
};
export type Content = typeof en;
