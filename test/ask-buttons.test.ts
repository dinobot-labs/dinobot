import { expect, test } from "bun:test";
import { encodeChoice, decodeChoice, choiceLabel, parseAskChoice, parseAskPrompts } from "../src/channels/ask-buttons.ts";
const id = "0123456789abcdef0123456789abcdef";
test("I7 choice tokens round trip and reject malformed boundaries", () => {
 for (let n = 0; n < 4; n++) { const token = encodeChoice(id, n); expect(Buffer.byteLength(token)).toBe(37); expect(decodeChoice(token)).toEqual({ askId: id, option: n }); }
 for (const token of [`da:${id}:4`, `da:${id.toUpperCase()}:0`, `da:${id.slice(1)}:0`, `da:${id}:0x`, `da:${id}:0\n`, `da:${id}:0\r\n`, null]) expect(decodeChoice(token)).toBeUndefined();
 expect(() => encodeChoice(id, 4)).toThrow();
 expect(parseAskChoice({askId:id, option:0, text:"forged"})).toBeUndefined();
 expect(parseAskChoice({askId:id, option:0.5})).toBeUndefined();
 expect(parseAskChoice({askId:id + "\n", option:0})).toBeUndefined();
});
test("D7 D9 labels use code points, Q prefix and display-only default suffix", () => {
 const raw = "😀한".repeat(31); const ask = {id, question:"q", options:[raw,"B"], default:raw, deadlineAt:1};
 expect(choiceLabel(ask,0,1,2)).toBe("Q2 " + Array.from(raw).slice(0,60).join("") + "… (기본값)");
 expect(ask.options[0]).toBe(raw); expect(choiceLabel(ask,1,0,1)).toBe("B");
 expect(parseAskPrompts([ask])).toEqual([ask]);
 for (const bad of [[{...ask,id:"bad"}], [{...ask,id:id + "\n"}], [{...ask,options:["one"]}], [{...ask,deadlineAt:1.2}], Array(4).fill(ask)]) expect(parseAskPrompts(bad)).toBeUndefined();
});
