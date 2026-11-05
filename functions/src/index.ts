import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import type { Message, Outgoing, Actor } from "./core.js";
import { contentHash, editMessage, approveMessage, markSent } from "./core.js";

admin.initializeApp();
const db = admin.firestore();
const PLACES_KEY = defineSecret("PLACES_API_KEY");
const GEMINI_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const LIMITS = {discovery: Number(process.env.DAILY_DISCOVERY_LIMIT || 50), analysis: Number(process.env.DAILY_ANALYSIS_LIMIT || 100)};
const STATUS = ["NEW","CONTACTED","REVIEWED","DRAFT_READY","INTERESTED","NOT_INTERESTED","FOLLOW_UP_DUE","CONVERTED","ARCHIVED"] as const;
const ts = () => admin.firestore.FieldValue.serverTimestamp();

type Ctx = Request & {uid: string; ws: string; role: string};
class HttpErr extends Error {constructor(public code: number, m: string) {super(m);}}
const wrap = (f: (q: Ctx, r: Response) => Promise<unknown>) => (q: Request, r: Response, n: NextFunction) =>
  f(q as Ctx, r).catch(n);
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
  const p = s.safeParse(v); if (!p.success) throw new HttpErr(400, p.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ")); return p.data;
};

// ---- per-instance burst limit + per-workspace daily quota (Firestore) ----
const hits = new Map<string, number[]>();
function burst(key: string, max = 30, ms = 60000) {
  const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < ms);
  if (a.length >= max) throw new HttpErr(429, "Too many requests. Slow down."); a.push(now); hits.set(key, a);
}
async function quota(ws: string, kind: "discovery" | "analysis") {
  const ref = db.doc(`workspaces/${ws}/usage/${new Date().toISOString().slice(0, 10)}`);
  await db.runTransaction(async (t) => {
    const n = ((await t.get(ref)).data()?.[kind] || 0) as number;
    if (n >= LIMITS[kind]) throw new HttpErr(429, `Daily ${kind} limit reached (${LIMITS[kind]}).`);
    t.set(ref, {[kind]: n + 1}, {merge: true});
  });
}
async function log(ws: string, leadId: string | null, actorId: string, eventType: string, summary: string) {
  await db.collection("activity_events").add({workspaceId: ws, leadId, actorId, eventType, summary, createdAt: ts()});
}

const app = express();
app.use(cors({origin: (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean)}));
app.use(express.json({limit: "50kb"}));
app.use((_q, r, n) => {r.set({"X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000"}); n();});

// ---- auth: verify Firebase ID token, resolve workspace from DB (never from client) ----
app.use("/api", async (q, r, n) => {
  try {
    const h = q.headers.authorization || ""; if (!h.startsWith("Bearer ")) throw new HttpErr(401, "Sign in required.");
    const d = await admin.auth().verifyIdToken(h.slice(7)).catch(() => {throw new HttpErr(401, "Session expired.");});
    const c = q as Ctx; c.uid = d.uid; burst(d.uid);
    if (q.path !== "/bootstrap") {
      const u = (await db.doc(`users/${d.uid}`).get()).data();
      if (!u?.workspaceId) throw new HttpErr(403, "No workspace. Call /api/bootstrap first.");
      c.ws = u.workspaceId; c.role = u.role;
    }
    n();
  } catch (e) {n(e);}
});
const ok = (r: Response, data: unknown, code = 200) => r.status(code).json({data, error: null});

app.post("/api/bootstrap", wrap(async (q, r) => {
  const ref = db.doc(`users/${q.uid}`); const u = await ref.get();
  if (u.exists) return ok(r, u.data());
  const t = await admin.auth().getUser(q.uid);
  const w = await db.collection("workspaces").add({name: "Flow Industries", defaultLocation: "Surat, Gujarat", currency: "INR", timezone: "Asia/Kolkata", createdAt: ts()});
  const data = {displayName: t.displayName || t.email, email: t.email, role: "owner", workspaceId: w.id, themePreference: "light", createdAt: ts()};
  await ref.set(data); ok(r, {...data, createdAt: null}, 201);
}));

app.get("/api/status", wrap(async (_q, r) => ok(r, {
  places: PLACES_KEY.value() ? "configured" : "missing PLACES_API_KEY",
  gemini: GEMINI_KEY.value() ? "configured" : "missing GEMINI_API_KEY"})));

// ---- discovery (Google Places API New, Text Search) ----
const DS = z.object({location: z.string().min(2).max(100), category: z.string().min(2).max(60), keyword: z.string().max(80).optional(), pageToken: z.string().max(2000).optional()});
const FIELDS = "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.googleMapsUri,nextPageToken";
app.post("/api/discovery/search", wrap(async (q, r) => {
  const b = parse(DS, q.body); const key = PLACES_KEY.value();
  if (!key) throw new HttpErr(503, "Business discovery is not configured (PLACES_API_KEY).");
  await quota(q.ws, "discovery");
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {method: "POST", signal: AbortSignal.timeout(10000),
    headers: {"Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS},
    body: JSON.stringify({textQuery: `${b.keyword ? b.keyword + " " : ""}${b.category} in ${b.location}`, pageSize: 20, pageToken: b.pageToken})});
  if (res.status === 429) throw new HttpErr(429, "Places quota exceeded. Try later.");
  if (res.status === 400 || res.status === 403) throw new HttpErr(502, "Places provider rejected the request (check API key and enabled API).");
  if (!res.ok) throw new HttpErr(502, "Places provider unavailable.");
  const j = await res.json() as {places?: any[]; nextPageToken?: string};
  const seen = new Set<string>(); const fetchedAt = new Date().toISOString();
  const results = (j.places || []).filter((p) => p.id && !seen.has(p.id) && seen.add(p.id)).map((p) => ({
    provider: "google_places", providerPlaceId: p.id, name: p.displayName?.text ?? null, address: p.formattedAddress ?? null,
    coordinates: p.location ?? null, publicPhone: p.nationalPhoneNumber ?? null, website: p.websiteUri ?? null,
    rating: p.rating ?? null, reviewCount: p.userRatingCount ?? null, category: p.primaryTypeDisplayName?.text ?? null,
    mapsUri: p.googleMapsUri ?? null, fetchedAt, attribution: "Google Maps"}));
  ok(r, {results, nextPageToken: j.nextPageToken ?? null, source: "Google Places API (New)", fetchedAt});
}));

// ---- leads ----
const LS = z.object({business: z.object({providerPlaceId: z.string().min(1), name: z.string().min(1).max(200), category: z.string().max(100).nullable().optional(),
  address: z.string().max(400).nullable().optional(), coordinates: z.object({latitude: z.number(), longitude: z.number()}).nullable().optional(),
  publicPhone: z.string().max(40).nullable().optional(), website: z.string().url().nullable().optional(), rating: z.number().nullable().optional(),
  reviewCount: z.number().nullable().optional(), mapsUri: z.string().nullable().optional(), fetchedAt: z.string()})});
app.post("/api/leads", wrap(async (q, r) => {
  const {business: bz} = parse(LS, q.body);
  const dup = await db.collection("leads").where("workspaceId", "==", q.ws).where("providerPlaceId", "==", bz.providerPlaceId).limit(1).get();
  if (!dup.empty) throw new HttpErr(409, "Already saved as a lead.");
  const bid = `google_places_${bz.providerPlaceId}`;
  await db.doc(`businesses/${bid}`).set({...bz, provider: "google_places", providerPlaceId: bz.providerPlaceId, sourceFields: "provider", updatedAt: ts()}, {merge: true});
  const l = await db.collection("leads").add({workspaceId: q.ws, businessId: bid, providerPlaceId: bz.providerPlaceId, name: bz.name, status: "NEW", priority: null,
    score: null, confidence: null, estimate: null, assignedTo: null, nextFollowUpAt: null, savedAt: ts(), createdBy: q.uid});
  await log(q.ws, l.id, q.uid, "saved", `Saved ${bz.name}`); ok(r, {id: l.id}, 201);
}));
const owned = async (q: Ctx, id: string) => {
  const s = await db.doc(`leads/${id}`).get(); if (!s.exists || s.data()!.workspaceId !== q.ws) throw new HttpErr(404, "Lead not found."); return s;
};
app.get("/api/leads", wrap(async (q, r) => {
  const st = z.enum(STATUS).optional().parse(q.query.status); const after = typeof q.query.after === "string" ? q.query.after : null;
  let c = db.collection("leads").where("workspaceId", "==", q.ws); if (st) c = c.where("status", "==", st);
  c = c.orderBy("savedAt", "desc").limit(25); if (after) c = c.startAfter(await db.doc(`leads/${after}`).get());
  const s = await c.get(); ok(r, {leads: s.docs.map((d) => ({id: d.id, ...d.data()})), next: s.size === 25 ? s.docs[24].id : null});
}));
const PS = z.object({status: z.enum(STATUS), assignedTo: z.string().nullable(), nextFollowUpAt: z.string().datetime().nullable(),
  scoreOverride: z.object({value: z.number().int().min(0).max(100), reason: z.string().min(3).max(300)}), estimate: z.object({amountPaise: z.number().int().min(0), source: z.enum(["ai", "manual", "customer_confirmed"])})}).partial().strict();
app.patch("/api/leads/:id", wrap(async (q, r) => {
  await owned(q, q.params.id); const b = parse(PS, q.body); const u: Record<string, unknown> = {...b, updatedAt: ts()};
  if (b.nextFollowUpAt) u.nextFollowUpAt = admin.firestore.Timestamp.fromDate(new Date(b.nextFollowUpAt));
  await db.doc(`leads/${q.params.id}`).update(u); await log(q.ws, q.params.id, q.uid, "updated", "Updated: " + Object.keys(b).join(", ")); ok(r, {id: q.params.id});
}));
app.delete("/api/leads/:id", wrap(async (q, r) => {
  if (q.role === "member") throw new HttpErr(403, "Admin or owner required."); await owned(q, q.params.id);
  for (const col of ["lead_notes", "lead_analyses", "message_records"]) for (const d of (await db.collection(col).where("leadId", "==", q.params.id).get()).docs) await d.ref.delete();
  await db.doc(`leads/${q.params.id}`).delete(); await log(q.ws, null, q.uid, "deleted", "Lead deleted"); ok(r, {deleted: true});
}));

// ---- notes ----
app.get("/api/leads/:id/notes", wrap(async (q, r) => {
  await owned(q, q.params.id); const s = await db.collection("lead_notes").where("leadId", "==", q.params.id).orderBy("createdAt", "desc").get();
  ok(r, s.docs.map((d) => ({id: d.id, ...d.data()})));
}));
app.post("/api/leads/:id/notes", wrap(async (q, r) => {
  await owned(q, q.params.id); const b = parse(z.object({body: z.string().trim().min(1).max(2000), pinned: z.boolean().optional()}), q.body);
  const n = await db.collection("lead_notes").add({leadId: q.params.id, workspaceId: q.ws, body: b.body, pinned: !!b.pinned, authorId: q.uid, createdAt: ts(), updatedAt: ts()});
  await log(q.ws, q.params.id, q.uid, "note_added", "Note added"); ok(r, {id: n.id}, 201);
}));
app.delete("/api/leads/:id/notes/:nid", wrap(async (q, r) => {
  await owned(q, q.params.id); const n = await db.doc(`lead_notes/${q.params.nid}`).get();
  if (!n.exists || n.data()!.leadId !== q.params.id) throw new HttpErr(404, "Note not found."); await n.ref.delete();
  await log(q.ws, q.params.id, q.uid, "note_deleted", "Note deleted"); ok(r, {deleted: true});
}));

// ---- Gemini ----
async function gemini(prompt: string): Promise<unknown> {
  const key = GEMINI_KEY.value(); if (!key) throw new HttpErr(503, "AI is not configured (GEMINI_API_KEY).");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {method: "POST", signal: AbortSignal.timeout(25000),
    headers: {"Content-Type": "application/json", "x-goog-api-key": key},
    body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {responseMimeType: "application/json", temperature: 0.2}})});
  if (res.status === 429) throw new HttpErr(429, "AI quota exceeded."); if (!res.ok) throw new HttpErr(502, "AI provider unavailable. Retry safely.");
  const t = (await res.json() as any).candidates?.[0]?.content?.parts?.[0]?.text; try {return JSON.parse(t);} catch {throw new HttpErr(502, "AI returned invalid output.");}
}
const AS = z.object({breakdown: z.object({digitalPresence: z.number().min(0).max(25), businessFit: z.number().min(0).max(20), onlineJourney: z.number().min(0).max(20),
  infoQuality: z.number().min(0).max(15), verifiedDemand: z.number().min(0).max(20)}), evidence: z.array(z.string().max(300)).max(10),
  confidence: z.number().min(0).max(100), inferredNeeds: z.array(z.object({need: z.string().max(200), reason: z.string().max(300)})).max(8),
  suggestedFeatures: z.array(z.string().max(80)).max(10), opportunities: z.array(z.string().max(200)).max(6),
  package: z.enum(["Starter", "Business", "Premium"]), assumptions: z.array(z.string().max(300)).max(8), rationale: z.string().max(800)});
const BAND = {Starter: 99900, Business: 249900, Premium: 499900}; // paise; confirm real prices in settings
app.post("/api/leads/:id/analyze", wrap(async (q, r) => {
  const l = await owned(q, q.params.id); const bz = (await db.doc(`businesses/${l.data()!.businessId}`).get()).data() || {};
  const notes = (await db.collection("lead_notes").where("leadId", "==", q.params.id).get()).docs.map((d) => d.data().body).slice(0, 10);
  await quota(q.ws, "analysis");
  const facts = {name: bz.name, category: bz.category, address: bz.address, hasWebsite: bz.website ? "website listed by provider" : "no website in provider data (not proof none exists)",
    rating: bz.rating ?? null, reviewCount: bz.reviewCount ?? null, teamNotes: notes};
  const out = await gemini(`You are a research assistant for a web agency. From ONLY these public facts, return JSON matching keys: breakdown{digitalPresence 0-25,businessFit 0-20,onlineJourney 0-20,infoQuality 0-15,verifiedDemand 0-20}, evidence[], confidence 0-100 (completeness of evidence, not purchase likelihood), inferredNeeds[{need,reason}], suggestedFeatures[], opportunities[], package (Starter|Business|Premium), assumptions[], rationale. Never invent facts, never claim the business stated a need or budget (verifiedDemand must be 0 unless teamNotes record a customer request). Missing data lowers confidence, not score. Do not use demographics or neighbourhood wealth. Facts: ${JSON.stringify(facts)}`);
  const a = parse(AS, out); const score = Math.round(Object.values(a.breakdown).reduce((s, v) => s + v, 0) / 80 * 100);
  const ref = await db.collection("lead_analyses").add({leadId: q.params.id, workspaceId: q.ws, model: GEMINI_MODEL, promptVersion: "v1", ...a, score, verified: {customerConfirmed: [], note: "All needs here are AI inferred and unverified."}, createdAt: ts()});
  await l.ref.update({score, confidence: a.confidence, estimate: {amountPaise: BAND[a.package], source: "ai", unverified: true}, priority: score >= 75 ? "HIGH" : score >= 55 ? "MEDIUM" : "LOW"});
  await log(q.ws, q.params.id, q.uid, "analyzed", `AI analysis: score ${score}`); ok(r, {id: ref.id, score, ...a, estimateLabel: "Unverified Estimate"});
}));

// ---- messages (drafts only; sending is recorded by the user) ----
app.post("/api/leads/:id/messages/draft", wrap(async (q, r) => {
  const l = await owned(q, q.params.id); const b = parse(z.object({channel: z.enum(["email", "phone", "whatsapp"])}), q.body);
  const o = parse(z.object({subject: z.string().max(150), body: z.string().max(1500)}), await gemini(`Write a short, honest, respectful introduction from Flow Industries (web design agency) to the business "${l.data()!.name}". No fake familiarity, no claims about their needs, no pressure. Return JSON {subject, body}.`));
  const m = await db.collection("message_records").add({leadId: q.params.id, workspaceId: q.ws, channel: b.channel, recipient: null, ...o, status: "DRAFT", createdBy: q.uid, createdAt: ts()});
  await log(q.ws, q.params.id, q.uid, "draft_created", "Draft created"); ok(r, {id: m.id, ...o, status: "DRAFT"}, 201);
}));
app.patch("/api/messages/:mid", wrap(async (q, r) => {
  const m = await db.doc(`message_records/${q.params.mid}`).get(); if (!m.exists || m.data()!.workspaceId !== q.ws) throw new HttpErr(404, "Message not found.");
  const b = parse(z.object({body: z.string().max(3000), subject: z.string().max(150), status: z.enum(["DRAFT", "OPENED_EXTERNALLY", "SENT_USER_CONFIRMED"])}).partial().strict(), q.body);
  await m.ref.update({...b, ...(b.status === "SENT_USER_CONFIRMED" ? {sentAt: ts()} : {})});
  if (b.status) await log(q.ws, m.data()!.leadId, q.uid, "message_" + b.status.toLowerCase(), "Message " + b.status); ok(r, {id: m.id});
}));
app.post("/api/leads/:id/preview-brief", wrap(async (q, r) => {
  const l = await owned(q, q.params.id); const bz = (await db.doc(`businesses/${l.data()!.businessId}`).get()).data() || {};
  const an = (await db.collection("lead_analyses").where("leadId", "==", q.params.id).orderBy("createdAt", "desc").limit(1).get()).docs[0]?.data();
  ok(r, {published: false, verifiedFacts: {name: bz.name, address: bz.address, phone: bz.publicPhone, website: bz.website, source: "Google Places"},
    aiSuggestedUnverified: {features: an?.suggestedFeatures ?? [], assumptions: an?.assumptions ?? []}, note: "Editable brief. Not published; no customer approval implied."});
}));

// ---- profile, activity, business detail, saved searches, notifications, export, deletion ----
app.patch("/api/me", wrap(async (q, r) => {
  const b = parse(z.object({themePreference: z.enum(["light", "dark", "system"]), displayName: z.string().trim().min(1).max(80)}).partial().strict(), q.body);
  await db.doc(`users/${q.uid}`).update(b); ok(r, b);
}));
app.get("/api/activity", wrap(async (q, r) => {
  const lead = typeof q.query.leadId === "string" ? q.query.leadId : null; if (lead) await owned(q, lead);
  let c = db.collection("activity_events").where("workspaceId", "==", q.ws); if (lead) c = c.where("leadId", "==", lead);
  const s = await c.orderBy("createdAt", "desc").limit(50).get(); ok(r, s.docs.map((d) => ({id: d.id, ...d.data()})));
}));
app.get("/api/businesses/:id", wrap(async (q, r) => {
  const l = await db.collection("leads").where("workspaceId", "==", q.ws).where("businessId", "==", q.params.id).limit(1).get();
  if (l.empty) throw new HttpErr(404, "Business not found in this workspace."); ok(r, (await db.doc(`businesses/${q.params.id}`).get()).data());
}));
app.post("/api/saved-searches", wrap(async (q, r) => {
  const b = parse(z.object({name: z.string().trim().min(1).max(80), location: z.string().max(100), category: z.string().max(60), filters: z.record(z.union([z.string(), z.number()])).default({})}), q.body);
  const d = await db.collection("saved_searches").add({...b, workspaceId: q.ws, createdBy: q.uid, createdAt: ts()}); ok(r, {id: d.id}, 201);
}));
app.get("/api/saved-searches", wrap(async (q, r) => {
  const s = await db.collection("saved_searches").where("workspaceId", "==", q.ws).limit(50).get(); ok(r, s.docs.map((d) => ({id: d.id, ...d.data()})));
}));
app.delete("/api/saved-searches/:id", wrap(async (q, r) => {
  const d = await db.doc(`saved_searches/${q.params.id}`).get(); if (!d.exists || d.data()!.workspaceId !== q.ws) throw new HttpErr(404, "Not found."); await d.ref.delete(); ok(r, {deleted: true});
}));
app.get("/api/notifications", wrap(async (q, r) => {
  const s = await db.collection("notifications").where("workspaceId", "==", q.ws).where("userId", "==", q.uid).limit(50).get(); ok(r, s.docs.map((d) => ({id: d.id, ...d.data()})));
}));
app.post("/api/notifications/:id/read", wrap(async (q, r) => {
  const d = await db.doc(`notifications/${q.params.id}`).get(); if (!d.exists || d.data()!.userId !== q.uid) throw new HttpErr(404, "Not found."); await d.ref.update({readAt: ts()}); ok(r, {read: true});
}));
const OWNED = ["leads", "lead_notes", "lead_analyses", "message_records", "activity_events", "saved_searches", "notifications"];
app.get("/api/export", wrap(async (q, r) => {
  if (q.role === "member") throw new HttpErr(403, "Admin or owner required."); const out: Record<string, unknown[]> = {};
  for (const c of OWNED) out[c] = (await db.collection(c).where("workspaceId", "==", q.ws).get()).docs.map((d) => ({id: d.id, ...d.data()}));
  ok(r, {exportedAt: new Date().toISOString(), ...out});
}));
app.post("/api/workspace/delete-data", wrap(async (q, r) => {
  if (q.role !== "owner") throw new HttpErr(403, "Owner required."); parse(z.object({confirm: z.literal("DELETE")}), q.body);
  let n = 0; for (const c of OWNED) for (const d of (await db.collection(c).where("workspaceId", "==", q.ws).get()).docs) {await d.ref.delete(); n++;}
  await log(q.ws, null, q.uid, "data_deleted", `Deleted ${n} records`); ok(r, {deleted: n});
}));

app.use((e: unknown, q: Request, r: Response, _n: NextFunction) => {
  const rid = Math.random().toString(36).slice(2, 10);
  if (e instanceof HttpErr) return void r.status(e.code).json({data: null, error: {message: e.message, requestId: rid}});
  console.error(rid, q.method, q.path, (e as Error).message); r.status(500).json({data: null, error: {message: "Server error.", requestId: rid}});
});
export const api = onRequest({secrets: [PLACES_KEY, GEMINI_KEY], timeoutSeconds: 60, maxInstances: 10}, app);
