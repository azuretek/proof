@clawsweeper re-review

The checkpoint authorization fixes are re-verified on the current head 9935db1aad19c2da254801c96d2f1116ccc91498.

The head is the repaired revision 4be8534dec36cc8824fb17fb8403499022311df2 plus the shared isRecord import (f61bb808cd1), the gateway-scope mock fix (56d5b508751) and a merge of upstream/main 2e76e316c286b32d14581e7ad3480e1ec49253d7 (9935db1aad1).

The same checkpoint script ran through the Gateway tool entry point on this head: the writer equivalent-token resume and the writer token-plus-administrator-approval-ID resume are both refused with the reason in the Gateway log, and the administrator own resumes are still served from the saved answer without another provider call. The six routing, fallback and refusal scenarios were re-run unchanged on this head and match the earlier results, and the plugin test suite passes.

CI repair: the coercion-helper guard failure was ours (a local isRecord declaration) and is fixed by importing the shared helper; the two other failing legs were upstream regressions whose fixes newest main already carries, so no upstream file is repaired by this branch. One Windows shard leg, test/scripts/write-unified-entry-dts.test.ts, failed with ERR_MODULE_NOT_FOUND for a generated format-duration-internal.js; it does not touch this change, and we cannot re-run it because we lack administrative rights on the repository, so the re-test triggered by the fresh push is the retry for that leg.

The PR body carries the evidence for this head and keeps the earlier revisions labelled: 9935db1aad1 for the current runs, 4be8534dec3 and its unpatched parent 134946619f2c for the repair proof, and the real-provider credential, revocation and billing run on 134946619f2c.
