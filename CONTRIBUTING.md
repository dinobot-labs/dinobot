# Contributing

This project uses familiar public issue and PR workflows, but its first-party source is **source-available, not OSI open source**. Read LICENSE, CODE_OF_CONDUCT.md and SECURITY.md before contributing.

## Start with a scoped problem

Search existing issues and discuss substantial changes first. Include expected and actual behavior, OS, runtime versions, source commit and a minimal synthetic reproduction. Never upload raw sessions, conversation exports, credentials, production configuration or private screenshots. Report security concerns privately as described in SECURITY.md.

Issue triage, labels, severity, priority and closure rules
https://github.com/dinobot-labs/dinobot/blob/main/docs/wiki/Issues.md

PR drafts, review, conflict resolution, authorship and squash merges
https://github.com/dinobot-labs/dinobot/blob/main/docs/wiki/Pull-Requests.md

## Submit and verify

Link the issue, keep the diff narrow, add relevant tests and update affected docs. Use a draft until ready for review. For code changes run the applicable guard, type, test and build checks documented in docs/wiki/Development.md; report the exact commands used. For docs-only changes, check paths and examples and run the public guard. Report actual results and limitations. The aggregate CI check is `CI` (workflow `CI`, job id `gate`); green CI alone is not acceptance.

Address requested changes and rerun affected checks after conflicts are resolved. Maintainers decide scope and merge readiness. Independent review is preferred where available, but a sole maintainer is not required to approve their own PR. There is no response SLA and no automatic stale closure. Merge does not mean release: record whether a fix is unreleased or available in a named release. Releases are cut from this repository by merging the release PR that release-please keeps open; see the Releases section of PUBLIC_SNAPSHOT.md.

## License and contributor rights

By submitting a contribution, you offer your first-party contribution under PolyForm Noncommercial 1.0.0 unless a separate explicit agreement says otherwise. Clearly identify third-party material and preserve its original license, copyright and attribution. Submit only work you may legally contribute, including any necessary employer permission.

Permitted noncommercial use is free under LICENSE; commercial use requires separate permission from the relevant rights holders. Submission does **not** grant maintainers or recipients an additional commercial license, commercial relicensing right or copyright assignment. Contributor authorship remains credited. Any commercial permission or contributor agreement must be explicitly agreed separately with the relevant rights holders. Contact dev0jsh@gmail.com for licensing discussions.
