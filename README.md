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

Run the automated tests (starts its own throwaway server on port 3101 with short timers, so nothing else needs to be running):

```bash
npm test
```

Two server settings you can change (environment variables):

- `DISCUSS_SECONDS`: how long the discussion lasts (default 59).
- `GRACE_SECONDS`: how long a dropped player keeps their seat before the game treats them as gone (default 60).

## How a round works

1. **Lobby:** host creates a table, friends join with the code. Minimum 3 players.
2. **Alibi:** each player secretly sees their role. Everyone writes where they were when the bell vanished. The Thief has to make one up.
3. **Discussion:** all alibis are revealed and a group chat opens with a countdown (59 seconds by default). Players grill each other and try to sniff out the Thief. The server runs the clock, so it moves on even if someone closes their tab. The host can end it early.
4. **Vote:** the bell rings when time is up. Everyone votes for who they think took the bell (no self-votes, you can change your vote until everyone is in). Chat stays open.
5. **Result:** most votes wins the accusation. If the Thief is accused, the Patrons win. A tie or no clear majority means the Thief gets away. The bell rings, and the result screen reveals the Thief, the accomplice and everyone's red herring.

## Roles and secrets

Everyone peeks at their own role card on their own phone (hidden by default so nobody reads it over your shoulder).

- **Thief:** took the bell. Makes up an alibi and tries not to get voted out.
- **Accomplice:** only in games with 5 or more players. One Patron is secretly turned into the Thief's helper. The Thief and the accomplice know each other; nobody else is told who they are. Everyone is told an accomplice exists that round (it follows from the player count), just not who. Voting out the accomplice is not enough for the Patrons: they have to catch the Thief themselves.
- **Patron:** innocent. Listens to the alibis and tries to spot who's lying.
- **Red herring:** about half the Patrons get a private secret that makes them look guilty, such as "You have a shiny object in your pocket", along with the innocent truth (it's your house key). Only the holder sees it until the result screen. It's there to muddy the discussion.

## Dropped connections

Phones lose signal, tabs get reloaded. When you create or join a table, the server gives you a private token and your browser remembers it. If you reconnect or reload, you're put back in the same seat with the same role, chat and alibis.

- While you're offline you show as "away" and the game waits for you for `GRACE_SECONDS` (60 by default).
- If you don't come back in time, the game carries on without you: voting and alibis no longer wait for you, and if you were the host, the host seat passes to someone who's online. You can still rejoin later as an ordinary player.
- Opening the same seat in a second tab replaces the first one.
- "Leave table" gives up your seat immediately.
- If the server restarts, tables are lost (they live in memory). Players see "That table no longer exists" and go back to the start screen.

## Structure

```
server/game.js     pure game logic (rooms, roles, phases, votes) - no networking
server/index.js    Express + Socket.IO wiring, serves the built client
server/test-sim.js 4-client simulated game that asserts the rules
server/test-roles.js      roles, accomplice and red herrings over 600 random games (3-12 players)
server/test-reconnect.js  dropped phones, rejoining, grace period, host handover
server/run-tests.js       `npm test`: starts a server with short timers and runs all three
client/src/App.jsx all screens (home, lobby, alibi, discussion + chat, vote, result)
```

The Thief's identity is never sent to other players until the result screen. The server builds a separate view for each player (`viewFor` in `game.js`).

## Known limits of v1

- Rooms live in server memory, so restarting the server ends every game in progress.
- The discussion length is a server setting, not something the host can pick in the lobby yet. The alibi and vote phases have no timer; the host moves them along.
- One Thief per round. The accomplice is a role only: there's no physical bell to pass between them yet.
- The screens are phone-style cards and buttons. There's no map or walking-around game world.

## Ideas for next

- Host picks the discussion length in the lobby
- Bell passing between the Thief and the accomplice
- Custom restaurant setting prompts for alibis
- A graphical version: a top-down restaurant map where players walk around as avatars
