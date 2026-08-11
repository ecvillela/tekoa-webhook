# TEKOA webhook

Backend real que responde pelo número +55 11 91049-7104 no WhatsApp. Cobre 6 dos 7 fluxos do teste de mesa (onboarding, bilhete escolar, carteira de vacinação, receita médica, pergunta livre, confirmação por botão). Áudio ainda é um stub honesto (recebe e avisa que a transcrição não está ativa nesta versão). Bom-dia proativo tem o cron pronto, mas só entrega de fato fora da janela de 24h depois que um template for aprovado pela Meta.

## Variáveis de ambiente (configurar no painel do Vercel, nunca em código)

- `WHATSAPP_ACCESS_TOKEN` — token gerado na Etapa 2 do Meta for Developers
- `WHATSAPP_PHONE_NUMBER_ID` — em WhatsApp Manager > Configuração da API (não é o WABA ID)
- `WHATSAPP_VERIFY_TOKEN` — qualquer string que você inventar, usada no handshake do webhook
- `ANTHROPIC_API_KEY` — chave da API da Anthropic (console.anthropic.com)
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — preenchidas automaticamente ao criar um KV em Vercel > Storage
- `TEST_PHONE` — seu número, para o cron de bom-dia saber pra quem mandar (fase de teste)

## Deploy

1. Import este repo no Vercel (Continue with GitHub).
2. Settings > Environment Variables: preencha as 4 primeiras.
3. Storage > Create Database > KV: conecta ao projeto e injeta as duas últimas automaticamente.
4. Copie a URL gerada (ex: `https://tekoa-webhook.vercel.app/api/webhook`).
5. Meta for Developers > WhatsApp > Configuration > Webhook: cole a URL + o `WHATSAPP_VERIFY_TOKEN`, clique Verify and Save, inscreva no campo `messages`.

## Testar sem deploy

`node test/run.js` — roda a suíte com mocks do WhatsApp e do Claude, valida a máquina de estados.
`node test/server.js` — sobe um servidor local na porta 3123 simulando o payload real da Meta (GET de verificação e POST de mensagem).
