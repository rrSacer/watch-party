# Watch Party

Site para assistir a um vídeo junto com amigos. Uma pessoa envia o arquivo; quando alguém dá play, pausa ou pula, o comando vale para todos.

## Como rodar

```
npm install
npm start
```

Abra http://localhost:3000, crie uma sala, envie o vídeo e mande o link da sala para os amigos.

- **Node.js** 18 ou mais novo.
- **ffmpeg** (opcional, recomendado): no envio de um MP4, o servidor reorganiza o arquivo para ele começar a tocar sem precisar baixar o final. Sem ffmpeg o site funciona, mas o início fica mais lento para quem assiste de fora.
- Formatos: MP4 (H.264) e WebM tocam em qualquer navegador.
- Porta: `PORT=8080 npm start`. Pasta dos vídeos: `UPLOADS=/caminho npm start` (padrão: `uploads/`).
- Para amigos fora da sua rede, encaminhe a porta no roteador ou use um túnel (cloudflared, ngrok).

Os vídeos enviados ficam na pasta `uploads/` e as salas voltam sozinhas quando o servidor reinicia.

## Como a sincronização funciona

- O relógio do vídeo é do servidor. Play e pausa valem a partir da posição do servidor; só o pulo usa a posição de quem pulou.
- A cada 2 segundos cada navegador compara sua posição com a do servidor, descontando o atraso da rede. Diferença pequena é corrigida acelerando ou desacelerando até 10%; acima de 1 segundo, o vídeo pula.
- Se alguém fica sem vídeo baixado para tocar, todos pausam e aparece "Aguardando fulano carregar…". Depois de 30 segundos o grupo segue sem essa pessoa.

## Testes

Os testes abrem dois navegadores Firefox reais, um deles atrás de um proxy que limita a banda e atrasa a rede, e conferem que o vídeo não volta no tempo sozinho.

```
npx playwright install firefox
VIDEO=/caminho/para/um.mp4 npm run test:sync
```

O vídeo de teste não fica no repositório: use qualquer MP4 (H.264) com pelo menos 26 minutos.
