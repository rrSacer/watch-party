// Cenário 3: navegador do amigo bloqueia o play automático; o clique dele não pode mexer no grupo.
const { setup } = require('./lib');
(async () => {
  const h = await setup({ autoplay: false, port: 3121 });
  await h.sleep(4000);
  await h.A.click('#v'); // clique de verdade: o host dá play
  await h.watch(7, 'host play');
  const gate = await h.B.evaluate(() => !document.getElementById('gate').classList.contains('hidden'));
  console.log('botao de sincronia visivel no amigo:', gate);
  if (gate) await h.B.click('#gate');
  await h.watch(10, 'apos clique');
  const [a, b] = await Promise.all([h.pos(h.A), h.pos(h.B)]);
  const sum = await h.summary();
  console.log(JSON.stringify(sum, null, 1));
  const okk = gate && sum.A.back === 0 && !sum.B.tx.includes('play') && !a.p && !b.p && Math.abs(a.t - b.t) < 0.35;
  console.log((okk ? 'OK   ' : 'FALHA') + ' clique do amigo nao mexe no host', { a: a.t, b: b.t });
  await h.logs((k) => k === 'BACK' || k === 'TX');
  await h.close();
  if (!okk) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
