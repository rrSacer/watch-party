// Cenário 2: ações das pessoas (pausa, play, pulos, arrastar a barra) com 40 ms ou mais de atraso.
const { setup } = require('./lib');
const LAT = Number(process.argv[2] || 40);
(async () => {
  const h = await setup({ port: 3111 }); h.slow.lat = LAT;
  const res = []; const ok = (name, cond, info) => { res.push((cond ? 'OK   ' : 'FALHA') + ' ' + name + ' ' + JSON.stringify(info)); };
  const both = async () => { const [a, b] = await Promise.all([h.pos(h.A), h.pos(h.B)]); return { a, b, d: +(a.t - b.t).toFixed(2) }; };
  await h.sleep(4000);
  await h.A.evaluate(() => document.getElementById('v').play());
  await h.watch(8, 'play A');
  let s = await both(); ok('tocando juntos', !s.a.p && !s.b.p && Math.abs(s.d) < 0.35 && s.a.t > 2, s);
  await h.B.evaluate(() => document.getElementById('v').pause());
  await h.watch(3, 'pausa B');
  s = await both(); ok('pausa do amigo pausa todos', s.a.p && s.b.p && Math.abs(s.d) < 0.55, s) // pausado, a tolerância do site é 0,5s;
  await h.B.evaluate(() => document.getElementById('v').play());
  await h.watch(5, 'play B');
  s = await both(); ok('play do amigo toca todos', !s.a.p && !s.b.p && Math.abs(s.d) < 0.35, s);
  await h.A.evaluate(() => { document.getElementById('v').currentTime = 600; });
  await h.watch(8, 'A pula 600');
  s = await both(); ok('pulo do host', !s.a.p && !s.b.p && s.a.t > 600 && s.a.t < 612 && Math.abs(s.d) < 0.35, s);
  await h.B.evaluate(() => { document.getElementById('v').currentTime = 300; });
  await h.watch(8, 'B pula 300');
  s = await both(); ok('pulo do amigo para trás', !s.a.p && !s.b.p && s.a.t > 300 && s.a.t < 312 && Math.abs(s.d) < 0.35, s);
  // arrastar a barra: 8 pulos em 1,6 s, terminando em 900
  for (let i = 0; i < 8; i++) { await h.B.evaluate((t) => { document.getElementById('v').currentTime = t; }, 500 + i * 57.2); await h.sleep(200); }
  await h.watch(9, 'B arrasta');
  s = await both(); ok('arrastar a barra', !s.a.p && !s.b.p && s.a.t > 900 && s.a.t < 913 && Math.abs(s.d) < 0.35, s);
  // pausa do host e pulo com o vídeo parado
  await h.A.evaluate(() => document.getElementById('v').pause());
  await h.sleep(1500);
  await h.A.evaluate(() => { document.getElementById('v').currentTime = 1500; });
  await h.watch(5, 'pausado');
  s = await both(); ok('pulo com vídeo parado', s.a.p && s.b.p && Math.abs(s.a.t - 1500) < 0.55 && Math.abs(s.d) < 0.55, s);
  await h.A.evaluate(() => document.getElementById('v').play());
  await h.watch(15, 'final');
  s = await both(); ok('retoma junto', !s.a.p && !s.b.p && s.a.t > 1510 && Math.abs(s.d) < 0.3, s);
  const sum = await h.summary();
  // Voltas esperadas: só o pulo para 300 (1 em cada navegador). Os pulos pra frente não contam como volta.
  ok('voltas no tempo', sum.A.back <= 1 && sum.B.back <= 1, { A: sum.A.back, B: sum.B.back });
  console.log(JSON.stringify(sum, null, 1));
  await h.logs((k) => k === 'BACK' || k === 'TX');
  console.log('\n' + res.join('\n'));
  await h.close();
  if (res.some((r) => r.startsWith('FALHA'))) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
