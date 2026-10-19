import { expect, test } from "bun:test";
import { visibleValue, auditVisibleSource } from "../src/core/visible-export.ts";
const cases:[string,string][]=[
 ["def incomplete(\npassword: \"LABEL_PRIVATE\"", "def incomplete(\npassword: [credential omitted]"],
 ["call(password=CALL_PRIVATE)", "call(password=[credential omitted])"],
 ['def one(password: "str"): pass','def one(password: "str"): pass'],
 ["async def two(\n password: 'CustomType',\n secret: str\n): pass", "async def two(\n password: 'CustomType',\n secret: str\n): pass"],
 ['function three(password: "literal", secret: string) {}','function three(password: "literal", secret: string) {}'],
 ['def four(password: "str" = "DEFAULT_PRIVATE"): pass','def four(password: "str" = [credential omitted]): pass'],
 ['def five(password="DEFAULT_PRIVATE"): pass','def five(password=[credential omitted]): pass'],
 ['function six(secret: string = "DEFAULT_PRIVATE") {}','function six(secret: string = [credential omitted]) {}'],
 ['call(password="CALL_PRIVATE")','call(password=[credential omitted])'],
 ['unmatched (\npassword: LABEL_PRIVATE','unmatched (\npassword: [credential omitted]'],
 ['// def fake(\npassword: "LABEL_PRIVATE"','// def fake(\npassword: [credential omitted]'],
 ['/* def fake( */\npassword: "LABEL_PRIVATE"','/* def fake( */\npassword: [credential omitted]'],
 ['"""def fake(\n"""\npassword: "LABEL_PRIVATE"','"""def fake(\n"""\npassword: [credential omitted]'],
 ['password: "LABEL_PRIVATE"','password: [credential omitted]'],
 ['authorization: Bearer BEARER_PRIVATE','authorization: [credential omitted]'],
 ['password="escaped\\"PRIVATE remainder"','password=[credential omitted]'],
 ['@pytest.fixture\n@@ -1 +1 @@\n-public(password: str)\n+public(password: str)\n가😀TAIL','@pytest.fixture\n@@ -1 +1 @@\n-public(password: str)\n+public(password: str)\n가😀TAIL'],
];
for(const [raw,expected] of cases)test("T16 syntax policy "+raw,()=>{
 const omissions:any[]=[];const actual=visibleValue(raw,"/body",omissions)!;
 expect(actual).toBe(expected);
 expect(auditVisibleSource(raw,actual,"/body",omissions).allowedLeafDiffs).toEqual([]);
 expect(auditVisibleSource(raw,expected,"/body",[]).allowedLeafDiffs).toEqual([]);
});
