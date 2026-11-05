# Project identity after a filesystem move

Project memory and working agreements use the real Git common-directory root (or the real directory outside Git) as their key. Moving a repository changes that key, even if its old location is a junction. No database rewrite is required.

An owner can preserve the historical key in the trusted daemon manifest:

```yaml
memory:
  projectAliases:
    - path: E:/repos/example
      identity: 'C:\Users\owner\example'
```

`path` must be the **new canonical project root**, not a linked worktree or a symlink spelling. `identity` must be the **exact pre-move project key**, including its spelling and Windows separators/case. It is returned verbatim and is never realpathed. Record it with `projectKeyFor` before the move. Git subdirectories and correctly repaired linked worktrees resolve through the same common directory. Non-Git directories match exactly; children are not implicitly aliased.

For an entire moved tree, explicitly add `descendants: true` to that mapping. After Git common-directory discovery, a component-descendant canonical project maps to `identity` plus its relative suffix (native separators, original suffix case). Ordinary Git subdirectories still share their parent repository key; independent nested Git repositories and non-Git subdirectories keep distinct historical keys. `repo-other` never matches `repo`. The tree must retain its relative names and case. Do not add overlapping aliases for nested repositories: one subtree mapping covers them. Omitted or false `descendants` retains exact-only semantics. This flag is accepted only from the trusted daemon manifest, never repository files.

```yaml
memory:
  projectAliases:
    - path: E:/repos/Deepwork
      identity: 'C:\Users\정승현\Deepwork'
      descendants: true
```

The optional array defaults to no aliases. Each endpoint must be an absolute non-root path. All endpoints must be disjoint: duplicates, nesting, chains and cycles fail manifest validation, and invalid direct resolver calls throw rather than partially applying mappings. Matching is case-insensitive on Windows, exact on other systems. Repository files, remotes and Git config cannot select an identity. The manifest is trusted deployment configuration, not project-supplied input.

Manifest changes take effect on daemon restart. Identity lookup canonicalizes the directory before Git-discovery memoization and includes the complete alias settings in the cache key, so moving a directory through a junction or changing mappings cannot reuse the old result. Repairing Git metadata at an unchanged real directory still requires the controlled daemon restart. Aliases are passed per bot to tools, agreement sections, recall, extraction and retrospectives; they are not global mutable state. YAML parsing/serialization preserves the mapping.

Aliases do **not** relocate files or rewrite session cwd. Keep the old directory accessible through a verified junction so resumed conversations retain file access, and repair Git worktree metadata separately. Install the patched daemon and its aliases before resuming conversations after a move. Do not overwrite a global package used by a running daemon. Validate old/new conversation memory reads and working-agreement sections against existing data after the controlled switch. Do not infer live deployment from unit tests or a built binary.
