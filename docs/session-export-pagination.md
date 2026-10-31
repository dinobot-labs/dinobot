# Visible export pagination

Without `limit` or `cursor`, `session_export` and `GET /v1/conversations/:id/export` return the original full receipt. Unpaged exports are not transport-size bounded.

With pagination, `limit` is an upper bound **per array**, not only on entries. The host slices these independent streams in order:

- `entries`
- `inventory.conversationIds`, `entryIds`, `content`, `allowedSourceContent`, `omissions`, `allowedLeafDiffs`
- `inventory.provenance.canonicalEntries`, `conversations` (when provenance exists)

Follow `nextCursor` until null, even after `entries` becomes empty. Concatenate each listed array across pages in order. All other fields, including provenance counters, describe the frozen full snapshot and must agree between pages. Absolute entry indices and leaf paths are unchanged. Nested omission spans and canonical membership groups are indivisible, not separately paged.

The host may return fewer items than requested so the session tool envelope (both text and details) stays below the 512 KiB codemode boundary, with a 4 KiB reserve. An indivisible row at the current offset that cannot fit fails with `export_page_item_too_large`; no body, privacy omission or hash is truncated. Use the unpaged HTTP endpoint for such exports. A row includes the item at that offset from each independent stream.

`complete` is true only when a single response contains all streams from offset zero. A terminal continuation page is still not a complete receipt. After joining all pages, set `complete: true` and `nextCursor: null` and verify `contentHash`, `inventoryHash`, and (if present) `provenanceHash` against the reconstructed objects. The host receipt validator still compares the full reconstructed receipt to the retained snapshot. Missing, duplicated or changed metadata cannot pass.

The full stored snapshot, privacy policy, highwater witness and historical-state `UNKNOWN` semantics are unchanged. Previously saved full receipts remain valid, including snapshots without provenance. Existing cursors remain readable, but consumers must not mix the old repeated-inventory page format with newly sliced inventory pages when reconstructing an export across an upgrade; restart pagination from offset zero for that snapshot.
