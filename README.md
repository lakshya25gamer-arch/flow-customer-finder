# Flow Industries Customer Finder – backend (untested)
## Setup
1. Create a Firebase project; enable Authentication (Email/Password), Firestore, Functions (Blaze plan).
2. Enable "Places API (New)" in Google Cloud; create a key restricted to that API.
3. Create a Gemini API key.
4. `npm i -g firebase-tools && firebase login && firebase use <project>`
5. `firebase functions:secrets:set PLACES_API_KEY` and `... GEMINI_API_KEY`
6. Copy functions/.env.example to functions/.env and edit.
7. `cd functions && npm install && npm run build`, then from root: `firebase deploy`
## API (all require `Authorization: Bearer <Firebase ID token>`)
POST /api/bootstrap · GET /api/status · POST /api/discovery/search · POST/GET /api/leads · PATCH/DELETE /api/leads/:id · GET/POST /api/leads/:id/notes · DELETE /api/leads/:id/notes/:nid · POST /api/leads/:id/analyze · POST /api/leads/:id/messages/draft · PATCH /api/messages/:mid · POST /api/leads/:id/preview-brief
## Places compliance
Verify current Google Maps Platform terms: show required attribution, and refresh/expire cached non-ID fields (store fetchedAt; Place IDs may be kept, other content has caching limits).
