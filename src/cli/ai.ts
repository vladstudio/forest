import type { AIConfig } from '../config';
import { log } from '../logger';

const MAX_DIFF_CHARS = 100_000;
const MAX_DIFF_CHARS_COMMIT = 10_000;
const MAX_TOKENS = 4096;

export async function generatePRBody(config: AIConfig, diff: string, title: string): Promise<string> {
  const trimmedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated]'
    : diff;
  const prompt = `Write a pull request description for the following changes. Be concise — keep the total response under 500 words. Use markdown. Start with a short summary paragraph, then a bullet list of key changes if needed. Do not include a title.

PR title: ${title}

Diff:
${trimmedDiff}`;

  log.info(`generatePRBody: provider=${config.provider} model=${config.model} diffLen=${diff.length}`);
  const message = await callProvider(config, prompt);
  log.info(`generatePRBody: result ${message.length} chars`);
  return message;
}

export async function generateCommitMessage(config: AIConfig, diff: string): Promise<string> {
  const trimmed = diff.length > MAX_DIFF_CHARS_COMMIT
    ? diff.slice(0, MAX_DIFF_CHARS_COMMIT) + '\n[diff truncated]'
    : diff;
  const prompt = `Write a concise one-line git commit message (under 72 characters). Use conventional commit format when appropriate (feat:, fix:, chore:, refactor:, etc.). Output only the commit message, nothing else.\n\nDiff:\n${trimmed}`;
  log.info(`generateCommitMessage: provider=${config.provider} diffLen=${diff.length}`);
  return callProvider(config, prompt, 'You write concise one-line git commit messages.');
}

async function callProvider(config: AIConfig, prompt: string, systemPrompt?: string): Promise<string> {
  switch (config.provider) {
    case 'anthropic': return callAnthropic(config, prompt, systemPrompt);
    case 'openai': return callOpenAI(config, prompt, systemPrompt);
    case 'gemini': return callGemini(config, prompt, systemPrompt);
    default: throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}

async function callAnthropic(config: AIConfig, prompt: string, systemPrompt?: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: MAX_TOKENS,
      temperature: 0.3,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    log.error(`Anthropic API error ${res.status}: ${body}`);
    throw new Error(`Anthropic API error: ${res.status}`);
  }
  const data = await res.json() as { content: { text: string }[]; stop_reason?: string };
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Anthropic API returned empty response');
  if (data.stop_reason === 'max_tokens') log.warn('Anthropic response truncated (max_tokens)');
  return text.trim();
}

async function callOpenAI(config: AIConfig, prompt: string, systemPrompt?: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: MAX_TOKENS,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt ?? 'You write concise pull request descriptions.' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    log.error(`OpenAI API error ${res.status}: ${body}`);
    throw new Error(`OpenAI API error: ${res.status}`);
  }
  const data = await res.json() as { choices: { message: { content: string }; finish_reason?: string }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI API returned empty response');
  if (data.choices?.[0]?.finish_reason === 'length') log.warn('OpenAI response truncated (length)');
  return text.trim();
}

async function callGemini(config: AIConfig, prompt: string, systemPrompt?: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify({
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: MAX_TOKENS },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    log.error(`Gemini API error ${res.status}: ${body}`);
    throw new Error(`Gemini API error: ${res.status}`);
  }
  const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini API returned empty response');
  return text.trim();
}
