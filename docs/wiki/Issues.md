# Issues

Search open and closed issues before filing a bug or feature request. Use the repository template and keep one problem per issue. Include the source commit or release, OS, runtime versions, exact steps, expected and actual behavior, and a small synthetic reproduction. For a feature, explain the user problem, alternatives and proposed scope; acceptance is not a delivery promise.

## Privacy and security

Never post raw sessions, conversation exports, databases, credentials, production configuration or private screenshots. Recreate the failure with invented data and inspect logs and screenshots before attaching them. Redaction alone is not a reason to upload a real session archive. Report vulnerabilities privately using SECURITY.md, not a public issue. If sensitive data is accidentally posted, remove it where possible, revoke exposed credentials and contact the maintainers privately; deleting a comment cannot recall copies.

## Triage lifecycle

Maintainers apply labels; contributors can supply evidence and suggest a status. These are policy names, not a claim that labels or automation have already been configured.

| Label | Meaning and next action |
| --- | --- |
| `needs-triage` | New report awaiting scope, duplicate and evidence review. |
| `needs-reproduction` | Maintainer lists the missing steps or synthetic evidence; reporter or another contributor can supply them. |
| `accepted` | Reproduced bug or agreed proposal in scope; available for work, not scheduled. |
| `in-progress` | Someone has agreed to work on it and linked a draft PR or brief plan. |
| `blocked` | Work cannot proceed; name the dependency or decision and what would unblock it. |

Use one current lifecycle label and replace it when the state changes. A blocked item can return to accepted or in-progress. Ask before taking on substantial work and coordinate on the issue to avoid duplicate implementations. If the contributor steps away, return it to accepted rather than treating assignment as permanent.

## Impact, scheduling and resolution

Severity describes observed impact: critical (data loss or a security concern, reported privately), major (a core workflow unusable), or minor (limited impact with a workaround). Priority describes when maintainers intend to act: high, normal or low. A severe bug can remain blocked; a low-severity improvement can be scheduled first. Maintainers explain these choices using impact, reach, workaround and available capacity; votes alone do not set priority.

Close with a reason and the matching resolution label: `duplicate` links the canonical issue; `invalid` explains why the report is not a project defect; `wontfix` explains a scope or design decision. Missing reproduction is not automatically invalid. New evidence can justify reopening; do not open repeated copies to appeal a decision.

There are no automatic stale closures and no response or fix SLA. Maintainers may close an unactionable report after explaining the missing evidence and how to reopen it, but silence or age alone is not a resolution. Avoid repeated bumps.

A merged PR is not a released fix. Maintainers close fixed issues after verifying the agreed scope and record the merge commit plus whether the fix is unreleased or which release contains it. Partial fixes leave the remaining issue open. See Release.md for the repository’s release and distribution boundaries.
