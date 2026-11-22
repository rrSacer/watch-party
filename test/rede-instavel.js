// Cenário 1: amigo com internet instável. Ninguém mexe no vídeo depois do play; não pode haver volta no tempo.
const { setup } = require('./lib');
(async () => {
  const h = await setup();
  await h.sleep(4000);
  await h.A.evaluate(() => document.getElementById('v').play());
  await h.watch(10, 'normal');
  h.slow.kbps = 250; console.log('--- amigo cai para 250 kbps');
  await h.watch(25, 'lento');
  h.slow.kbps = 3000; console.log('--- amigo volta a 3 Mbps');
  await h.watch(20, 'volta');
  const sum = await h.summary();
  console.log(JSON.stringify(sum, null, 1));
  await h.logs((k) => k !== 'ev');
  await h.close();
  const okk = sum.A.back === 0 && sum.B.back === 0;
  console.log((okk ? 'OK   ' : 'FALHA') + ' nenhuma volta no tempo com a rede instavel');
  if (!okk) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
