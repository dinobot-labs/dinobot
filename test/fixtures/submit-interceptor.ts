import type { Context } from "@earendil-works/chord";
import type { Conversation, Submission, SubmissionDraft, SubmissionId, Tx } from "@earendil-works/pi-durable";

/** Fault injection around host admission, preserving the independent transaction overload. */
export function interceptSubmit(original: Conversation["submit"], handler: (draft: SubmissionDraft, context: Context) => Promise<Submission>): Conversation["submit"] {
 function submit(draft: SubmissionDraft, context: Context): Promise<Submission>;
 function submit(tx: Tx, draft: SubmissionDraft): Promise<SubmissionId>;
 function submit(first: SubmissionDraft | Tx, second: Context | SubmissionDraft): Promise<Submission | SubmissionId> {
  if ("type" in first) return handler(first, second as Context);
  return original(first, second as SubmissionDraft);
 }
 return submit;
}
