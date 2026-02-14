import type { ForestConfig } from '../config';

export async function generateText(config: ForestConfig, prompt: string, context: string): Promise<string> {
  const ai = config.ai;
  if (!ai?.apiKey) throw new Error('AI not configured. Set ai.apiKey in .forest/local.json');

  if (ai.provider === 'openai') return callOpenAI(ai.apiKey, ai.model || 'gpt-4o-mini', prompt, context);
  return callGemini(ai.apiKey, ai.model || 'gemini-2.0-flash-lite', prompt, context);
}

async function callGemini(apiKey: string, model: string, prompt: string, context: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${prompt}\n\n${context}` }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function callOpenAI(apiKey: string, model: string, prompt: string, context: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: context },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content?.trim() || '';
}
