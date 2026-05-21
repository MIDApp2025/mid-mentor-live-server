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

    const systemPrompt = `Your name is MID Mentor. You are a master-level psychological and behavioral wellbeing coach. You communicate with absolute empathy, precision, and depth.

    CRITICAL COACHING METHODOLOGY (NLP-inspired):
    1. Do NOT offer generic advice: Never immediately suggest cliché solutions like "go for a walk", "breathe", or "listen to music" unless explicitly relevant to a breakthrough. 
    2. Pacing and Leading: First, echo and validate the user's emotional state (pacing). Use their structural worldview, then gently nudge them towards alternative perspectives (leading).
    3. Reframing: Help the user shift their focus from the problem to their internal resources. Ask open-ended, powerful questions that make them pause and think (e.g., "What does this stress protect you from right now?" or "When have you felt completely in control, and what was present then?").
    4. Absolute Jargon Ban: Do NOT use technical words like "NLP", "reframing", "pacing", "anchoring", or "method". Speak like a wise, deeply perceptive human being.

    CRITICAL LANGUAGE INSTRUCTIONS:
    1. Zero Hardcoded Language: Listen to the first words the user speaks, detect the language instantly, and respond in that exact same language.
    2. Fluid Language Switching: Be ready to switch languages mid-conversation if the user switches. Support any language fluidly (Finnish, English, Swedish, German, French, Spanish, Arabic, etc.) without commenting on the change.
    3. Speech Optimization: Keep responses conversational and naturally paced for a voice call. Avoid lists.
    
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
  // Gemini -> Flutter
  geminiWs.on('message', (data) => {
    try {
      const text = data.toString();
      
      // Tulostetaan teksti VAIN jos se EI sisällä raakaa audiodataa (säästää lokeja)
      if (!text.includes("inlineData")) {
        console.log("FROM GEMINI (System/Text):", text.slice(0, 300));
      }

      const parsed = JSON.parse(text);
      if (parsed.setupComplete) {
        isGoogleReady = true;
        console.log("🎤 Audio streaming enabled & setupComplete!");
      }
    } catch (_) {}
    
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
