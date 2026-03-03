const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/whatsapp", (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMessage = req.body.Body || "";

  console.log("Mensagem recebida:", incomingMessage);

  twiml.message(
    `Oi! Eu sou a Lia 😊\n\n` +
    `Vou te ajudar por aqui.\n\n` +
    `Me conta: é mais por dor, sono ou ansiedade?`
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get("/", (req, res) => {
  res.send("Lia está rodando!");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
