# Nighthawk Notes server

A small, self-hostable server that gives Nighthawk Notes accounts, teams, invites and shared team notes. It has no dependencies beyond Node.js 24: data lives in a single SQLite file.

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
| Viewer | Read the team's notes |
| Editor | Also create, edit, rename and delete notes |
| Admin | Also invite people, change roles (except owners) and remove members |
| Owner | Everything, including making owners and deleting the team |

A team always keeps at least one owner. Admins invite people from the team's context menu in Nighthawk: an invite is a link (`PUBLIC_URL/invite/CODE`) and a short code, for one person or for anyone with the link until it expires or is revoked. Opening the link shows a page with an **Open in Nighthawk** button; the code also works in **Notes: Join Team with Invite**.

## Shared notes

Each team's notes are Markdown files with paths like `Projects/Launch.md`. Every save carries the version it started from, and the server rejects a save that would overwrite someone else's newer change (HTTP 409); Nighthawk then offers to compare or overwrite. Clients fetch changes with `GET /api/teams/:id/notes?since=CURSOR`, which also reports deletions.

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

## Tests

```sh
npm test
```
