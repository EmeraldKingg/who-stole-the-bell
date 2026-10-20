import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { ding } from './bell.js';

// In dev, Vite proxies /socket.io to the server. In production the server serves this page itself.
const socket = io({ autoConnect: true });

// Your seat at a table is remembered in this browser (a secret token from the server), so a dropped
// connection or a reloaded page puts you back in the same seat with the same role.
// Wrapped in try/catch because storage can be blocked (private windows, strict settings).
const SESSION_KEY = 'wstb-session';

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s?.code && s?.token ? s : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Without storage the game still works, you just can't rejoin after a reload.
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nothing to clear
  }
}

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function useGame(onNotice) {
  const [view, setView] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  // True while we're getting back into a table we were in before the page loaded or the connection dropped.
  const [rejoining, setRejoining] = useState(() => !!loadSession());

  useEffect(() => {
    // skew = how far this phone's clock is from the server's, so the countdown matches for everyone.
    const onState = (s) => setView({ ...s, skew: s.serverNow - Date.now() });

    // Runs on the first connection and on every automatic reconnect.
    const onConnect = async () => {
      setConnected(true);
      const session = loadSession();
      if (!session) {
        setRejoining(false);
        return;
      }
      const res = await emit('rejoin', session);
      if (!res?.ok) {
        clearSession();
        setView(null);
        onNotice(res?.error || "Couldn't get back into your table.");
      }
      setRejoining(false);
    };

    const onDisconnect = (reason) => {
      setConnected(false); // keep the last screen up while we reconnect
      if (reason === 'io server disconnect') {
        // The server only does this when the same seat was opened somewhere else.
        onNotice('This table was opened in another window or tab. Reload this page to use it here instead.');
      }
    };

    socket.on('state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off('state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [onNotice]);

  return { view, setView, connected, rejoining };
}

export default function App() {
  const [error, setError] = useState('');
  const { view, setView, connected, rejoining } = useGame(setError);

  const run = async (event, payload) => {
    setError('');
    const res = await emit(event, payload);
    if (!res?.ok) setError(res?.error || 'Something went wrong.');
    else if ((event === 'create' || event === 'join') && res.token) {
      saveSession({ code: res.code, token: res.token });
    }
    return res;
  };

  const leave = async () => {
    const midGame = view && view.phase !== 'lobby' && view.phase !== 'result';
    if (midGame && !window.confirm("Leave the game? You won't be able to rejoin this round.")) return;
    await emit('leave');
    clearSession();
    setView(null);
    setError('');
  };

  return (
    <div className="app">
      <header className="top">
        <span className="bell-icon" aria-hidden="true">🔔</span>
        <h1>Who Stole the Bell?</h1>
        {view && (
          <button className="link" onClick={leave}>
            Leave table
          </button>
        )}
      </header>

      {!connected && (
        <p className="banner">
          {view ? 'Connection lost. Reconnecting… your seat is saved.' : 'Connecting to the server…'}
        </p>
      )}
      {error && (
        <p className="banner error" role="alert" onClick={() => setError('')}>
          {error}
        </p>
      )}

      <main>
        {!view && rejoining && (
          <section className="card">
            <p className="lede">Getting you back to your table…</p>
          </section>
        )}
        {!view && !rejoining && <Home run={run} />}
        {view?.phase === 'lobby' && <Lobby view={view} run={run} />}
        {view?.phase === 'alibi' && <Alibi view={view} run={run} />}
        {view?.phase === 'discuss' && <Discuss view={view} run={run} />}
        {view?.phase === 'vote' && <Vote view={view} run={run} />}
        {view?.phase === 'result' && <Result view={view} run={run} />}
      </main>
    </div>
  );
}

function Home({ run }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  return (
    <section className="card">
      <p className="lede">
        Someone at the table walked off with the bell. One of you is the Thief. Find them before they
        get away with it.
      </p>
      <label>
        Your nickname
        <input
          value={name}
          maxLength={16}
          placeholder="Use a made-up name"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button className="primary" disabled={!name.trim()} onClick={() => run('create', { name })}>
        Host a table
      </button>

      <div className="divider">or join one</div>

      <label>
        Room code
        <input
          value={code}
          maxLength={4}
          placeholder="ABCD"
          className="code-input"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
      </label>
      <button disabled={!name.trim() || code.length !== 4} onClick={() => run('join', { code, name })}>
        Join table
      </button>
    </section>
  );
}

function PlayerList({ players, hostId, meId, children }) {
  return (
    <ul className="players">
      {players.map((p) => (
        <li key={p.id} className={p.connected ? '' : 'away'}>
          <span>
            {p.name}
            {p.id === meId && <em> (you)</em>}
            {p.id === hostId && <span className="tag">host</span>}
            {!p.connected && <span className="tag">away</span>}
          </span>
          {children?.(p)}
        </li>
      ))}
    </ul>
  );
}

function Lobby({ view, run }) {
  const isHost = view.hostId === view.meId;
  const online = view.players.filter((p) => p.connected).length;
  const enough = online >= view.minPlayers;

  return (
    <section className="card">
      <p className="label">Room code</p>
      <p className="room-code">{view.code}</p>
      <p className="hint">Friends join with this code on their own phones.</p>

      <PlayerList players={view.players} hostId={view.hostId} meId={view.meId} />

      {isHost ? (
        <button className="primary" disabled={!enough} onClick={() => run('start')}>
          {enough ? 'Start the night' : `Need ${view.minPlayers - online} more`}
        </button>
      ) : (
        <p className="hint">Waiting for the host to start…</p>
      )}
    </section>
  );
}

function RoleCard({ role }) {
  const [shown, setShown] = useState(false);
  const isThief = role === 'thief';

  return (
    <div className={`role ${shown ? (isThief ? 'thief' : 'patron') : 'hidden'}`}>
      {shown ? (
        isThief ? (
          <>
            <h2>You took the bell.</h2>
            <p>Blend in. Make up an alibi that sounds true, and don't get voted out.</p>
          </>
        ) : (
          <>
            <h2>You're a Patron.</h2>
            <p>You're innocent. Listen to the alibis and spot who's lying.</p>
          </>
        )
      ) : (
        <p>Your role is hidden</p>
      )}
      <button onClick={() => setShown((s) => !s)}>{shown ? 'Hide role' : 'Peek at my role'}</button>
    </div>
  );
}

function Alibi({ view, run }) {
  const [text, setText] = useState('');
  const isHost = view.hostId === view.meId;
  const me = view.players.find((p) => p.id === view.meId);
  const submitted = me?.hasAlibi;
  const done = view.players.filter((p) => p.hasAlibi).length;

  return (
    <section className="card">
      <RoleCard role={view.role} />

      <h3>Where were you when the bell vanished?</h3>
      {submitted ? (
        <p className="hint">Alibi locked in. Waiting for everyone else…</p>
      ) : (
        <>
          <textarea
            value={text}
            maxLength={140}
            rows={3}
            placeholder={
              view.role === 'thief'
                ? 'Lie convincingly. Keep it believable.'
                : 'Tell the truth about where you were.'
            }
            onChange={(e) => setText(e.target.value)}
          />
          <p className="hint">{text.length}/140</p>
          <button className="primary" disabled={!text.trim()} onClick={() => run('alibi', { text })}>
            Lock in alibi
          </button>
        </>
      )}

      <p className="label">
        Alibis in: {done}/{view.players.filter((p) => p.connected).length}
      </p>
      <PlayerList players={view.players} hostId={view.hostId} meId={view.meId}>
        {(p) => <span className={p.hasAlibi ? 'ok' : 'wait'}>{p.hasAlibi ? '✓' : '…'}</span>}
      </PlayerList>

      {isHost && (
        <button onClick={() => run('advance')}>Start the discussion now</button>
      )}
    </section>
  );
}

function useCountdown(endsAt, skew) {
  const remaining = () => (endsAt ? Math.max(0, Math.ceil((endsAt - (Date.now() + skew)) / 1000)) : 0);
  const [secs, setSecs] = useState(remaining);

  useEffect(() => {
    setSecs(remaining());
    const t = setInterval(() => setSecs(remaining()), 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endsAt, skew]);

  return secs;
}

function AlibiRecap({ view }) {
  return (
    <ul className="alibis">
      {view.players.map((p) => (
        <li key={p.id}>
          <strong>{p.name}</strong>
          <span>{view.alibis[p.id] || '(no alibi given)'}</span>
        </li>
      ))}
    </ul>
  );
}

function Chat({ view, run }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);
  const listRef = useRef(null);

  // Keep the newest message in view, but don't yank the list if someone scrolled up to re-read.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' });
  }, [view.chat.length]);

  const send = async (e) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg) return;
    const res = await run('chat', { text: msg });
    if (res?.ok) setText('');
  };

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {view.chat.length === 0 && (
          <p className="hint">No one's talking yet. Ask someone where they really were.</p>
        )}
        {view.chat.map((m) => (
          <div key={m.id} className={`msg ${m.playerId === view.meId ? 'mine' : ''}`}>
            <strong>{m.playerId === view.meId ? 'You' : m.name}</strong>
            <span>{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="chat-form" onSubmit={send}>
        <input
          value={text}
          maxLength={200}
          placeholder="Accuse someone, defend yourself…"
          onChange={(e) => setText(e.target.value)}
          aria-label="Chat message"
        />
        <button className="primary" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function Discuss({ view, run }) {
  const isHost = view.hostId === view.meId;
  const secs = useCountdown(view.discussEndsAt, view.skew);
  const mm = String(Math.floor(secs / 60)).padStart(1, '0');
  const ss = String(secs % 60).padStart(2, '0');

  return (
    <section className="card">
      <RoleCard role={view.role} />

      <div className={`timer ${secs <= 10 ? 'urgent' : ''}`} role="timer" aria-live="off">
        <span className="timer-label">Last orders in</span>
        <span className="timer-time">
          {mm}:{ss}
        </span>
      </div>

      <h3>Sniff out the Thief</h3>
      <AlibiRecap view={view} />
      <Chat view={view} run={run} />

      {isHost && <button onClick={() => run('advance')}>End discussion, go to vote</button>}
    </section>
  );
}

function Vote({ view, run }) {
  const isHost = view.hostId === view.meId;
  const nameOf = (id) => view.players.find((p) => p.id === id)?.name ?? 'Unknown';
  const votedCount = view.players.filter((p) => p.hasVoted).length;

  useEffect(() => {
    ding(); // the bell rings when discussion time is up
  }, []);

  return (
    <section className="card">
      <RoleCard role={view.role} />
      <h3>Time's up. Who's lying?</h3>

      <AlibiRecap view={view} />
      <Chat view={view} run={run} />

      <p className="label">Cast your vote</p>
      <div className="suspects">
        {view.players
          .filter((p) => p.id !== view.meId)
          .map((p) => (
            <button
              key={p.id}
              className={view.myVote === p.id ? 'selected' : ''}
              onClick={() => run('vote', { suspectId: p.id })}
            >
              {p.name}
            </button>
          ))}
      </div>
      {view.myVote && <p className="hint">You voted for {nameOf(view.myVote)}. You can change it until everyone's in.</p>}
      <p className="label">
        Votes in: {votedCount}/{view.players.filter((p) => p.connected).length}
      </p>

      {isHost && <button onClick={() => run('finishVote')}>Ring the bell (end vote now)</button>}
    </section>
  );
}

function Result({ view, run }) {
  const isHost = view.hostId === view.meId;
  const r = view.result;
  const nameOf = (id) => view.players.find((p) => p.id === id)?.name ?? 'Unknown';
  const dinged = useRef(false);

  useEffect(() => {
    if (!dinged.current) {
      dinged.current = true;
      ding();
    }
  }, []);

  const caught = r.winner === 'patrons';

  return (
    <section className="card">
      <h2 className={caught ? 'win' : 'lose'}>
        {caught ? 'The Patrons win!' : 'The Thief gets away.'}
      </h2>
      <p className="reveal">
        The Thief was <strong>{nameOf(r.thiefId)}</strong>.
      </p>
      <p className="hint">
        {r.tie
          ? 'The vote was tied, so nobody was caught.'
          : r.accusedId
            ? `The table accused ${nameOf(r.accusedId)}.`
            : 'Nobody got any votes.'}
      </p>

      <p className="label">Votes</p>
      <ul className="players">
        {view.players.map((p) => (
          <li key={p.id}>
            <span>
              {p.name}
              {p.id === r.thiefId && <span className="tag thief-tag">thief</span>}
            </span>
            <span>{r.tally[p.id] || 0}</span>
          </li>
        ))}
      </ul>

      {isHost ? (
        <button className="primary" onClick={() => run('playAgain')}>
          Back to the lobby
        </button>
      ) : (
        <p className="hint">Waiting for the host to start another round…</p>
      )}
    </section>
  );
}
