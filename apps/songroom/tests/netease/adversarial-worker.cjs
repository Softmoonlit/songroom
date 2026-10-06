process.umask(0o077);
process.once('message', ({input}) => {
  const mode = input.key || input.songId;
  if (mode === 'hang') { setInterval(() => {}, 100); return; }
  if (mode === 'exit') { process.exit(0); }
  if (mode === 'crash') { process.exit(7); }
  if (mode === 'failedCrash') { process.send({ok:false,error:{code:'AUTH_UNAVAILABLE',outcome:'failed'}},()=>process.exit(7)); return; }
  if (mode === 'malformed') { process.send({ok:true,data:{acknowledged:true,raw:'MUSIC_U=secret'}},()=>process.exit(0)); return; }
  if (mode === 'duplicate') { process.send({ok:true,data:{acknowledged:true}}); process.send({ok:true,data:{acknowledged:true}},()=>process.exit(0)); return; }
  process.send({ok:true,data:{status:'waiting'}},()=>process.exit(0));
});
