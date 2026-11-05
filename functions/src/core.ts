// Dependency-free business-rule core for Flow Industries OS: approval binding, money, payment verification.
import {createHash, createHmac, timingSafeEqual} from "node:crypto";

export const EXP: Record<string, number> = {INR: 2, USD: 2, GBP: 2, AED: 2, JPY: 0, KWD: 3}; // extensible
export type Money = {amount: number; currency: string}; // amount = integer minor units
export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) throw new Error("Amount must be integer minor units");
    if (!(currency in EXP)) throw new Error("Unsupported currency " + currency);
      return {amount, currency};
      }
      export function add(a: Money, b: Money): Money {
        if (a.currency !== b.currency) throw new Error("Refusing to add unlike currencies without explicit FX conversion");
          return money(a.amount + b.amount, a.currency);
          }
          export function milestones(total: Money): {advance: Money; final: Money} {
            const adv = Math.round(total.amount / 2); // 50% advance; final is the exact remainder
              return {advance: money(adv, total.currency), final: money(total.amount - adv, total.currency)};
              }

              export type Outgoing = {recipient: string; channel: string; subject?: string; body: string; attachments: string[]};
              export const contentHash = (m: Outgoing): string =>
                createHash("sha256").update(JSON.stringify([m.recipient, m.channel, m.subject ?? "", m.body, [...m.attachments].sort()])).digest("hex");
                export type Approval = {decision: "approved" | "rejected"; approverId: string; approverIsHuman: boolean; hash: string};
                export function canSend(m: Outgoing, a: Approval | null): {ok: boolean; reason?: string} {
                  if (!a) return {ok: false, reason: "No approval"};
                    if (a.decision !== "approved") return {ok: false, reason: "Not approved"};
                      if (!a.approverIsHuman || a.approverId.startsWith("ai:")) return {ok: false, reason: "AI cannot approve"};
                        if (a.hash !== contentHash(m)) return {ok: false, reason: "Content, recipient, channel or attachments changed after approval"};
                          return {ok: true};
                          }

                          export function verifySignature(rawBody: string, signatureHex: string, secret: string): boolean {
                            if (!secret) return false;
                              const exp = createHmac("sha256", secret).update(rawBody).digest();
                                let got: Buffer; try {got = Buffer.from(signatureHex, "hex");} catch {return false;}
                                  return got.length === exp.length && timingSafeEqual(got, exp);
                                  } // NOTE: generic HMAC-SHA256; replace with the chosen provider's exact scheme once a provider is selected.

                                  export type Invoice = {id: string; due: Money; paid: Money; status: string};
                                  export type PayEvent = {eventId: string; invoiceId: string; amount: Money; kind: "payment" | "refund"; verified: boolean};
                                  export type Applied = {invoice: Invoice; outcome: "posted" | "duplicate" | "unverified" | "flagged_mismatch"};
                                  export function applyEvent(inv: Invoice, e: PayEvent, seen: Set<string>): Applied {
                                    if (seen.has(e.eventId)) return {invoice: inv, outcome: "duplicate"};
                                      if (!e.verified) return {invoice: inv, outcome: "unverified"};
                                        seen.add(e.eventId);
                                          if (e.invoiceId !== inv.id || e.amount.currency !== inv.due.currency) return {invoice: inv, outcome: "flagged_mismatch"};
                                            const delta = e.kind === "payment" ? e.amount.amount : -e.amount.amount;
                                              const paid = money(Math.max(0, inv.paid.amount + delta), inv.paid.currency);
                                                const status = paid.amount === 0 ? (e.kind === "refund" ? "Refunded" : inv.status) : paid.amount >= inv.due.amount ? "Paid" : e.kind === "refund" ? "Partially Refunded" : "Partially Paid";
                                                  return {invoice: {...inv, paid, status}, outcome: "posted"};
                                                  }
                                                  export const canStartProduction = (advance: Invoice, ownerGate: boolean) => advance.status === "Paid" && ownerGate;
                                                  export const canPublish = (final: Invoice, ownerApproval: boolean) => final.status === "Paid" && ownerApproval;

                                                  export function totalsByCurrency(items: Money[]): Record<string, number> {
                                                    const t: Record<string, number> = {}; for (const m of items) t[m.currency] = (t[m.currency] ?? 0) + m.amount; return t;
                                                    }
                                                    // ---- Message safety lifecycle (pure functions; not yet wired into API routes) ----
                                                    export type MsgStatus = "DRAFT" | "OPENED_EXTERNALLY" | "SENT_USER_CONFIRMED";
                                                    export type VersionedApproval = Approval & {version: number};
                                                    export type Message = Outgoing & {version: number; status: MsgStatus; approval: VersionedApproval | null};
                                                    export type Actor = {id: string; role: string; isHuman: boolean};
                                                    export type Res<T> = {ok: true; value: T} | {ok: false; reason: string};
                                                    const fail = (reason: string): {ok: false; reason: string} => ({ok: false, reason});

                                                    export function validateMessage(m: Outgoing): string[] {
                                                      const e: string[] = [];
                                                        if (!["email", "phone", "whatsapp"].includes(m.channel)) e.push("Unknown channel");
                                                          const r = m.recipient.trim();
                                                            if (!r) e.push("Recipient required");
                                                              else if (m.channel === "email" ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r) : !/^\+?\d{7,15}$/.test(r)) e.push("Recipient invalid for channel");
                                                                if (!m.body.trim()) e.push("Body required"); else if (m.body.length > 5000) e.push("Body too long");
                                                                  if (m.channel === "email" && !(m.subject ?? "").trim()) e.push("Subject required for email");
                                                                    if ((m.subject ?? "").length > 150) e.push("Subject too long");
                                                                      if (m.attachments.length > 10 || m.attachments.some((a) => !a.trim() || a.length > 300)) e.push("Attachments invalid");
                                                                        return e;
                                                                        }

                                                                        export function editMessage(msg: Message, patch: Partial<Outgoing>): Res<Message> {
                                                                          if (msg.status !== "DRAFT") return fail("Message is no longer editable");
                                                                            const n: Message = {
                                                                                ...msg, // protected fields (version, status, approval) come only from the stored message, never from the patch
                                                                                    recipient: (patch.recipient ?? msg.recipient).trim(),
                                                                                        channel: patch.channel ?? msg.channel,
                                                                                            subject: patch.subject ?? msg.subject,
                                                                                                body: patch.body ?? msg.body,
                                                                                                    attachments: patch.attachments ? [...patch.attachments] : msg.attachments,
                                                                                                      };
                                                                                                        if (contentHash(n) === contentHash(msg)) return {ok: true, value: msg};
                                                                                                          return {ok: true, value: {...n, version: msg.version + 1, approval: null}}; // any content change voids approval
                                                                                                          }

                                                                                                          export function approveMessage(msg: Message, actor: Actor, seenHash: string, seenVersion: number): Res<Message> {
                                                                                                            if (!actor.isHuman || actor.id.startsWith("ai:") || actor.role !== "owner") return fail("Only a verified human owner can approve");
                                                                                                              if (msg.status !== "DRAFT") return fail("Only drafts can be approved");
                                                                                                                const errs = validateMessage(msg); if (errs.length) return fail(errs.join("; "));
                                                                                                                  if (seenVersion !== msg.version || seenHash !== contentHash(msg)) return fail("Message changed since you reviewed it");
                                                                                                                    return {ok: true, value: {...msg, approval: {decision: "approved", approverId: actor.id, approverIsHuman: true, hash: contentHash(msg), version: msg.version}}};
                                                                                                                    }

                                                                                                                    export function markSent(msg: Message, actor: Actor, to: "OPENED_EXTERNALLY" | "SENT_USER_CONFIRMED"): Res<Message> {
                                                                                                                      if (!actor.isHuman || actor.id.startsWith("ai:")) return fail("Only a human can record sending");
                                                                                                                        if (msg.status === "SENT_USER_CONFIRMED") return fail("Already sent; message is immutable");
                                                                                                                          if (msg.status === "OPENED_EXTERNALLY" && to === "OPENED_EXTERNALLY") return fail("Already opened externally");
                                                                                                                            if (!msg.approval || msg.approval.version !== msg.version) return fail("Approval missing or for a different version");
                                                                                                                              const g = canSend(msg, msg.approval); if (!g.ok) return fail(g.reason ?? "Not approved");
                                                                                                                                const errs = validateMessage(msg); if (errs.length) return fail(errs.join("; "));
                                                                                                                                  return {ok: true, value: {...msg, status: to}};
                                                                                                                                  }