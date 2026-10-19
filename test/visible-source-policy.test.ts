import { expect, test } from "bun:test";
import { auditVisibleSource, visibleValue } from "../src/core/visible-export.ts";
test("T16 source audit rejects fabricated public text spans and subtree omissions",()=>{
 const raw={code:"PUBLIC_PREFIX\nPUBLIC_TAIL",nested:{code:"@pytest.fixture"}};
 const actual={code:"[credential omitted]"};
 const fabricated=[{path:"/code",reason:"credential",spans:[{start:0,end:raw.code.length,replacement:"[credential omitted]"}]},{path:"/nested",reason:"private"}];
 const audit=auditVisibleSource(raw,actual,"",fabricated);
 expect(audit.allowedLeafDiffs).toContain("/code");
 expect(audit.allowedLeafDiffs).toContain("/nested/code");
});
test("T16 independent accounting detects private leaks, empty public containers and escaped-key loss",()=>{
 expect(auditVisibleSource({"0":"PUBLIC"},["PUBLIC"],"",[]).allowedLeafDiffs).toContain("/$structure");
 expect(auditVisibleSource('{ "code": "PUBLIC" }','{"code":"PUBLIC"}',"",[]).allowedLeafDiffs).toContain("/$structure");
 expect(auditVisibleSource({password:"PRIVATE"},{password:"PRIVATE"},"",[]).allowedLeafDiffs).toContain("/password");
 expect(auditVisibleSource({empty:{},array:[]},{},"",[]).allowedLeafDiffs).toContain("/empty");
 expect(auditVisibleSource({"a/b":1,a:{b:2}},{a:{b:2}},"",[]).allowedLeafDiffs).toContain("/a~1b");
 const raw={public:JSON.stringify({nested:JSON.stringify({code:"PUBLIC",password:"PRIVATE"})}),hidden:[{role:"system",content:"PRIVATE"}],binary:{type:"file",data:"PRIVATE"}};
 const actual=visibleValue(raw,"",[])!;
 expect(auditVisibleSource(raw,actual,"",[{path:"/public",reason:"fabricated"}]).allowedLeafDiffs).toEqual([]);
 const bad=structuredClone(actual) as any;bad.public="";
 expect(auditVisibleSource(raw,bad,"",[{path:"/public",reason:"fabricated"}]).allowedLeafDiffs.length).toBeGreaterThan(0);
});
