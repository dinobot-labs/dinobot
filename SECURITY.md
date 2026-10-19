# Security

Report vulnerabilities privately to dev0jsh@gmail.com with affected version, impact and a minimal synthetic reproduction. Do not post secrets or real user sessions publicly. There is no guaranteed response or remediation SLA.

Known limitation: the existing HTTP API is unauthenticated and can expose powerful local capabilities. Bind to loopback, do not expose it through public proxies, and use a trusted local machine/account. This release does not claim to fix API authentication or provide a hostile multi-user boundary.

Keep credentials, SQLite databases, reports and session exports out of issues and PRs. Sanitization is best effort, not proof of anonymity.
