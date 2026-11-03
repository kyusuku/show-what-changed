const [stateDir, origin, side] = process.argv.slice(2);
require('node:fs').writeFileSync(`${stateDir}/auth.json`, JSON.stringify({
  cookies: [{ name: 'session', value: `${side}-cookie`, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [{ origin, localStorage: [{ name: 'local-auth', value: `${side}-storage` }] }],
}));
