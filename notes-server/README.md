# Nighthawk Notes server

A small, self-hostable server that gives Nighthawk Notes accounts, teams, invites, shared team notes, and the team workspace: tickets, RFCs and time tracking. It has no dependencies beyond Node.js 24: data lives in a single SQLite file.

## Run it

```sh
cd notes-server
npm start
```

It listens on `http://127.0.0.1:8787` by default. In Nighthawk, open the **Notes** view in the activity bar, then **Teams > Sign In** or **Create Account**. Use **Change Notes Server** (or the `nighthawk.notes.server.url` setting) to point Nighthawk at another server.

With Docker:

```sh
docker build -t nighthawk-notes-server notes-server
docker run -p 8787:8787 -v nighthawk-notes:/data -e PUBLIC_URL=https://notes.example.com nighthawk-notes-server
```

Put it behind HTTPS (for example Caddy or nginx) before people sign in over the internet; passwords and session tokens travel in requests.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on; use `0.0.0.0` to accept outside connections |
| `PUBLIC_URL` | `http://HOST:PORT` | Address people use to reach the server; invite links are built from it |
| `NOTES_DB` | `data/notes.db` | SQLite database file |
| `ALLOW_REGISTRATION` | `true` | Set to `false` to stop new sign-ups once your team has accounts |
| `SESSION_TTL_DAYS` | `30` | How long a sign-in lasts |
| `APP_URL_PROTOCOL` | `nighthawk` | Protocol the invite page uses to open the desktop app |

## Teams and roles

| Role | Can |
| --- | --- |
| Viewer | Read the team's notes, tickets, RFCs and timesheets; comment |
| Editor | Also create, edit, rename and delete notes and tickets; book time; review RFCs |
| Admin | Also invite people, change roles (except owners) and remove members |
| Owner | Everything, including making owners and deleting the team |

A team always keeps at least one owner. Admins invite people from the team's context menu in Nighthawk: an invite is a link (`PUBLIC_URL/invite/CODE`) and a short code, for one person or for anyone with the link until it expires or is revoked. Opening the link shows a page with an **Open in Nighthawk** button; the code also works in **Notes: Join Team with Invite**.

## Shared notes

Each team's notes are Markdown files with paths like `Projects/Launch.md`. Every save carries the version it started from, and the server rejects a save that would overwrite someone else's newer change (HTTP 409); Nighthawk then offers to compare or overwrite. Clients fetch changes with `GET /api/teams/:id/notes?since=CURSOR`, which also reports deletions.

### Live editing

Everyone who has the same note open edits it together: each editor opens a stream of server-sent events for the note, posts its own edits and cursor positions, and gets everyone else's as they type. Edits are operational transforms (`src/textOperation.ts`): a list of numbers (positive keeps that many characters, negative deletes) and strings (inserted). The server puts edits in order, adjusts an edit made on an older revision for the ones made since, and saves the note a second after the last change, so the version history and the normal sync above keep working. A save through `PUT` while the note is open live reaches everyone as one more edit. Live sessions live in memory; if the server restarts, editors reconnect and merge what they typed meanwhile. Behind a reverse proxy, turn off response buffering for `/live` so events are not held back.

## Settings sync

Nighthawk can keep a person's settings, keyboard shortcuts, snippets and list of extensions the same on all their computers through this server (**Notes: Turn On Settings Sync**). Each kind is stored per account as one JSON document with a version; a write carries the version it started from and is rejected (409) if another computer wrote first, so Nighthawk merges and tries again. Merging happens in Nighthawk, not here. API keys are never synced.

## Tickets, RFCs and time

Each team has numbered items of three kinds: tasks and bugs move through `backlog`, `todo`, `in_progress`, `in_review` and `done`; RFCs through `draft`, `in_review`, `accepted`, `rejected` and `withdrawn`. Items carry assignees (or reviewers for RFCs), a priority (`urgent`, `high`, `medium`, `low`, `none`), labels, a due date, an estimate in minutes, a to-do checklist and comments. Editors review RFCs with `approve`, `request_changes` or `comment`. Time is booked as worklogs of whole minutes on a day; only the person who booked an entry, or an admin, can change it. Like notes, an item update may send `baseVersion` to be rejected (409) if someone changed it since, and `GET .../items?since=CURSOR` returns only what changed.

## API

All endpoints take and return JSON. Send `Authorization: Bearer TOKEN` with the token from register or login.

| Method and path | Purpose |
| --- | --- |
| `GET /api/info` | Server name and whether registration is open |
| `POST /api/auth/register` | `{email, name, password}` → `{token, user}` |
| `POST /api/auth/login` | `{email, password}` → `{token, user}` |
| `POST /api/auth/logout` | End this session |
| `GET`, `PATCH /api/me` | Your account; change your display name |
| `GET`, `POST /api/teams` | Your teams; create a team `{name}` |
| `GET`, `PATCH`, `DELETE /api/teams/:id` | Team and members; rename (admin); delete (owner) |
| `PATCH /api/teams/:id/members/:userId` | Change a role `{role}` |
| `DELETE /api/teams/:id/members/:userId` | Remove a member; use `me` to leave |
| `GET`, `POST /api/teams/:id/invites` | Open invites; create `{role, expiresInHours, maxUses}` |
| `DELETE /api/teams/:id/invites/:code` | Revoke an invite |
| `GET /api/invites/:code` | Preview an invite (no sign-in needed) |
| `POST /api/invites/:code/accept` | Join the team |
| `GET`, `POST /api/teams/:id/notes` | List (`?since=`, `?content=1`); create `{path, content}` |
| `GET`, `PUT`, `DELETE /api/teams/:id/notes/:noteId` | Read; update `{baseVersion, content?, path?}`; delete |
| `GET`, `DELETE /api/me/sync` | Your synced settings, shortcuts, snippets and extensions; delete them all |
| `PUT /api/me/sync/:resource` | Replace one (`settings`, `keybindings`, `snippets`, `extensions`): `{baseVersion, content, machine}` |
| `GET /api/teams/:id/notes/:noteId/live?client=ID` | Live stream (server-sent events): `init`, `op`, `presence`, `join`, `leave`, `saved`, `deleted` |
| `POST /api/teams/:id/notes/:noteId/live/edits` | Live edit `{client, revision, op}` (editor) |
| `POST /api/teams/:id/notes/:noteId/live/selections` | Cursor positions `{client, revision, selections: [[anchor, head]]}` |
| `GET`, `POST /api/teams/:id/items` | List (`?since=`); create `{kind, title, body?, status?, priority?, assignees?, reviewers?, labels?, dueDate?, estimateMinutes?, checklist?}` |
| `GET`, `PATCH`, `DELETE /api/teams/:id/items/:itemId` | Item with comments, worklogs and reviews; update (same fields, plus `baseVersion?`); delete |
| `POST /api/teams/:id/items/:itemId/comments` | Comment `{body}` |
| `DELETE /api/teams/:id/items/:itemId/comments/:commentId` | Delete a comment (author or admin) |
| `POST /api/teams/:id/items/:itemId/reviews` | Review an RFC `{verdict, body?}` |
| `GET`, `POST /api/teams/:id/worklogs` | List (`?from=&to=&userId=&itemId=`); book `{itemId, minutes, date, note?}` |
| `PATCH`, `DELETE /api/teams/:id/worklogs/:worklogId` | Change `{minutes?, date?, note?}` or delete (author or admin) |

## Tests

```sh
npm test
```
