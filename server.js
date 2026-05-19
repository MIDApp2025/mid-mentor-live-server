const http = require('http');
const WebSocket = require('ws');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('MID Mentor Live Server is Running\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log("Puhelin yhdisti palvelimelle! Avataan yhteys Geminiin...");
  let geminiWs = new WebSocket(GEMINI_WS_URL);
  let isSetupDone = false;

  geminiWs.on('open', () => {
    console.log("Yhteys Google Gemini 3.1 Liveen on auki!");
    
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
    isSetupDone = true;
  });

  // Gemini -> Flutter
  geminiWs.on('message', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Flutter -> Gemini (KORJATTU JA VARMISTETTU DATAN KÄSITTELY)
  ws.on('message', (message) => {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isSetupDone) return;

    try {
      // Muutetaan Flutterista tullut data (oli se sitten Buffer, ArrayBuffer tai teksti) varmasti Base64-muotoon
      const rawBuffer = Buffer.from(message);
      
      // Varmistetaan, ettei lähetetä tyhjiä paketteja
      if (rawBuffer.length === 0) return;

      const base64Audio = rawBuffer.toString("base64");
      
      const audioEvent = {
        realtimeInput: {
          mediaChunks: [{ 
            mimeType: "audio/pcm;rate=16000", 
            data: base64Audio 
          }]
        }
      };
      
      geminiWs.send(JSON.stringify(audioEvent));
    } catch (error) {
      console.error("Virhe datan muunnoksessa:", error);
    }
  });

  ws.on('close', () => {
    console.log("Puhelu päättyi.");
    if (geminiWs) geminiWs.close();
  });

  geminiWs.on('close', () => {
    console.log("Gemini sulki yhteyden.");
    ws.close();
  });
  
  geminiWs.on('error', (err) => console.error("Gemini virhe:", err));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Palvelin pyörii onnistuneesti portissa ${PORT}`);
});
