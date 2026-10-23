require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);          // necesario detrás del hosting (Render)
app.use(cors());
app.use(express.json({ limit: '20kb' }));

// Ruta simple para comprobar que el servidor está vivo
app.get('/', (req, res) => res.send('Backend de FitIA funcionando'));

// Si este modelo deja de existir, cambia GROQ_MODEL en las variables de entorno
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

const SYSTEM_BASE = `Eres el entrenador personal de FitIA, una app que cuenta repeticiones con la cámara.
Responde siempre en español, de forma breve, motivadora y concreta.
Solo hablas de entrenamiento, ejercicio, técnica, descanso, recuperación y hábitos saludables; si te piden otra cosa, redirige amablemente al entrenamiento.
No des consejos médicos: si el usuario menciona dolor, lesión o malestar, recomienda parar y consultar a un profesional de la salud.`;

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

// Llama al modelo de Groq y devuelve el texto de la respuesta
async function preguntarModelo(system, mensajes) {
  const cuerpo = {
    model: MODEL,
    messages: [{ role: 'system', content: system }, ...mensajes],
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
    throw new Error('api');
  }
  return (data?.choices?.[0]?.message?.content || '').trim();
}

// Deja solo los datos esperados del historial (últimas 10 series)
function resumirHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  return historial.slice(-10).map(h => ({
    fecha: String(h?.fecha || '').slice(0, 10),
    ejercicio: String(h?.ejercicio || '').slice(0, 40),
    reps: Number(h?.reps) || 0
  }));
}

// ---- Feedback automático al terminar una serie ----
app.post('/api/feedback', limitar, async (req, res) => {
  try {
    const { ejercicio, repeticiones, duracionSegundos, historial } = req.body || {};

    if (!ejercicio || typeof repeticiones !== 'number') {
      return res.status(400).json({ error: 'Faltan datos: ejercicio y repeticiones' });
    }

    const ultimas = resumirHistorial(historial);

    const prompt = `Serie que acaba de terminar:
- Ejercicio: ${String(ejercicio).slice(0, 50)}
- Repeticiones: ${repeticiones}
- Duración: ${duracionSegundos ?? 'desconocida'} segundos

Historial reciente (de más antiguo a más nuevo):
${ultimas.length ? JSON.stringify(ultimas) : 'Sin historial todavía'}

Da tu feedback como entrenador en máximo 3 frases. Compara con el historial cuando sea posible y sugiere el siguiente paso (por ejemplo, cuánto descansar o cuántas repeticiones intentar).`;

    const mensaje = await preguntarModelo(SYSTEM_BASE, [{ role: 'user', content: prompt }]);
    res.json({ mensaje: mensaje || 'Buen trabajo, sigue así.' });
  } catch (err) {
    if (err.message === 'api') return res.status(502).json({ error: 'No se pudo obtener respuesta del entrenador' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---- Chat con el entrenador ----
app.post('/api/chat', limitar, async (req, res) => {
  try {
    const { mensajes, historial } = req.body || {};

    if (!Array.isArray(mensajes) || mensajes.length === 0) {
      return res.status(400).json({ error: 'Falta el mensaje' });
    }

    const limpios = mensajes.slice(-10)
      .map(m => ({
        role: m?.rol === 'assistant' ? 'assistant' : 'user',
        content: String(m?.texto || '').slice(0, 600)
      }))
      .filter(m => m.content.trim());

    if (!limpios.length || limpios[limpios.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'El último mensaje debe ser del usuario' });
    }

    const ultimas = resumirHistorial(historial);
    const system = `${SYSTEM_BASE}
En este chat responde en máximo 4 frases, a menos que te pidan una rutina o una lista.

Historial reciente de series del usuario (puede estar vacío):
${ultimas.length ? JSON.stringify(ultimas) : 'Sin historial todavía'}`;

    const mensaje = await preguntarModelo(system, limpios);
    res.json({ mensaje: mensaje || 'No tengo una respuesta ahora, inténtalo de nuevo.' });
  } catch (err) {
    if (err.message === 'api') return res.status(502).json({ error: 'No se pudo obtener respuesta del entrenador' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend de FitIA en http://localhost:${PORT}`));
