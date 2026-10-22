// `npm test`: starts a throwaway server with short timers, runs every test script against it, then stops it.
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || '3101';
const SCRIPTS = ['test-world.js', 'test-map.js', 'test-roles.js', 'test-sim.js', 'test-map-sim.js', 'test-reconnect.js'];

const server = spawn(process.execPath, ['index.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT, DISCUSS_SECONDS: '2', GRACE_SECONDS: '2', NIGHT_SECONDS: '8', STEAL_LOCKOUT_SECONDS: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let ready = false;
const guard = setTimeout(() => finish(1, 'Timed out after 90s.'), 90_000);

function finish(code, message) {
  clearTimeout(guard);
  if (message) console.error(message);
  server.kill();
  process.exit(code);
}

function run(script) {
  return new Promise((resolve) => {
    console.log(`\n--- ${script} ---`);
    const child = spawn(process.execPath, [script], {
      cwd: __dirname,
      env: { ...process.env, URL: `http://localhost:${PORT}`, GRACE_SECONDS: '2' },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

server.stdout.on('data', async (chunk) => {
  if (ready || !String(chunk).includes('server on')) return;
  ready = true;
  for (const script of SCRIPTS) {
    const code = await run(script);
    if (code !== 0) return finish(code, `${script} failed.`);
  }
  finish(0);
});

server.on('exit', (code) => {
  if (!ready) finish(1, `Server exited early (code ${code}). Is port ${PORT} free?`);
});
