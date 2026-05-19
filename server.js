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
  
  // 🎯 PORTINVARTTIJA: False kunnes Google on VALMIS ottamaan vastaan ääntä
  let isGoogleReady = false; 

  geminiWs.on('open', () => {
    console.log("Yhteys Google Gemini 3.1 Liveen avattu. Lähetetään setup...");
    
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
    
    // Antaa Googlelle pienen hetken (100ms) aktivoida malli ennen kuin sallitaan ääni
    setTimeout(() => {
      isGoogleReady = true;
      console.log("🚀 Gemini 3.1 Live on nyt valmis vastaanottamaan puhetta!");
    }, 100);
  });

  // Gemini -> Flutter
  geminiWs.on('message', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Flutter -> Gemini
  ws.on('message', (message) => {
    // 🎯 JOS GOOGLE EI OLE VALMIS, HEITETÄÄN ALKUTAVUT POIS EIKÄ RIKOTA YHTEYTTÄ
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isGoogleReady) {
      return; 
    }

    try {
      const rawBuffer = Buffer.from(message);
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
