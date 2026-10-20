# Who Stole the Bell?

A social deduction party game for 3-12 players. One player is secretly the Thief who took the bell. Everyone writes an alibi, then the table votes on who's lying.

Players use their own phones. One person hosts a table, the others join with a 4-letter code.

## Run it

You need Node.js 20 or newer.

```bash
npm run install:all     # installs server + client dependencies

# Option A: development (two terminals)
npm run dev:server      # game server on :3001
npm run dev:client      # React app on :5173 (proxies sockets to :3001)

# Option B: one process (serves the built client)
npm run build
npm start               # open http://localhost:3001
```

To play with friends on the same wifi, open `http://<your-computer-ip>:5173` (dev) or `:3001` (built) on their phones.

Run the automated game simulation. Start the server with a short discussion timer in one terminal, then run the test in another:

```bash
DISCUSS_SECONDS=2 npm start
npm test
```

`DISCUSS_SECONDS` sets how long the discussion lasts (default 120).

## How a round works

1. **Lobby:** host creates a table, friends join with the code. Minimum 3 players.
2. **Alibi:** each player secretly sees their role. Everyone writes where they were when the bell vanished. The Thief has to make one up.
3. **Discussion:** all alibis are revealed and a group chat opens with a countdown (2 minutes by default). Players grill each other and try to sniff out the Thief. The server runs the clock, so it moves on even if someone closes their tab. The host can end it early.
4. **Vote:** the bell rings when time is up. Everyone votes for who they think took the bell (no self-votes, you can change your vote until everyone is in). Chat stays open.
5. **Result:** most votes wins the accusation. If the Thief is accused, the Patrons win. A tie or no clear majority means the Thief gets away. The bell rings.

## Structure

```
server/game.js     pure game logic (rooms, roles, phases, votes) - no networking
server/index.js    Express + Socket.IO wiring, serves the built client
server/test-sim.js 4-client simulated game that asserts the rules
client/src/App.jsx all screens (home, lobby, alibi, discussion + chat, vote, result)
```

The Thief's identity is never sent to other players until the result screen. The server builds a separate view for each player (`viewFor` in `game.js`).

## Known limits of v1

- Rooms live in server memory. Restarting the server or losing your connection drops you out of the room (no reconnect yet).
- The discussion length is a server setting, not something the host can pick in the lobby yet. The alibi and vote phases have no timer; the host moves them along.
- Single Thief, no red herrings or bell-passing yet.

## Ideas for next

- Reconnect support (store a player token in the browser)
- Host picks the discussion length in the lobby
- Red herring clues for Patrons
- Accomplice role and bell passing
- Custom restaurant setting prompts for alibis
