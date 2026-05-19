const http = require('http');
const WebSocket = require('ws');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// Luodaan standardi HTTP-palvelin, jota Railway vaatii proxyään varten
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MID Mentor Live Server is Running\n');
});

// Kiinnitetään WebSocket-palvelin tähän HTTP-palvelimeen
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log("Puhelin yhdisti palvelimelle! Avataan yhteys Geminiin...");
  let geminiWs = new WebSocket(GEMINI_WS_URL);

  geminiWs.on('open', () => {
    console.log("Yhteys Google Gemini 3.1 Liveen on auki!");
    
    // Lähetetään virallinen maaliskuun 2026 setup-viesti
    const setupMessage = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "aoede" } }
          }
        },
        systemInstruction: {
          parts: [{ text: "Your name is MID Mentor. You are a supportive wellbeing coach. Keep answers very short, 2 sentences max." }]
        }
      }
    };
    geminiWs.send(JSON.stringify(setupMessage));
  });

  // Gemini -> Flutter
  geminiWs.on('message', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Flutter -> Gemini
  ws.on('message', (message) => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      if (Buffer.isBuffer(message) || message instanceof Uint8Array) {
        const base64Audio = Buffer.from(message).toString("base64");
        const audioEvent = {
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Audio }]
          }
        };
        geminiWs.send(JSON.stringify(audioEvent));
      } else {
        try {
          geminiWs.send(message.toString());
        } catch (e) {}
      }
    }
  });

  ws.on('close', () => {
    console.log("Puhelu päättyi.");
    if (geminiWs) geminiWs.close();
  });

  geminiWs.on('close', () => ws.close());
  geminiWs.on('error', (err) => console.error("Gemini virhe:", err));
});

// Käynnistetään palvelin Railwayn antamaan porttiin
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Palvelin pyörii onnistuneesti portissa ${PORT}`);
});
