# Automatic project-memory recall

Automatic recall is a conservative lexical lookup, not a semantic relevance classifier or a calibrated probability. It may return no memories. Explicit memory list/search tools are unchanged.

## Matching and ranking

- Normalize text to NFC and lowercase. Ignore stopwords and automatic key hashes; human-written keys remain searchable.
- Require a complete lexical anchor. A bounded set of Korean suffixes permits common noun/particle and inflected forms, including mixed identifiers such as Vanguard가. Do not generate arbitrary internal Hangul bigrams: a filesystem word is not evidence for a design-system question, and a shared particle is not a topic.
- Count each normalized anchor once. For a matched anchor with document frequency df in a project corpus of N memories, its ranking weight is ln(1 + N/df). These weights order eligible results; they are not confidence values. A meaningful one-word query can recall a single memory even when its weight is ln(2).
- Compute corpus statistics over all memories in the current project before filtering already-delivered key/revision pairs. Delivery history must not change another memory's score. Unrelated corpus additions may change IDF weights but cannot create a missing lexical match.

## Delivery invariants

Only the current project's entries can be delivered automatically. Team and other-project memories are excluded. Preserve the configured item/character limits, deterministic tie ordering, note-before-input ordering, and durable deduplication by key and revision. A changed revision may be recalled again. Pending delivery recovery uses the existing durable receipt path.

## Limits and validation

This deliberately gives up internal-substring recall. Ambiguous bare endings such as 도/로/만 are not stripped: 해상도 must not match 해상, and 매크로 must retain its name. This sacrifices some particle-attached matches. It is not a Korean morphological analyzer and does not promise every inflection or compound split. Shared complete words can still occur in unrelated contexts; semantic disambiguation, project classification and conversational query rewriting are out of scope.

Regression tests use synthetic facts in test/memory-recall-quality.test.ts and exercise the public bot entrypoint in test/memory-loop.test.ts. Cover abstention, positive Korean/English lookup, normalization, frequency weighting, deduplication, revisions, restart and delivery limits. Production sessions and memory contents must not be committed as fixtures or public verification logs.
