import { registerFenceTests } from "./fixtures/telegram-inbox-file-fence.ts";

// Portable production-code migration and future-version preservation regressions.
// Actual historical adapter/engine replay is explicitly opt-in (see script/qa/telegram-inbox-file-fence.md).
registerFenceTests();
