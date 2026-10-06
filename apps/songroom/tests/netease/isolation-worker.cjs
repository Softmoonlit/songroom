process.umask(0o077);
process.once('message', message => {
  const fs = require('node:fs');
  console.log('RAW-STDOUT-SECRET');
  console.error('RAW-STDERR-SECRET');
  process.send({ok: true, data: {key: JSON.stringify({pid: process.pid, cwd: process.cwd(), env: process.env, mode: fs.statSync(process.cwd()).mode & 0o777, mask: process.umask(), cookie: message.cookie, deviceId: message.deviceId, timeout: message.requestTimeoutMs})}}, () => process.exit(0));
});
