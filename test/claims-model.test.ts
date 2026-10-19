import { expect, test } from "bun:test";
import { acquire, release, overlaps, type ClaimsState } from "../src/core/claims.ts";

// Finite-state counterexample search supplements (does not replace) the induction proof.
test("serialized lease transitions preserve exclusion over bounded competing histories", () => {
 const initial: ClaimsState = { claims: [], nextToken: 1 };
 let frontier = [{ state: initial, now: 0 }];
 const seen = new Set<string>();
 let checked = 0;
 for (let depth = 0; depth <= 5; depth++) {
  const next: typeof frontier = [];
  for (const point of frontier) {
   const identity = JSON.stringify(point);
   if (seen.has(identity)) continue;
   seen.add(identity); checked++;
   const live = point.state.claims.filter(c => point.now < c.expiresAt);
   for (const a of live) for (const b of live) {
    if (a.holder !== b.holder && overlaps(a.key, b.key)) throw new Error("exclusion counterexample: " + identity);
   }
   if (depth === 5) continue;
   for (const holder of ["a", "b"]) {
    for (const key of ["repo:x", "repo:x/src", "repo:y"]) {
     const state = structuredClone(point.state);
     acquire(state, { key, holder, intent: "model", ttlMs: 2 }, point.now);
     next.push({ state, now: point.now });
    }
    const state = structuredClone(point.state);
    release(state, holder, undefined, point.now);
    next.push({ state, now: point.now });
   }
   next.push({ state: structuredClone(point.state), now: point.now + 1 });
  }
  frontier = next;
 }
 expect(checked).toBeGreaterThan(1000);
});
