require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);          // necesario detrás del hosting (Render)
app.use(cors());
app.use(express.json({ limit: '20kb' }));

// Ruta simple para comprobar que el servidor está vivo
app.get('/', (req, res) => res.send('Backend de FitIA funcionando'));

// Límite básico: máximo 20 solicitudes por minuto por visitante
// (protege tu cuota gratuita si alguien encuentra la dirección)
const visitas = new Map();
function limitar(req, res, next) {
  const ip = req.ip;
  const ahora = Date.now();
  const recientes = (visitas.get(ip) || []).filter(t => ahora - t < 60000);
  if (recientes.length >= 20) {
    return res.status(429).json({ error: 'Muchas solicitudes, espera un momento' });
  }
  recientes.push(ahora);
  visitas.set(ip, recientes);
  next();
}

// Si este modelo deja de existir, cambia GROQ_MODEL en tu archivo .env
// (la lista actual está en console.groq.com/docs/models)
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const SYSTEM = `Eres el entrenador personal de FitIA, una app que cuenta repeticiones con la cámara.
Responde siempre en español, de forma breve (máximo 3 frases), motivadora y concreta.
Compara la serie actual con el historial cuando sea posible y sugiere el siguiente paso (por ejemplo, cuánto descansar o cuántas repeticiones intentar).
No des consejos médicos: si el usuario menciona dolor, recomienda parar y consultar a un profesional.`;

app.post('/api/feedback', limitar, async (req, res) => {
  try {
    const { ejercicio, repeticiones, duracionSegundos, historial } = req.body || {};

    if (!ejercicio || typeof repeticiones !== 'number') {
      return res.status(400).json({ error: 'Faltan datos: ejercicio y repeticiones' });
    }

    const ultimas = Array.isArray(historial) ? historial.slice(-10) : [];

    const prompt = `Serie que acaba de terminar:
- Ejercicio: ${String(ejercicio).slice(0, 50)}
- Repeticiones: ${repeticiones}
- Duración: ${duracionSegundos ?? 'desconocida'} segundos

Historial reciente (de más antiguo a más nuevo):
${ultimas.length ? JSON.stringify(ultimas) : 'Sin historial todavía'}

Dame tu feedback como entrenador.`;

    const cuerpo = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt }
      ],
      // Margen amplio: los modelos que "razonan" gastan parte de este límite pensando
      max_tokens: 1500,
      temperature: 0.7
    };
    // Los modelos gpt-oss aceptan este ajuste para pensar menos y responder más rápido
    if (MODEL.startsWith('openai/gpt-oss')) cuerpo.reasoning_effort = 'low';

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify(cuerpo)
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('Error de la API de Groq:', JSON.stringify(data));
      return res.status(502).json({ error: 'No se pudo obtener respuesta del entrenador' });
    }

    const mensaje = (data?.choices?.[0]?.message?.content || '').trim();

    res.json({ mensaje: mensaje || 'Buen trabajo, sigue así.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend de FitIA en http://localhost:${PORT}`));
