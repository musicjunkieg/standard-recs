# Recommendations Page Design

## Summary

Add a user-facing recommendations page so enrolled users can browse their Standard.site document recommendations in a browser, rather than hitting the JSON API directly. Includes a handle-lookup landing page and an auto-refreshing empty state for users whose pipeline is still running.

## Pages & Routing

### GET /recs — Lookup Landing Page

A handle search box using the same typeahead from enrollment (typeahead.waow.tech). User types a handle, selects from suggestions. The typeahead API does not return DIDs, so selection posts the handle to a server-side resolve endpoint: `GET /recs/by-handle/:handle` which resolves the handle to a DID via the users table (or AT Protocol) and redirects to `/recs/:did`. If the user is not enrolled, redirects to `/` with an error hint.

New file: `src/api/recs-lookup-page.ts`

### GET /recs/:did — Recommendations Page

Content-negotiated: if the `Accept` header includes `text/html` (which browsers send by default, even alongside `*/*`), serve the HTML page. Otherwise return the existing JSON response. Check via `c.req.header('Accept')?.includes('text/html')`.

**With recommendations:**
- Header: "Recs for @handle" in Newsreader serif
- Stacked cards layout (single column, one card per recommendation)
- Each card shows: title (serif, bold), description, site domain (bottom-left), "XX% match" (bottom-right)
- Each card is an `<a>` linking to the document URL (built from site + path)
- Score displayed as percentage: `Math.round(score * 100)`
- Back link to `/recs` (lookup) and `/` (enrollment)
- Same visual style as enrollment page: #faf8f5 background, Newsreader + DM Sans fonts, earthy tones, rounded corners

**Without recommendations (empty state):**
- Message: "We're syncing your likes — check back shortly."
- `<meta http-equiv="refresh" content="30">` for auto-refresh every 30 seconds
- Once recs appear, the meta-refresh is omitted and the full page renders

New file: `src/api/recs-page.ts` — exported function taking user data + recommendations array, returns HTML string. Same pattern as `enroll-page.ts`.

### Enrollment Success Update

Update the enrollment success message in `src/api/enroll-page.ts` to include a link to `/recs/:did` so users can navigate directly after enrolling.

## Route Changes (src/api/routes.ts)

1. Add `GET /recs` route serving the lookup landing page
2. Add `GET /recs/by-handle/:handle` — resolves handle to DID via users table, redirects to `/recs/:did` (302). Returns 404 redirect to `/` if user not enrolled.
3. Modify `GET /recs/:did` to content-negotiate:
   - `Accept` includes `text/html` → serve rendered HTML page
   - Otherwise → return existing JSON response
4. Update `POST /enroll` JSON response to include `recsUrl` field (e.g., `/recs/did:plc:abc123`)
5. Update enrollment page JS to render a link to `recsUrl` in the success message

## Visual Design

Matches the enrollment page aesthetic:
- Background: #faf8f5
- Fonts: Newsreader (serif, headings), DM Sans (body)
- Card background: #fff with 1px #ede8e3 border, 10px border-radius
- Title: Newsreader, 600 weight
- Description: DM Sans, #7a6f66
- Site/score metadata: DM Sans, smaller, #b8a898
- Max-width container: 420px, centered (matches enrollment page)
- Mobile-friendly single column

## Files Changed

| File | Change |
|------|--------|
| `src/api/recs-page.ts` | New — HTML template for recommendations view |
| `src/api/recs-lookup-page.ts` | New — HTML template for handle lookup landing |
| `src/api/routes.ts` | Add GET /recs, GET /recs/by-handle/:handle, content-negotiate GET /recs/:did, add recsUrl to enroll response |
| `src/api/enroll-page.ts` | Update success JS to render link to recs page |

## Data Flow

1. User visits `/recs` → sees typeahead search
2. User selects a handle → redirected to `/recs/:did`
3. Route handler queries D1 for user + recommendations (existing query)
4. If user not found → inline 404 page (styled consistently, "User not enrolled" message with link back to `/` to enroll)
5. If user found, no recs → empty state with auto-refresh
6. If user found, has recs → render stacked cards with document links
