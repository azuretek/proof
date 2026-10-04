# openclaw#161344, head 9935db1aad19c2da254801c96d2f1116ccc91498

Redacted behaviour-proof record set for the PR body and the re-review comment.

- PR: openclaw/openclaw#161344
- Head under test: 9935db1aad19c2da254801c96d2f1116ccc91498
- Base for the diff: 2e76e316c286b32d14581e7ad3480e1ec49253d7 (merge of upstream/main)
- Repaired prerequisite: 4be8534dec36cc8824fb17fb8403499022311df2
- Earlier-revision evidence (kept in the body, labelled with its own revision): 134946619f2c3ff75affd20ff88c11aff7a91ac9 and 4be8534dec36cc8824fb17fb8403499022311df2
- Run host class: disposable 4-vCPU Linux x86_64 VM, Node v24.19.0, pnpm 12.4.0

Contents:
- pr-body-9935db1a-redacted.md: the PR body (redacted).
- comment-9935db1a.md: the re-review comment (redacted).
- routing-after/: the six routing, fallback and refusal scenarios, one directory per scenario, redacted. Each holds request.json, headers.json, http-status, response.json, gateway.log, stub.log, counts-before.json, counts-after.json, state-before.txt, state-after.txt.
- checkpoint-after/: the eight checkpoint re-authorization scenarios, same per-scenario layout, redacted.
- head3-build.console, head3-build.log, head3-suite.log, head3-proof.log: install/build/suite exits and the proof runner log.
- head3-build-summary.json: the build facts used in the body.

Redaction applied: home paths, user names, LAN addresses, project/key/organization identifiers and resume tokens. No live Gateway was changed.
