#!/usr/bin/env node
/*
 * run_pipeline.js
 *
 * Orchestrate the AI world generator pipeline. This script calls each
 * specialised LLM agent via the local LM Studio API, validates and
 * sanitises the responses, writes them to a build directory and then
 * copies them into the app/data folder for the game to load. Axios is
 * used instead of fetch to avoid undici timeouts.
 */

import fs from 'fs';
import path from 'path';
import process from 'process';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';

const LM_URL = process.env.LM_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const MODEL = process.env.LM_MODEL || 'Qwen2.5-7B-Instruct';

/** Extract the first valid JSON object or array from a string. Removes
 * markdown fences if present and tries to parse progressively. */
function extractFirstJSON(str) {
  if (!str) return null;
  let s = str.trim();
  if (s.startsWith('```')) {
    s = s.slice(s.indexOf('\n') + 1);
    const end = s.lastIndexOf('```');
    if (end >= 0) s = s.slice(0, end);
    s = s.trim();
  }
  try { JSON.parse(s); return s; } catch (_) {}
  const start = Math.min(...['{','['].map(c => { const i=s.indexOf(c); return i<0?Infinity:i; }));
  if (!Number.isFinite(start)) return null;
  let depth = 0;
  let open = s[start];
  let close = open === '{' ? '}' : ']';
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch(_) {}
        }
      }
    }
  }
  return null;
}

/** Perform an HTTP POST request without relying on external libraries. */
async function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'Content-Type': 'application/json' }
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Call the LLM with a system prompt file and user payload. Returns parsed JSON. */
async function callLLM(systemPromptPath, userPayload) {
  const systemContent = fs.readFileSync(systemPromptPath, 'utf8');
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: JSON.stringify(userPayload) }
  ];
  const payload = { model: MODEL, messages, temperature: 0.1 };
  const bodyStr = JSON.stringify(payload);
  const data = await httpPost(LM_URL, bodyStr);
  const content = data.choices?.[0]?.message?.content;
  const jsonStr = extractFirstJSON(content);
  if (!jsonStr) throw new Error('Failed to extract JSON from LLM response');
  return JSON.parse(jsonStr);
}

async function main() {
  const theme = process.argv[2] || process.env.THEME || 'mystic forest';
  // Decode the file URL to a proper file path to handle spaces in folder names
  const __filename = fileURLToPath(import.meta.url);
  const rootDir = path.join(path.dirname(__filename), '..');
  const buildDir = path.join(rootDir, 'build');
  const appDataDir = path.join(rootDir, 'app', 'data');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(appDataDir, { recursive: true });
  console.log(`Generating world for theme: ${theme}`);
  // Architect
  console.log('Architect...');
  const architectInput = { theme, tile_size: 32, palette: 'DB32' };
  const architect = await callLLM(path.join(rootDir, 'prompts', 'architect_system.md'), architectInput);
  fs.writeFileSync(path.join(buildDir, 'architect.json'), JSON.stringify(architect, null, 2));
  // World engineer
  console.log('World engineer...');
  const worldInput = { architect };
  const world = await callLLM(path.join(rootDir, 'prompts', 'engineer_world_system.md'), worldInput);
  fs.writeFileSync(path.join(buildDir, 'world_spec.json'), JSON.stringify(world, null, 2));
  // Art plan engineer
  console.log('Art plan engineer...');
  const artInput = { world };
  const artPlan = await callLLM(path.join(rootDir, 'prompts', 'engineer_art_plan_system.md'), artInput);
  fs.writeFileSync(path.join(buildDir, 'art_plan.json'), JSON.stringify(artPlan, null, 2));
  // Dialogue engineer
  console.log('Dialogue engineer...');
  const dlgInput = { world, interactions: 8 };
  const dialogue = await callLLM(path.join(rootDir, 'prompts', 'engineer_dialogue_system.md'), dlgInput);
  fs.writeFileSync(path.join(buildDir, 'dialogue.json'), JSON.stringify(dialogue, null, 2));
  // Abilities engineer
  console.log('Abilities engineer...');
  const ablInput = { world, total: 10 };
  const abilities = await callLLM(path.join(rootDir, 'prompts', 'engineer_abilities_system.md'), ablInput);
  fs.writeFileSync(path.join(buildDir, 'abilities.json'), JSON.stringify(abilities, null, 2));
  // Status effects engineer
  console.log('Status effects engineer...');
  const statusInput = { world, total: 8 };
  const status = await callLLM(path.join(rootDir, 'prompts', 'engineer_status_system.md'), statusInput);
  fs.writeFileSync(path.join(buildDir, 'status_effects.json'), JSON.stringify(status, null, 2));
  // Inventory engineer
  console.log('Inventory engineer...');
  const invInput = { world, total: 40 };
  const inventory = await callLLM(path.join(rootDir, 'prompts', 'engineer_inventory_system.md'), invInput);
  fs.writeFileSync(path.join(buildDir, 'inventory.json'), JSON.stringify(inventory, null, 2));
  // Events engineer
  console.log('Events engineer...');
  const evtInput = { world, total: 20 };
  const events = await callLLM(path.join(rootDir, 'prompts', 'engineer_events_system.md'), evtInput);
  fs.writeFileSync(path.join(buildDir, 'events.json'), JSON.stringify(events, null, 2));
  // Quests engineer
  console.log('Quests engineer...');
  const qstInput = { architect, world };
  const quests = await callLLM(path.join(rootDir, 'prompts', 'engineer_quests_system.md'), qstInput);
  fs.writeFileSync(path.join(buildDir, 'quests.json'), JSON.stringify(quests, null, 2));
  // Copy build JSON files to app/data
  ['world_spec.json','dialogue.json','abilities.json','status_effects.json','inventory.json','events.json','quests.json'].forEach(f => {
    fs.copyFileSync(path.join(buildDir, f), path.join(appDataDir, f));
  });
  console.log('All files generated and copied to app/data.');
  console.log('You can now run a local server to view the world.');
}

main().catch(err => { console.error(err); process.exit(1); });