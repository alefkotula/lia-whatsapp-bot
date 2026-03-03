const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

function isUrgent(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("dor no peito") ||
    t.includes("falta de ar") ||
    t.includes("desmaiei") ||
    t.includes("desmaio") ||
    t.includes("fraqueza de um lado") ||
    t.includes("fala enrolada") ||
    t.includes("confusão súbita") ||
    t.includes("convuls") ||
    t.includes("sangramento intenso")
  );
}

async function downloadTwilioMedia(mediaUrl) {
  // Twilio exige Basic Auth para baixar mídia
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const resp = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!resp.ok) {
    throw new Error(`Falha ao baixar mídia do Twilio: ${resp.status} ${resp.statusText}`);
  }

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await resp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

async function transcribeAudioWithOpenAI({ buffer, contentType }) {
  // Usa endpoint de transcrição (Whisper) - estável e funciona bem com OGG/OPUS do WhatsApp
  const form = new FormData();

  const blob = new Blob([buffer], { type: contentType });
  // Nome de arquivo genérico (o modelo não precisa do nome real)
  form.append("file", blob, "audio.ogg");
  form.append("model", "whisper-1");
  form.append("language", "pt");

  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha na transcrição OpenAI: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return (data.text || "").trim();
}

async function generateReply(userText, cameFromAudio) {
  // Regras de “secretária humana” + conversão sem parecer robô
  // (Sem diagnóstico/prescrição; foco em acolher, qualificar e levar ao agendamento)
  if (isUrgent(userText)) {
    return "Pelo que você descreveu, isso pode ser urgente. Procure um pronto atendimento agora (ou ligue para a emergência local). Se quiser, me diga sua cidade que eu te ajudo a achar o serviço mais próximo.";
  }

  // Prompts enxutos para manter resposta curta e humana
  const system = `
Você é Lia, secretária humana e acolhedora da equipe do Dr. Alef Kotula (consulta 100% online).
Missão: acolher, qualificar em poucas mensagens e conduzir ao agendamento.

Regras fixas:
- Não diagnosticar. Não prescrever. Não prometer cura. Não usar termos técnicos.
- Mensagens curtas, naturais, sem cara de robô.
- Faça 1 pergunta por vez (sempre termine com 1 pergunta).

Se veio ÁUDIO:
1) Valide a emoção em 1 frase curta (ex: “Entendi 🙏” / “Poxa, sinto muito…”).
2) Resuma em 1 linha o que entendeu (sem inventar detalhes).
3) Faça 1 pergunta objetiva (tempo / intensidade / impacto).
Evite frases genéricas tipo “Como isso tem afetado seu dia a dia?”. Prefira perguntas específicas.
`;

  const user = `
Mensagem do paciente: "${userText}"
Contexto: ${cameFromAudio ? "veio de ÁUDIO (confirmar entendimento)" : "veio de TEXTO"}.
Crie a próxima resposta da Lia em português do Brasil.
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // força ser curtinha
      max_output_tokens: 180,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha no chat OpenAI: ${resp.status} ${errText}`);
  }

  const data = await resp.json();

  // pega texto final (compatível com Responses API)
  const text =
    (data.output_text && data.output_text.trim()) ||
    (data.output?.[0]?.content?.[0]?.text?.trim()) ||
    "Entendi. Me conta: é mais por dor, sono ou ansiedade?";

  return text;
}

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingText = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    console.log("Mensagem recebida:", { incomingText, numMedia });

    // Se vier áudio/imagem/etc
    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0 || "";

      // Se for áudio, transcreve
      if (mediaType.startsWith("audio/")) {
        const media = await downloadTwilioMedia(mediaUrl);
        const transcript = await transcribeAudioWithOpenAI(media);

        // Modo (b): confirmar que entendeu + resumo + pergunta
        const reply = await generateReply(transcript, true);
        twiml.message(reply);
      } else {
        // Se não for áudio, responde pedindo texto (pra manter simples por enquanto)
        twiml.message("Recebi seu arquivo 😊 Pra eu te ajudar melhor, me manda em texto: é mais por dor, sono ou ansiedade?");
      }
    } else {
      // Texto normal
      const reply = await generateReply(incomingText || "Olá", false);
      twiml.message(reply);
    }

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error(err);
    twiml.message("Ops, tive um probleminha aqui. Pode tentar de novo em texto? 😊");
    res.type("text/xml").send(twiml.toString());
  }
});

app.get("/", (req, res) => {
  res.send("Lia está rodando!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
