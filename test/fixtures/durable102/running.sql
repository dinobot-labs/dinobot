-- Immutable synthetic fixture exported by durable102-db.mjs; never a user database.
-- manifest: {"mode":"running","conversation":2,"tasks":{"safe":9,"unsafe":11},"entries":[{"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"safe","name":"safe","arguments":{"value":"safe"}}],"api":"faux","provider":"faux","model":"faux-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1000}],"id":8,"conversationId":2},{"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"unsafe","name":"unsafe","arguments":{"value":"unsafe"}}],"api":"faux","provider":"faux","model":"faux-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1000}],"id":10,"conversationId":2},{"kind":"test.history","data":{"text":"saved history","number":17},"id":14,"conversationId":2}],"submission":13,"deadline":10000,"sleep":12,"live":{"run":{"taskId":12,"inputs":[]},"generation":{"attempt":4,"message":{"role":"assistant","content":[{"type":"text","text":"saved partial"}],"api":"faux","provider":"faux","model":"faux-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1000}},"compactions":[{"taskId":12,"reason":"manual","blocking":false}]},"inbox":{"items":[{"id":13,"mode":"followUp","content":"saved queued input"}]},"records":[{"id":9,"conversationId":2,"kind":"pi.tool","version":1,"input":{"assistant":8,"callId":"safe"},"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"execute","arguments":{"value":"safe"},"replay":"safe"}}},{"id":11,"conversationId":2,"kind":"pi.tool","version":1,"input":{"assistant":10,"callId":"unsafe"},"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"execute","arguments":{"value":"unsafe"},"replay":"unsafe"}}},{"id":12,"conversationId":2,"kind":"test.migration-sleep","version":1,"input":{"until":10000},"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"wait","until":10000}}}],"schema":[{"singleton":1,"version":1}],"integrity":[{"integrity_check":"ok"}],"provenance":{"durableVersion":"1.0.2","durableJavaScriptSha256":"2cf5531ea06dcaf8c1dfdea918d08597f44a677c2fb70d0773eab7e22768c5a0","generatorSha256":"5676b3daf43ec606aff64ca7e405121db621751b6f3816cb1c371e7dab821579","sourceCheckout":"017d133a4104c978b231d77d45460e5977888278","dependencies":{"chord":"1.0.2","pi-ai":"1.0.2"}}}
BEGIN;
CREATE TABLE conversations (
		id INTEGER PRIMARY KEY,
		owner_conversation_id INTEGER,
		owner_task_id INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "conversations" VALUES (2.0,NULL,NULL,'{"id":2}');
CREATE TABLE document_revisions (
		document_id INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version INTEGER NOT NULL,
		content TEXT NOT NULL CHECK (json_valid(content)),
		PRIMARY KEY (document_id, seq)
	) STRICT;
INSERT INTO "document_revisions" VALUES (3.0,1.0,'base',1.0,'{}');
INSERT INTO "document_revisions" VALUES (4.0,1.0,'base',1.0,'{"items":[]}');
INSERT INTO "document_revisions" VALUES (5.0,1.0,'base',1.0,'{"models":{},"tools":{}}');
INSERT INTO "document_revisions" VALUES (6.0,1.0,'base',1.0,'{"sessionId":"01a1ac4b-2419-73e0-8d32-ecbb1b82fab3"}');
INSERT INTO "document_revisions" VALUES (7.0,1.0,'base',1.0,'{}');
INSERT INTO "document_revisions" VALUES (3.0,8.0,'delta',1.0,'[["s",["run"],{"taskId":12,"inputs":[]}],["s",["generation"],{"attempt":4,"message":{"role":"assistant","content":[{"type":"text","text":"saved partial"}],"api":"faux","provider":"faux","model":"faux-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1000}}],["s",["compactions"],[{"taskId":12,"reason":"manual","blocking":false}]]]');
INSERT INTO "document_revisions" VALUES (4.0,8.0,'delta',1.0,'[["p",["items"],0,0,[{"id":13,"mode":"followUp","content":"saved queued input"}]]]');
CREATE TABLE documents (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		family INTEGER NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		retired_at INTEGER,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "documents" VALUES (3.0,'"pi.live"',0.0,'""','conversation',2.0,1.0,NULL,'{"id":3,"kind":"pi.live","scope":{"kind":"conversation","conversationId":2},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES (4.0,'"pi.inbox"',0.0,'""','conversation',2.0,1.0,NULL,'{"id":4,"kind":"pi.inbox","scope":{"kind":"conversation","conversationId":2},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES (5.0,'"pi.usage"',0.0,'""','conversation',2.0,1.0,NULL,'{"id":5,"kind":"pi.usage","scope":{"kind":"conversation","conversationId":2},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES (6.0,'"pi.provider"',0.0,'""','conversation',2.0,1.0,NULL,'{"id":6,"kind":"pi.provider","scope":{"kind":"conversation","conversationId":2},"history":"latest","fork":"initial","createdAt":1}');
INSERT INTO "documents" VALUES (7.0,'"pi.agent"',0.0,'""','conversation',2.0,1.0,NULL,'{"id":7,"kind":"pi.agent","scope":{"kind":"conversation","conversationId":2},"history":"rewindable","fork":"asOf","createdAt":1}');
CREATE TABLE durable_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq INTEGER NOT NULL
	) STRICT;
INSERT INTO "durable_metadata" VALUES (1.0,'15',9.0);
CREATE TABLE durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT;
INSERT INTO "durable_schema" VALUES (1.0,1.0);
CREATE TABLE entries (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		head INTEGER,
		commit_seq INTEGER NOT NULL,
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "entries" VALUES (8.0,2.0,NULL,2.0,'{"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"safe","name":"safe","arguments":{"value":"safe"}}],"api":"faux","provider":"faux","model":"faux-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1000}],"id":8,"conversationId":2}');
INSERT INTO "entries" VALUES (10.0,2.0,NULL,3.0,'{"kind":"pi.assistant","model":[{"role":"assistant","content":[{"type":"toolCall","id":"unsafe","name":"unsafe","arguments":{"value":"unsafe"}}],"api":"faux","provider":"faux","model":"faux-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1000}],"id":10,"conversationId":2}');
INSERT INTO "entries" VALUES (14.0,2.0,NULL,8.0,'{"kind":"test.history","data":{"text":"saved history","number":17},"id":14,"conversationId":2}');
CREATE TABLE record_ids (
		id INTEGER PRIMARY KEY,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	) STRICT;
INSERT INTO "record_ids" VALUES (2.0,'conversation');
INSERT INTO "record_ids" VALUES (3.0,'document');
INSERT INTO "record_ids" VALUES (4.0,'document');
INSERT INTO "record_ids" VALUES (5.0,'document');
INSERT INTO "record_ids" VALUES (6.0,'document');
INSERT INTO "record_ids" VALUES (7.0,'document');
INSERT INTO "record_ids" VALUES (8.0,'entry');
INSERT INTO "record_ids" VALUES (9.0,'task');
INSERT INTO "record_ids" VALUES (10.0,'entry');
INSERT INTO "record_ids" VALUES (11.0,'task');
INSERT INTO "record_ids" VALUES (12.0,'task');
INSERT INTO "record_ids" VALUES (13.0,'submission');
INSERT INTO "record_ids" VALUES (14.0,'entry');
CREATE TABLE submissions (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "submissions" VALUES (13.0,2.0,'"legacy-queued"','queued','{"conversationId":2,"type":"input","status":"queued","requestId":"legacy-queued","id":13}');
CREATE TABLE tasks (
		id INTEGER PRIMARY KEY,
		conversation_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
		background INTEGER NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL CHECK (json_valid(record))
	) STRICT;
INSERT INTO "tasks" VALUES (9.0,2.0,'"pi.tool"','running',0.0,0.0,'{"id":9,"conversationId":2,"kind":"pi.tool","version":1,"input":{"assistant":8,"callId":"safe"},"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"execute","arguments":{"value":"safe"},"replay":"safe"}}}');
INSERT INTO "tasks" VALUES (11.0,2.0,'"pi.tool"','running',0.0,0.0,'{"id":11,"conversationId":2,"kind":"pi.tool","version":1,"input":{"assistant":10,"callId":"unsafe"},"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"execute","arguments":{"value":"unsafe"},"replay":"unsafe"}}}');
INSERT INTO "tasks" VALUES (12.0,2.0,'"test.migration-sleep"','running',0.0,0.0,'{"id":12,"conversationId":2,"kind":"test.migration-sleep","version":1,"input":{"until":10000},"background":false,"abortRequested":false,"state":{"status":"running","checkpoint":{"phase":"wait","until":10000}}}');
CREATE INDEX conversations_by_owner_conversation ON conversations (owner_conversation_id, id);
CREATE INDEX conversations_by_owner_task ON conversations (owner_task_id, id);
CREATE INDEX document_revisions_by_kind ON document_revisions (document_id, kind, seq DESC);
CREATE INDEX documents_by_address
		ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
CREATE INDEX documents_by_scope ON documents (scope_kind, owner_id, id);
CREATE INDEX documents_by_scope_kind ON documents (scope_kind, owner_id, kind, id);
CREATE INDEX entries_by_conversation ON entries (conversation_id, id DESC);
CREATE INDEX entry_heads_by_conversation ON entries (conversation_id, id DESC) WHERE head IS NOT NULL;
CREATE INDEX submissions_by_conversation ON submissions (conversation_id, id);
CREATE INDEX submissions_by_request ON submissions (conversation_id, request_id);
CREATE INDEX submissions_by_status ON submissions (status, id);
CREATE INDEX tasks_by_abort_requested ON tasks (abort_requested, id);
CREATE INDEX tasks_by_background ON tasks (background, id);
CREATE INDEX tasks_by_conversation ON tasks (conversation_id, id);
CREATE INDEX tasks_by_kind ON tasks (kind, id);
CREATE INDEX tasks_by_status ON tasks (status, id);
COMMIT;
