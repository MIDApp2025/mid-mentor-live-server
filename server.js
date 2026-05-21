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
  
  let isGoogleReady = false; 

geminiWs.on('open', () => {
    console.log("Yhteys Google Gemini 3.1 Liveen avattu. Lähetetään setup...");
    
    // 🧠 PALAUTE EDELLESEN PUHELUN ASIASTA (Paikka Firebasen datalle)
    const edellinenPuheluTiivistelma = "Käyttäjän kanssa on aloitettu hyvinvointivalmennus."; 

    const systemPrompt = `Your name is MID Mentor. You are a compassionate, professional wellbeing coach. 
    
    CRITICAL INSTRUCTIONS FOR TONE AND METHOD:
    1. Coaching Style: Guide the user deeply using advanced psychological and behavioral coaching patterns (such as reframing, pacing, and leading), but NEVER mention technical terms like "NLP", "Neuro-linguistic programming", "framework", or "technique" to the user. Keep it completely natural and conversational.
    2. Zero Hardcoded Language: Do NOT assume a default language. Listen to the first words the user speaks, detect the language instantly, and respond in that exact same language. 
    3. Fluid Language Switching: Be ready to switch languages mid-conversation if the user switches. Support any language fluidly (Finnish, English, Swedish, German, French, Spanish, Arabic, etc.) without commenting on the language change.
    4. Speech Optimization: Keep your responses naturally structured for a real-time voice call. Avoid long bulleted lists and overly text-heavy explanations.
    
    CONTEXT FROM PREVIOUS SESSION:
    ${edellinenPuheluTiivistelma}`;
    
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
          parts: [{ text: systemPrompt }]
        }
      }
    };
    
    geminiWs.send(JSON.stringify(setupMessage));
  });

  // Gemini -> Flutter
  geminiWs.on('message', (data) => {
    const text = data.toString();
    console.log("FROM GEMINI:", text.slice(0, 500));

    try {
      const parsed = JSON.parse(text);
      if (parsed.setupComplete) {
        isGoogleReady = true;
        console.log("🎤 Audio streaming enabled");
        console.log("🚀 Gemini setupComplete vastaanotettu!");
      }
    } catch (_) {}
    
    if (text.includes("serverContent")) {
      console.log("🎧 AI RESPONSE RECEIVED");
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // Flutter -> Gemini
  ws.on('message', (message) => {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN || !isGoogleReady) {
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());
      geminiWs.send(JSON.stringify(parsed));
    } catch (error) {
      console.error("Virhe JSON välityksessä:", error);
    }
  });

  ws.on('close', () => {
    console.log("Puhelu päättyi.");
    if (geminiWs) {
      geminiWs.close();
    }
  });

  geminiWs.on('close', (code, reason) => {
    console.log("Gemini sulki yhteyden.");
    console.log("CODE:", code);
    console.log("REASON:", reason.toString());
  });

  geminiWs.on('error', (err) => {
    console.error("Gemini virhe:", err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Palvelin pyörii onnistuneesti portissa ${PORT}`);
});
