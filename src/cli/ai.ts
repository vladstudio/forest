import type { AIConfig } from '../config';
import { log } from '../logger';

export async function generatePRBody(config: AIConfig, diff: string, title: string): Promise<string> {
  const prompt = `Write a pull request description for the following changes. Be concise. Use markdown. Start with a short summary paragraph, then a bullet list of key changes if needed. Do not include a title.

PR title: ${title}

Diff:
${diff}`;

  const message = await callProvider(config, prompt);
  return message;
}

async function callProvider(config: AIConfig, prompt: string): Promise<string> {
  switch (config.provider) {
    case 'anthropic': return callAnthropic(config, prompt);
    case 'openai': return callOpenAI(config, prompt);
    case 'gemini': return callGemini(config, prompt);
    default: throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}

async function callAnthropic(config: AIConfig, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    log.error(`Anthropic API error ${res.status}: ${body}`);
    throw new Error(`Anthropic API error: ${res.status}`);
  }
  const data = await res.json() as { content: { text: string }[] };
  return data.content[0].text.trim();
}

async function callOpenAI(config: AIConfig, prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'You write concise pull request descriptions.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    log.error(`OpenAI API error ${res.status}: ${body}`);
    throw new Error(`OpenAI API error: ${res.status}`);
  }
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content.trim();
}

async function callGemini(config: AIConfig, prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    log.error(`Gemini API error ${res.status}: ${body}`);
    throw new Error(`Gemini API error: ${res.status}`);
  }
  const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  return data.candidates[0].content.parts[0].text.trim();
}
