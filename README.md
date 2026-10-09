# workadventure-admin-server

A small self-hosted admin API for [WorkAdventure](https://github.com/workadventure/workadventure), for instances that log in through OpenID Connect (tested with Authentik).

WorkAdventure without an admin API keeps the chosen woka only in the browser and reads roles only at login. With this server:

- **Roles are live.** On every page load and room change the user's roles are read from the OpenID provider's userinfo endpoint with the user's access token (claim `tags` by default). Group changes apply after a reload, no new login needed. The last known roles are used as a fallback.
- **Wokas and companions are saved per account**, so they follow the user to every browser and device. A woka chosen in the browser before the admin API existed is taken over on the first visit.
- **Custom wokas** can be restricted to roles or single users (table `custom_wokas`; an admin UI is planned).
- **Map editor rights** come from roles (`EDITOR_TAGS`, default `admin,editor`) or a list of users.
- **Room list** from the map storage, with relative thumbnails (e.g. the `mapImage` of the Tiled map) turned into working URLs.
- Member and tag search, player reports, and chat upload limits for the uploader.

No runtime dependencies: Node.js 22 with the built-in `node:sqlite`.

## Implemented admin API

| Endpoint | Used by WorkAdventure for |
|---|---|
| `GET /api/capabilities` | feature detection (`api/woka/list`, `api/companion/list`, `api/save-textures`) |
| `GET /api/map` | room → map URL, redirects, room settings |
| `GET /api/room/access` | roles, woka, companion, map editor right per user |
| `GET /api/woka/list`, `GET /api/companion/list` | character and companion selection |
| `POST /api/save-textures`, `POST /api/save-companion-texture` | saving the selection |
| `GET /api/room/sameWorld` | room list |
| `GET /api/room/tags`, `GET /api/world/tags` | role suggestions in the map editor |
| `GET /api/members`, `GET /api/members/:id`, `GET /api/chat/members` | member search |
| `POST /api/report` | player reports (stored in the database) |
| `GET /api/limit/fileSize` | chat upload size check by the uploader |

All endpoints except capabilities, logout and the upload check require `Authorization: <ADMIN_API_TOKEN>`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ADMIN_API_TOKEN` | – (required) | Shared secret, same value as in WorkAdventure |
| `PUBLIC_MAP_STORAGE_URL` | – (required) | e.g. `https://play.example.com/map-storage` |
| `INTERNAL_MAP_STORAGE_URL` | `http://map-storage:3000` | Map storage inside the Docker network |
| `OIDC_ISSUER` | – | Issuer URL of the OpenID application, enables live roles |
| `OIDC_TAGS_CLAIM` | `tags` | Claim containing the roles |
| `OIDC_USERNAME_CLAIM` | `preferred_username` | Shown in member search |
| `START_ROOM_URL` | `/~/maps/office.wam` | Where `/` redirects to |
| `DISABLE_ANONYMOUS` | `true` | Require login |
| `OPENID_WOKA_NAME_POLICY` | `allow_override_opid` | `user_input`, `allow_override_opid` or `force_opid` |
| `ENABLE_MAP_EDITOR` | `true` | |
| `EDITOR_TAGS` | `admin,editor` | Roles that may use the map editor |
| `MAP_EDITOR_ALLOWED_USERS` | – | Additional users (emails) for the map editor |
| `KNOWN_TAGS` | `admin,editor,moderator,freunde,vip,member` | Roles offered in the map editor |
| `ENABLE_CHAT`, `ENABLE_CHAT_UPLOAD`, `ENABLE_CHAT_ONLINE_LIST`, `ENABLE_CHAT_DISCONNECTED_LIST`, `ENABLE_SAY` | `true` | |
| `ENABLE_ISSUE_REPORT` | `false` | |
| `ENABLE_TUTORIAL` | `true` | |
| `UPLOAD_MAX_FILESIZE` | `10485760` | Chat upload limit in bytes |
| `DATA_DIR` | `/data` | SQLite database location (writable by UID 1000) |

## Running next to WorkAdventure

Add the service to the WorkAdventure compose stack so that `play`, `back` and `uploader` can reach it, and set in WorkAdventure's environment:

```
ADMIN_API_URL=http://workadventure-admin:3000
ADMIN_API_TOKEN=<random secret>
```

```yaml
  workadventure-admin:
    image: ghcr.io/newtox/workadventure-admin-server:latest
    restart: unless-stopped
    environment:
      ADMIN_API_TOKEN: ${ADMIN_API_TOKEN}
      OIDC_ISSUER: ${OPENID_CLIENT_ISSUER}
      PUBLIC_MAP_STORAGE_URL: https://${DOMAIN}/map-storage
      START_ROOM_URL: ${START_ROOM_URL}
      DISABLE_ANONYMOUS: ${DISABLE_ANONYMOUS}
      OPENID_WOKA_NAME_POLICY: ${OPENID_WOKA_NAME_POLICY}
    volumes:
      - /docker_volumes/workadventure/admin:/data
```

Removing `ADMIN_API_URL` switches WorkAdventure back to its built-in behaviour.

## Development

```sh
npm ci
ADMIN_API_TOKEN=dev PUBLIC_MAP_STORAGE_URL=http://localhost/map-storage npm run dev
```

`data/woka.json` and `data/companions.json` are the default woka and companion lists of WorkAdventure (AGPL-3.0, artwork CC-BY-SA), so official wokas keep working unchanged.
