import {test} from "node:test"; import assert from "node:assert/strict"; import {createHmac} from "node:crypto";
import * as c from "../src/core.ts";
const m: c.Outgoing = {recipient: "a@x.test", channel: "email", subject: "Hi", body: "Hello", attachments: []};
const appr = (o: c.Outgoing, extra: Partial<c.Approval> = {}): c.Approval => ({decision: "approved", approverId: "owner1", approverIsHuman: true, hash: c.contentHash(o), ...extra});
test("send blocked without approval", () => assert.equal(c.canSend(m, null).ok, false));
test("send allowed with exact human approval", () => assert.equal(c.canSend(m, appr(m)).ok, true));
test("edited body invalidates approval", () => assert.equal(c.canSend({...m, body: "Hello!"}, appr(m)).ok, false));
test("changed recipient invalidates approval", () => assert.equal(c.canSend({...m, recipient: "b@x.test"}, appr(m)).ok, false));
test("changed attachment invalidates approval", () => assert.equal(c.canSend({...m, attachments: ["f.pdf"]}, appr(m)).ok, false));
test("AI approver rejected", () => assert.equal(c.canSend(m, appr(m, {approverId: "ai:outreach", approverIsHuman: false})).ok, false));
test("rejected decision blocks send", () => assert.equal(c.canSend(m, appr(m, {decision: "rejected"})).ok, false));
test("unlike currencies cannot be added", () => assert.throws(() => c.add(c.money(100, "INR"), c.money(100, "USD"))));
test("non-integer amount rejected", () => assert.throws(() => c.money(10.5, "USD")));
test("milestones sum to total (odd amount)", () => { const t = c.money(100001, "GBP"), s = c.milestones(t); assert.equal(s.advance.amount + s.final.amount, t.amount); });
test("webhook signature valid/invalid", () => { const b = '{"id":"e1"}', s = createHmac("sha256", "k").update(b).digest("hex");
  assert.equal(c.verifySignature(b, s, "k"), true); assert.equal(c.verifySignature(b + " ", s, "k"), false); assert.equal(c.verifySignature(b, "zz", "k"), false); assert.equal(c.verifySignature(b, s, ""), false); });
  const inv = (): c.Invoice => ({id: "i1", due: c.money(50000, "INR"), paid: c.money(0, "INR"), status: "Issued"});
  const ev = (o: Partial<c.PayEvent> = {}): c.PayEvent => ({eventId: "e1", invoiceId: "i1", amount: c.money(50000, "INR"), kind: "payment", verified: true, ...o});
  test("verified payment marks paid", () => assert.equal(c.applyEvent(inv(), ev(), new Set()).invoice.status, "Paid"));
  test("unverified payment never marks paid", () => { const r = c.applyEvent(inv(), ev({verified: false}), new Set()); assert.equal(r.outcome, "unverified"); assert.equal(r.invoice.status, "Issued"); });
  test("duplicate event is idempotent", () => { const s = new Set<string>(); const a = c.applyEvent(inv(), ev(), s); const b = c.applyEvent(a.invoice, ev(), s); assert.equal(b.outcome, "duplicate"); assert.equal(b.invoice.paid.amount, 50000); });
  test("wrong currency flagged, not posted", () => { const r = c.applyEvent(inv(), ev({amount: c.money(50000, "USD")}), new Set()); assert.equal(r.outcome, "flagged_mismatch"); assert.equal(r.invoice.paid.amount, 0); });
  test("partial payment then refund", () => { const s = new Set<string>(); const a = c.applyEvent(inv(), ev({amount: c.money(20000, "INR")}), s); assert.equal(a.invoice.status, "Partially Paid");
    const b = c.applyEvent(a.invoice, ev({eventId: "e2", kind: "refund", amount: c.money(5000, "INR")}), s); assert.equal(b.invoice.paid.amount, 15000); assert.equal(b.invoice.status, "Partially Refunded"); });
    test("production gate needs paid advance AND owner gate", () => { const paid = {...inv(), status: "Paid"}; assert.equal(c.canStartProduction(paid, false), false); assert.equal(c.canStartProduction(inv(), true), false); assert.equal(c.canStartProduction(paid, true), true); });
    test("publish gate needs final paid AND owner approval", () => { const paid = {...inv(), status: "Paid"}; assert.equal(c.canPublish(paid, false), false); assert.equal(c.canPublish(paid, true), true); });
    test("totals stay separated by currency", () => assert.deepEqual(c.totalsByCurrency([c.money(100, "INR"), c.money(50, "USD"), c.money(25, "INR")]), {INR: 125, USD: 50}));
    // ---- message safety lifecycle ----
    const owner: c.Actor = {id: "owner1", role: "owner", isHuman: true};
    const draft = (): c.Message => ({recipient: "a@x.test", channel: "email", subject: "Hi", body: "Hello", attachments: [], version: 1, status: "DRAFT", approval: null});
    const approved = (): c.Message => { const d = draft(); const r = c.approveMessage(d, owner, c.contentHash(d), d.version); if (!r.ok) throw new Error(r.reason); return r.value; };
    test("validate: good email passes, bad inputs listed", () => {
      assert.deepEqual(c.validateMessage(draft()), []);
        assert.ok(c.validateMessage({...draft(), recipient: ""}).length > 0);
          assert.ok(c.validateMessage({...draft(), recipient: "not-an-email"}).length > 0);
            assert.ok(c.validateMessage({...draft(), body: "  "}).length > 0);
              assert.ok(c.validateMessage({...draft(), subject: ""}).length > 0);
                assert.ok(c.validateMessage({...draft(), channel: "sms"}).length > 0);
                  assert.deepEqual(c.validateMessage({...draft(), channel: "whatsapp", recipient: "+919876543210", subject: ""}), []);
                  });
                  test("hash is deterministic and covers every field", () => {
                    const h = c.contentHash(draft()); assert.equal(h, c.contentHash(draft()));
                      for (const p of [{recipient: "b@x.test"}, {channel: "phone"}, {subject: "Yo"}, {body: "Hey"}, {attachments: ["f.pdf"]}]) assert.notEqual(c.contentHash({...draft(), ...p}), h);
                      });
                      test("editing content bumps version and voids approval", () => {
                        const e = c.editMessage(approved(), {body: "Changed"}); assert.ok(e.ok && e.value.approval === null && e.value.version === 2);
                        });
                        test("no-op edit keeps approval", () => { const a = approved(); const e = c.editMessage(a, {body: a.body}); assert.ok(e.ok && e.value.approval !== null && e.value.version === 1); });
                        test("only human owner can approve", () => {
                          const d = draft(), h = c.contentHash(d);
                            assert.equal(c.approveMessage(d, {id: "ai:outreach", role: "owner", isHuman: false}, h, 1).ok, false);
                              assert.equal(c.approveMessage(d, {id: "u2", role: "member", isHuman: true}, h, 1).ok, false);
                                assert.equal(c.approveMessage(d, {id: "ai:x", role: "owner", isHuman: true}, h, 1).ok, false);
                                  assert.equal(c.approveMessage(d, owner, h, 1).ok, true);
                                  });
                                  test("approval binds to exact hash and version", () => {
                                    const d = draft();
                                      assert.equal(c.approveMessage(d, owner, "stale", 1).ok, false);
                                        assert.equal(c.approveMessage(d, owner, c.contentHash(d), 2).ok, false);
                                        });
                                        test("invalid message cannot be approved", () => { const d = {...draft(), recipient: ""}; assert.equal(c.approveMessage(d, owner, c.contentHash(d), 1).ok, false); });
                                        test("mark-sent blocked without approval", () => assert.equal(c.markSent(draft(), owner, "SENT_USER_CONFIRMED").ok, false));
                                        test("mark-sent blocked if content changed after approval", () => { const a = approved(); assert.equal(c.markSent({...a, body: "Sneaky"}, owner, "SENT_USER_CONFIRMED").ok, false); });
                                        test("mark-sent blocked if approval is for old version", () => { const a = approved(); assert.equal(c.markSent({...a, version: 2}, owner, "SENT_USER_CONFIRMED").ok, false); });
                                        test("AI cannot record sending", () => assert.equal(c.markSent(approved(), {id: "ai:x", role: "owner", isHuman: false}, "SENT_USER_CONFIRMED").ok, false));
                                        test("approved message can be marked sent", () => { const r = c.markSent(approved(), owner, "SENT_USER_CONFIRMED"); assert.ok(r.ok && r.value.status === "SENT_USER_CONFIRMED"); });
                                        test("sent message is immutable", () => {
                                          const s = (c.markSent(approved(), owner, "SENT_USER_CONFIRMED") as {ok: true; value: c.Message}).value;
                                            assert.equal(c.editMessage(s, {body: "x"}).ok, false); assert.equal(c.markSent(s, owner, "SENT_USER_CONFIRMED").ok, false);
                                              assert.equal(c.markSent(s, owner, "OPENED_EXTERNALLY").ok, false); assert.equal(c.approveMessage(s, owner, c.contentHash(s), s.version).ok, false);
                                              });
                                              test("OPENED_EXTERNALLY is separate from SENT_USER_CONFIRMED", () => {
                                                const o = c.markSent(approved(), owner, "OPENED_EXTERNALLY"); assert.ok(o.ok && o.value.status === "OPENED_EXTERNALLY");
                                                  if (o.ok) { assert.equal(c.editMessage(o.value, {body: "x"}).ok, false); assert.equal(c.markSent(o.value, owner, "OPENED_EXTERNALLY").ok, false);
                                                      const s = c.markSent(o.value, owner, "SENT_USER_CONFIRMED"); assert.ok(s.ok && s.value.status === "SENT_USER_CONFIRMED"); }
                                                      });
                                                      test("edit ignores protected fields smuggled in the patch", () => {
                                                        const a = approved();
                                                          const forged = {body: "New", version: 99, status: "SENT_USER_CONFIRMED", approval: a.approval} as unknown as Partial<c.Outgoing>;
                                                            const e = c.editMessage(a, forged); assert.ok(e.ok);
                                                              if (e.ok) { assert.equal(e.value.version, 2); assert.equal(e.value.status, "DRAFT"); assert.equal(e.value.approval, null); }
                                                                const same = c.editMessage(a, {version: 5, status: "SENT_USER_CONFIRMED"} as unknown as Partial<c.Outgoing>);
                                                                  assert.ok(same.ok && same.value.version === 1 && same.value.status === "DRAFT" && same.value.approval !== null);
                                                                  });