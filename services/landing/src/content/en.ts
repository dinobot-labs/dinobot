/** Product copy; historical privacy semantics preserved. */

export const en = {
  "meta": {
    "title": "Dinobot — An agent for what’s next.",
    "description": "Work from your desktop or terminal. Choose your model and connect team chat.",
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
    "eyebrow": "DESKTOP + TERMINAL",
    "line1": "An agent for",
    "line2": "what’s next.",
    "sub1": "Work from your desktop or terminal.",
    "sub2": "Choose your model and connect team chat.",
    "primary": "Get Dinobot",
    "source": "View source",
    "demo": "Scripted app demo",
    "blue": "Blue",
    "black": "Black",
    "open": "Open full image",
    "caption": "Product demo · scripted conversation with a mock provider in the real desktop app.",
    "altBlue": "Dinobot desktop in blue, with an expanded bash result listing three project files.",
    "altBlack": "Dinobot desktop in black, with an expanded bash result listing three project files.",
    "unavailable": "Preview unavailable. Open original image."
  },
  "tools": {
    "title": "Ask in your own words. See the tools at work.",
    "body": "This demo asks for the files in a small project. The expanded bash result shows the command and its output.",
    "label": "Tool result detail · scripted app demo"
  },
  "workflows": {
    "title": "Choose how you work.",
    "rows": [
      {
        "title": "Choose a model.",
        "body": "Sign in to your model provider, then select a model."
      },
      {
        "title": "Add the tools you need.",
        "body": "Extend Dinobot with MCP, browser and desktop tools."
      },
      {
        "title": "Connect team chat.",
        "body": "Configure Slack, Discord or Telegram as a channel."
      }
    ],
    "note": "Provider accounts, channel credentials and tool setup are required where applicable."
  },
  "interfaces": {
    "title": "Desktop or terminal. Your starting point.",
    "desktop": "A separate desktop client for Dinobot.",
    "cli": "The agent daemon and its terminal interface.",
    "chat": "Team chat",
    "chatBody": "Slack, Discord and Telegram channels, configured by you.",
    "privacy": "Dinobot runs on your device. Requests to external models go to the provider you choose."
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
    "tagline": "An agent for what’s next."
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
  }
};
export type Content = typeof en;